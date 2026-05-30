#!/bin/bash
# Möbius app-dreaming cron job. Installed by app-store; do not edit by
# hand — edit the Settings tab in the app instead.
#
# Usage: fetch.sh <APP_ID>
#   APP_ID — numeric id of the installed dreaming app (passed by the
#   cron wrapper that the installer registers in init-cron-scaffold.sh).
#
# What it does (nightly):
#   1. Loads the service token from /data/service-token.txt
#   2. Reads agent.json (user's chosen provider: "claude" or "codex")
#   3. Pulls yesterday's signal from Möbius:
#        - GET /api/admin/activity?since=<24h ago> (graceful 404 fallback)
#        - GET /api/chats/?since=<24h ago> + GET /api/chats/<id>
#        - GET own last-7-days reports/*.html (so the dreamer doesn't
#          repeat itself)
#   4. Composes the prompt: system-prompt.md + topics.txt + the three
#      context sections above, then runs the chosen CLI with NO tools.
#      The agent's only output channel is stdout — fetch.sh PUTs the
#      HTML itself so the service token never enters the model context.
#   5. Parses an <article class="dreaming-report" ...> block out of
#      the agent's reply and PUTs it to reports/YYYY-MM-DD.html.
#   6. Updates streak.json based on whether the report had real
#      content (streak resets on the "no activity" path).
#   7. Sends a push notification with the tl;dr.
#   8. Logs to /data/cron-logs/dreaming.log.
#
# Schedule (schedule.json) shape:
#   {"hour": <0-23>, "minute": <0-59>,
#    "timezone": "Europe/London"|null}
#   When `timezone` is set, sync-cron.sh converts local→UTC before
#   writing the crontab entry (handling DST via zoneinfo). When null,
#   hour/minute are interpreted as UTC (backwards-compat).

set -uo pipefail

APP_ID="${1:-}"
if [ -z "$APP_ID" ]; then
  echo "fetch.sh: APP_ID required as first argument" >&2
  exit 2
fi

API_BASE_URL="${API_BASE_URL:-http://localhost:8000}"
SERVICE_TOKEN=$(cat /data/service-token.txt)
TODAY=$(date -u +%Y-%m-%d)
YESTERDAY=$(date -u -d '1 day ago' +%Y-%m-%d 2>/dev/null || date -u -v-1d +%Y-%m-%d)
SINCE_ISO=$(date -u -d '24 hours ago' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
  || date -u -v-24H +%Y-%m-%dT%H:%M:%SZ)
LOG_DIR=/data/cron-logs
LOG_FILE="$LOG_DIR/dreaming.log"
WORK_DIR=$(mktemp -d -t app-dreaming.XXXXXX)
trap 'rm -rf "$WORK_DIR"' EXIT

mkdir -p "$LOG_DIR"

log() {
  echo "[$TODAY $(date -u +%H:%M:%S)] $*" >> "$LOG_FILE"
}

log "Starting nightly dream for app_id=$APP_ID (since=$SINCE_ISO)"

# 1. Pull the baked system prompt + user-editable topics, then compose.
SYSTEM_FILE="$WORK_DIR/system-prompt.md"
SYS_CODE=$(curl -sS -o "$SYSTEM_FILE" -w "%{http_code}" \
  -H "Authorization: Bearer $SERVICE_TOKEN" \
  "$API_BASE_URL/api/storage/apps/$APP_ID/system-prompt.md") || SYS_CODE=000

if [ "$SYS_CODE" != "200" ]; then
  log "ERROR: failed to fetch system-prompt.md (HTTP $SYS_CODE)"
  exit 1
fi

TOPICS_FILE="$WORK_DIR/topics.txt"
TOPICS_CODE=$(curl -sS -o "$TOPICS_FILE" -w "%{http_code}" \
  -H "Authorization: Bearer $SERVICE_TOKEN" \
  "$API_BASE_URL/api/storage/apps/$APP_ID/topics.txt") || TOPICS_CODE=000

if [ "$TOPICS_CODE" != "200" ]; then
  log "ERROR: failed to fetch topics.txt (HTTP $TOPICS_CODE)"
  exit 1
fi

# Pull the user's verbosity setting (terse | standard | chatty).
# Missing/404 → standard. The Settings tab writes this; we inject it
# into the prompt so the dreamer actually respects the user's pick.
VERBOSITY_FILE="$WORK_DIR/verbosity.json"
VERB_CODE=$(curl -sS -o "$VERBOSITY_FILE" -w "%{http_code}" \
  -H "Authorization: Bearer $SERVICE_TOKEN" \
  "$API_BASE_URL/api/storage/apps/$APP_ID/verbosity.json") || VERB_CODE=000

VERBOSITY=$(python3 -c "
import json, sys
try:
    obj = json.load(open('$VERBOSITY_FILE'))
    level = obj.get('level') if isinstance(obj, dict) else None
    print(level if level in ('terse', 'standard', 'chatty') else 'standard')
except Exception:
    print('standard')
" 2>/dev/null)
[ -z "$VERBOSITY" ] && VERBOSITY=standard
log "verbosity=$VERBOSITY (http=$VERB_CODE)"

# 2. Pull yesterday's activity log. The endpoint is service-token-only.
#    A 404 is treated as "feature not yet wired" — we proceed with
#    chat-only signal and an empty activity section.
ACTIVITY_FILE="$WORK_DIR/activity.json"
ACT_CODE=$(curl -sS -o "$ACTIVITY_FILE" -w "%{http_code}" \
  -H "Authorization: Bearer $SERVICE_TOKEN" \
  "$API_BASE_URL/api/admin/activity?since=$SINCE_ISO") || ACT_CODE=000

ACTIVITY_NOTE=""
if [ "$ACT_CODE" = "200" ]; then
  log "Activity log fetched ($(wc -c <"$ACTIVITY_FILE") bytes)"
elif [ "$ACT_CODE" = "404" ]; then
  log "activity log not yet wired; continuing with chat-only signal"
  ACTIVITY_NOTE="(The /api/admin/activity endpoint returned 404 — likely not yet deployed. Proceed using chats only.)"
  printf '[]' > "$ACTIVITY_FILE"
else
  log "WARN: activity log fetch failed (HTTP $ACT_CODE); proceeding without it"
  ACTIVITY_NOTE="(The activity log fetch failed with HTTP $ACT_CODE. Proceed using chats only.)"
  printf '[]' > "$ACTIVITY_FILE"
fi

# 3. Pull recent chats. The list endpoint accepts ?since=<iso>; for
#    each returned chat id we GET /api/chats/<id> to grab a short
#    excerpt of the most recent messages. The python step below also
#    handles older list-endpoint shapes (no ?since support) by
#    filtering client-side on a `updated_at` field when present.
CHATS_LIST="$WORK_DIR/chats-list.json"
CHATS_CODE=$(curl -sS -o "$CHATS_LIST" -w "%{http_code}" \
  -H "Authorization: Bearer $SERVICE_TOKEN" \
  "$API_BASE_URL/api/chats/?since=$SINCE_ISO") || CHATS_CODE=000

if [ "$CHATS_CODE" != "200" ]; then
  log "WARN: chats list fetch failed (HTTP $CHATS_CODE); proceeding without chat signal"
  printf '[]' > "$CHATS_LIST"
fi

CHATS_DIR="$WORK_DIR/chats"
mkdir -p "$CHATS_DIR"

# python3 reads the list, filters to ones updated in the last 24h
# (when a timestamp is available), and emits the ids one per line.
CHAT_IDS=$(python3 - "$CHATS_LIST" "$SINCE_ISO" <<'PY' 2>>"$LOG_FILE"
import json, sys
from datetime import datetime, timezone

list_path, since_iso = sys.argv[1], sys.argv[2]
try:
    with open(list_path, "r", encoding="utf-8") as f:
        data = json.load(f)
except Exception:
    sys.exit(0)

# List endpoint may return either a bare array or {chats: [...]}.
rows = data if isinstance(data, list) else data.get("chats", []) if isinstance(data, dict) else []

since_dt = None
try:
    # Tolerate trailing Z by stripping it; fromisoformat doesn't accept Z.
    since_dt = datetime.fromisoformat(since_iso.replace("Z", "+00:00"))
except Exception:
    since_dt = None

def updated_at(row):
    for k in ("updated_at", "last_message_at", "created_at"):
        v = row.get(k)
        if not v: continue
        try:
            return datetime.fromisoformat(str(v).replace("Z", "+00:00"))
        except Exception:
            continue
    return None

ids = []
for row in rows:
    if not isinstance(row, dict): continue
    cid = row.get("id") or row.get("chat_id")
    if cid is None: continue
    # If server-side filtering already happened, accept everything.
    # Otherwise drop rows we can prove are older than since_dt.
    if since_dt is not None:
        u = updated_at(row)
        if u is not None and u < since_dt:
            continue
    ids.append(str(cid))

# Cap to 20 chats so a chatty day doesn't blow the prompt budget.
for cid in ids[:20]:
    print(cid)
PY
)

CHAT_COUNT=0
for cid in $CHAT_IDS; do
  CHAT_FILE="$CHATS_DIR/$cid.json"
  curl -sS -o "$CHAT_FILE" \
    -H "Authorization: Bearer $SERVICE_TOKEN" \
    "$API_BASE_URL/api/chats/$cid?limit=20" >/dev/null 2>&1 || true
  if [ -s "$CHAT_FILE" ]; then
    CHAT_COUNT=$((CHAT_COUNT + 1))
  fi
done
log "Pulled $CHAT_COUNT chat(s) for context"

# 4. Pull our own last-7-days reports so the dreamer doesn't repeat.
PRIOR_DIR="$WORK_DIR/prior-reports"
mkdir -p "$PRIOR_DIR"
PRIOR_COUNT=0
for offset in 1 2 3 4 5 6 7; do
  D=$(date -u -d "$offset days ago" +%Y-%m-%d 2>/dev/null \
    || date -u -v-${offset}d +%Y-%m-%d)
  CODE=$(curl -sS -o "$PRIOR_DIR/$D.html" -w "%{http_code}" \
    -H "Authorization: Bearer $SERVICE_TOKEN" \
    "$API_BASE_URL/api/storage/apps/$APP_ID/reports/$D.html") || CODE=000
  if [ "$CODE" = "200" ]; then
    PRIOR_COUNT=$((PRIOR_COUNT + 1))
  else
    rm -f "$PRIOR_DIR/$D.html"
  fi
done
log "Pulled $PRIOR_COUNT prior report(s)"

# 5. Compose the final prompt: system + topics + activity + chats + recent.
#    python3 does the heavy lifting: pretty-prints activity, summarises
#    each chat to title + last few messages, and inlines recent report
#    text (HTML tags stripped) under bounded length.
PROMPT_FILE="$WORK_DIR/prompt.md"
python3 - "$SYSTEM_FILE" "$TOPICS_FILE" "$ACTIVITY_FILE" "$CHATS_DIR" \
        "$PRIOR_DIR" "$YESTERDAY" "$ACTIVITY_NOTE" "$PROMPT_FILE" \
        "$VERBOSITY" <<'PY' 2>>"$LOG_FILE"
import json, os, re, sys
from html.parser import HTMLParser

(sys_path, topics_path, activity_path, chats_dir, prior_dir,
 yesterday, activity_note, out_path, verbosity) = sys.argv[1:10]

def read(p):
    try:
        with open(p, "r", encoding="utf-8", errors="replace") as f:
            return f.read()
    except Exception:
        return ""

class TextOnly(HTMLParser):
    def __init__(self):
        super().__init__()
        self.parts = []
    def handle_data(self, d):
        self.parts.append(d)
    def text(self):
        return re.sub(r"\s+", " ", " ".join(self.parts)).strip()

def strip_html(s):
    p = TextOnly()
    try: p.feed(s)
    except Exception: return s
    return p.text()

sys_text = read(sys_path)
topics_text = read(topics_path)

# Activity: pretty-print if it's a JSON list/dict; otherwise inline raw.
activity_raw = read(activity_path)
try:
    activity_obj = json.loads(activity_raw) if activity_raw.strip() else []
    if isinstance(activity_obj, list):
        # Truncate to the most recent 50 events; format as one line each.
        lines = []
        for ev in activity_obj[:50]:
            if not isinstance(ev, dict):
                continue
            ts = ev.get("timestamp") or ev.get("ts") or ev.get("created_at") or "?"
            kind = ev.get("type") or ev.get("event") or ev.get("kind") or "event"
            target = ev.get("target") or ev.get("app") or ev.get("app_id") or ev.get("name") or ""
            extra = ev.get("detail") or ev.get("note") or ""
            line = f"- {ts}  {kind}  {target}"
            if extra: line += f"  ({extra})"
            lines.append(line)
        activity_block = "\n".join(lines) if lines else "(no activity events in window)"
    elif isinstance(activity_obj, dict):
        activity_block = json.dumps(activity_obj, indent=2)[:4000]
    else:
        activity_block = str(activity_obj)[:4000]
except Exception:
    activity_block = activity_raw[:4000] if activity_raw else "(no activity payload)"

if activity_note:
    activity_block = f"{activity_note}\n\n{activity_block}"

# Chats: title + last few messages each, capped.
chat_blocks = []
if os.path.isdir(chats_dir):
    for name in sorted(os.listdir(chats_dir)):
        path = os.path.join(chats_dir, name)
        raw = read(path)
        if not raw.strip(): continue
        try:
            obj = json.loads(raw)
        except Exception:
            continue
        title = obj.get("title") or obj.get("name") or f"chat {obj.get('id', '?')}"
        msgs = obj.get("messages") or obj.get("history") or []
        if not isinstance(msgs, list):
            msgs = []
        # Keep the last 6 messages, each capped to 400 chars.
        tail = msgs[-6:]
        snippets = []
        for m in tail:
            if not isinstance(m, dict): continue
            role = m.get("role") or m.get("author") or "?"
            content = m.get("content") or m.get("text") or m.get("body") or ""
            if isinstance(content, list):
                # Anthropic-style content blocks.
                content = " ".join(
                    (c.get("text", "") if isinstance(c, dict) else str(c))
                    for c in content
                )
            content = str(content).strip().replace("\n", " ")
            if len(content) > 400:
                content = content[:400].rstrip() + "…"
            if content:
                snippets.append(f"  - {role}: {content}")
        block = f"### {title}\n" + ("\n".join(snippets) if snippets else "  (no recent messages)")
        chat_blocks.append(block)

chats_section = "\n\n".join(chat_blocks) if chat_blocks else "(no recent chats)"

# Recent reports: strip HTML to plain text so the dreamer doesn't try
# to copy markup from them. Cap each to ~600 chars; list newest first.
prior_blocks = []
if os.path.isdir(prior_dir):
    for name in sorted(os.listdir(prior_dir), reverse=True):
        path = os.path.join(prior_dir, name)
        text = strip_html(read(path))
        if not text: continue
        if len(text) > 600:
            text = text[:600].rstrip() + "…"
        date_label = name.replace(".html", "")
        prior_blocks.append(f"### {date_label}\n{text}")

prior_section = "\n\n".join(prior_blocks) if prior_blocks else "(no prior dreams in the last 7 days)"

verbosity_guidance = {
    'terse': 'The user picked verbosity=terse. Keep the report under 250 words; prefer crisp single-sentence paragraphs; drop the "today you might want to" section if there is nothing concrete to suggest.',
    'standard': 'The user picked verbosity=standard. Target the ~300-500 word range described in the system prompt.',
    'chatty': 'The user picked verbosity=chatty. Lean toward the upper end of the system prompt\'s 300-500 word range and feel free to add a second observation if the day warranted it; still no wall-of-text.',
}.get(verbosity, 'The user picked verbosity=standard.')

composed = f"""{sys_text}

---

## Verbosity

{verbosity_guidance}

---

## Voice & framing

{topics_text}

---

## Yesterday's activity ({yesterday})

{activity_block}

---

## Yesterday's chats ({yesterday})

{chats_section}

---

## Recent dreams (last 7 days, for continuity — don't repeat yourself)

{prior_section}
"""

with open(out_path, "w", encoding="utf-8") as f:
    f.write(composed)
PY

if [ ! -s "$PROMPT_FILE" ]; then
  log "ERROR: prompt composition failed (no prompt body)"
  exit 1
fi

# 6. Resolve provider + model from agent.json.
#
# agent.json shape (owner-written via the Settings tab):
#   {"provider": "claude"|"codex", "model": "<model-id>"}
#
# Same backwards-compat as app-news: missing file or unknown provider
# falls back to "claude"; missing model means no --model flag (CLI
# default applies).
AGENT_FILE="$WORK_DIR/agent.json"
AGENT_CODE=$(curl -sS -o "$AGENT_FILE" -w "%{http_code}" \
  -H "Authorization: Bearer $SERVICE_TOKEN" \
  "$API_BASE_URL/api/storage/apps/$APP_ID/agent.json") || AGENT_CODE=000
PROVIDER="claude"
MODEL=""
if [ "$AGENT_CODE" = "200" ]; then
  AGENT_PARSED=$(python3 -c "
import json
try:
    obj = json.load(open('$AGENT_FILE'))
    p = obj.get('provider', 'claude')
    if p not in ('claude', 'codex'):
        p = 'claude'
    m = obj.get('model', '')
    if not isinstance(m, str):
        m = ''
    print(p + '\t' + m)
except Exception:
    print('claude\t')
")
  PROVIDER="${AGENT_PARSED%%$'\t'*}"
  MODEL="${AGENT_PARSED#*$'\t'}"
fi
if [ -n "$MODEL" ]; then
  log "Using provider: $PROVIDER, model: $MODEL"
else
  log "Using provider: $PROVIDER (no model override, CLI default)"
fi

# 7. Run the chosen CLI with NO network or disk write tools.
#
# Security model — same posture as app-news:
#   - Token is NOT in the agent's context. fetch.sh holds it and does
#     the PUT itself (step 9).
#   - No --allowedTools list means the agent has only its built-in
#     reasoning — no Bash, no Write, no WebSearch, no WebFetch.
#     There is nothing about yesterday it needs to look up; we packed
#     the entire context into the prompt.
#   - The only output channel is stdout (the final assistant message).
RAW_OUTPUT="$WORK_DIR/agent.out"
REPORT_URL="$API_BASE_URL/api/storage/apps/$APP_ID/reports/$TODAY.html"
USER_TURN="Today is $TODAY. You're writing today's morning dream — a brief reflection on what the user did yesterday ($YESTERDAY) inside Möbius. Read the Voice & framing, Yesterday's activity, Yesterday's chats, and Recent dreams sections above, then output the HTML report and nothing else. Your final reply must start with <article class=\"dreaming-report\" data-date=\"$TODAY\"> and end with </article>. Do not wrap the HTML in markdown fences. Do not add commentary before or after. The HTML body itself IS the response. If the activity sections show no meaningful signal (no new chats, no app opens beyond Dreaming itself), write the night-off variant per the system prompt."

if [ "$PROVIDER" = "claude" ]; then
  if ! command -v claude >/dev/null 2>&1; then
    log "ERROR: provider=claude but claude CLI not installed"
    exit 1
  fi
  log "Invoking claude CLI"
  # No --allowedTools — the agent has no tools at all. The whole
  # context is in the prompt; nothing left to fetch.
  CLAUDE_FLAGS=(
    --system-prompt-file "$PROMPT_FILE"
    --max-turns 4
  )
  if [ -n "$MODEL" ]; then
    CLAUDE_FLAGS+=(--model "$MODEL")
  fi
  CLAUDE_CONFIG_DIR=/data/cli-auth/claude claude -p "$USER_TURN" \
    "${CLAUDE_FLAGS[@]}" \
    > "$RAW_OUTPUT" 2>>"$LOG_FILE"
  CLI_EXIT=$?
else
  if ! command -v codex >/dev/null 2>&1; then
    log "ERROR: provider=codex but codex CLI not installed"
    exit 1
  fi
  log "Invoking codex CLI"
  PROMPT_BODY=$(cat "$PROMPT_FILE")
  # codex exec accepts --model <MODEL> (also -m). Append only when
  # set; otherwise codex uses the default from ~/.codex/config.toml.
  # NOTE: Codex's tool surface is configured in ~/.codex/config.toml
  # at the system level — we can't tighten it per-invocation the way
  # Claude lets us. The token still isn't in the prompt so the worst
  # a poisoned chat snippet could do is execute a shell command under
  # the mobius user with no bearer to exfiltrate. Acceptable until
  # Codex gains per-invocation tool gating.
  CODEX_FLAGS=(exec --json)
  if [ -n "$MODEL" ]; then
    CODEX_FLAGS+=(--model "$MODEL")
  fi
  CODEX_FLAGS+=(-)
  printf '%s\n\n---\n\n%s\n' "$PROMPT_BODY" "$USER_TURN" \
    | codex "${CODEX_FLAGS[@]}" > "$RAW_OUTPUT" 2>>"$LOG_FILE"
  CLI_EXIT=$?
fi

if [ "$CLI_EXIT" -ne 0 ]; then
  log "ERROR: agent exited with code $CLI_EXIT"
fi

# 8. Extract the <article>...</article> block from the agent's output.
#    Same shape as app-news: Claude -p emits the final assistant text
#    verbatim; Codex exec --json emits JSONL whose last agent_message
#    event holds the final text. The python extractor also detects the
#    "night-off" variant so we can reset the streak counter below.
#    Detection prefers the deterministic `data-night-off="true"`
#    attribute on the <article> (per the system prompt). Falls back to
#    a body-text prefix check for older outputs that pre-date the
#    attribute contract.
EXTRACTED_FILE="$WORK_DIR/extracted.html"
SIGNAL_FILE="$WORK_DIR/signal.txt"
python3 - "$RAW_OUTPUT" "$EXTRACTED_FILE" "$PROVIDER" "$SIGNAL_FILE" <<'PY' 2>>"$LOG_FILE"
import json, re, sys

raw_path, out_path, provider, signal_path = sys.argv[1:5]
with open(raw_path, "r", encoding="utf-8", errors="replace") as f:
    raw = f.read()

text = raw
if provider == "codex":
    last = ""
    for line in raw.splitlines():
        line = line.strip()
        if not line: continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue
        msg = obj.get("msg", obj)
        if isinstance(msg, dict) and msg.get("type") == "agent_message":
            m = msg.get("message", "")
            if isinstance(m, str):
                last = m
    if last:
        text = last

match = re.search(
    r'<article\b[^>]*\bclass="dreaming-report"[^>]*>.*?</article>',
    text, re.DOTALL,
)
if not match:
    sys.exit(2)

block = match.group(0)
with open(out_path, "w", encoding="utf-8") as f:
    f.write(block)

# Classify: did the dream find real signal, or is this a night-off?
# Preferred path is the deterministic data-night-off="true" attribute
# on the opening <article> tag — emitted per the system prompt's
# night-off contract. A paraphrase-tolerant model can drift the body
# wording, but the attribute either is or isn't there.
night_off = False
article_open = re.match(r'<article\b[^>]*>', block)
if article_open:
    open_tag = article_open.group(0)
    if re.search(r'\bdata-night-off\s*=\s*"true"', open_tag, re.IGNORECASE):
        night_off = True

# Fallback: old outputs (pre-attribute) signalled night-off by a
# single "No activity today" paragraph. Keep this so a freshly-pulled
# report from an earlier dreamer still resets the streak correctly.
if not night_off:
    body_match = re.search(
        r'<section\b[^>]*\bclass="dreaming-report__body"[^>]*>(.*?)</section>',
        block, re.DOTALL,
    )
    if body_match:
        body_text = re.sub(r"<[^>]+>", " ", body_match.group(1))
        body_text = re.sub(r"\s+", " ", body_text).strip().lower()
        if body_text.startswith("no activity today"):
            night_off = True

with open(signal_path, "w", encoding="utf-8") as f:
    f.write("night-off" if night_off else "active")
PY
EXTRACT_RC=$?

NIGHT_OFF=0
if [ -s "$SIGNAL_FILE" ] && [ "$(cat "$SIGNAL_FILE")" = "night-off" ]; then
  NIGHT_OFF=1
fi

if [ "$EXTRACT_RC" -eq 0 ] && [ -s "$EXTRACTED_FILE" ]; then
  # 9. PUT the extracted HTML ourselves. fetch.sh holds the token —
  #    the agent never saw it.
  PUT_CODE=$(curl -sS -o /dev/null -w "%{http_code}" \
    -X PUT "$REPORT_URL" \
    -H "Authorization: Bearer $SERVICE_TOKEN" \
    -H "Content-Type: text/html; charset=utf-8" \
    --data-binary @"$EXTRACTED_FILE") || PUT_CODE=000

  if [ "$PUT_CODE" = "200" ] || [ "$PUT_CODE" = "201" ] || [ "$PUT_CODE" = "204" ]; then
    log "Dream saved (PUT $TODAY.html: $PUT_CODE, signal=$(cat "$SIGNAL_FILE" 2>/dev/null || echo unknown))"
  else
    log "ERROR: failed to save extracted dream (HTTP $PUT_CODE)"
    EXTRACT_RC=99
  fi
fi

# 10. If extraction failed entirely, write a stub so the date shows
#     up in the UI with an honest "could not be generated" message.
if [ "$EXTRACT_RC" -ne 0 ] || [ ! -s "$EXTRACTED_FILE" ]; then
  log "Agent did not produce a usable dream (extract_rc=$EXTRACT_RC). Writing stub..."
  STUB_FILE="$WORK_DIR/stub.html"
  cat > "$STUB_FILE" <<HTML
<article class="dreaming-report" data-date="$TODAY">
  <details class="dreaming-report__summary" open>
    <summary>Last night's dream</summary>
    <p>Tonight's dream could not be generated. Check <code>/data/cron-logs/dreaming.log</code> for details.</p>
  </details>
  <section class="dreaming-report__body">
    <p>The dreamer did not return a report. The next scheduled run will try again.</p>
  </section>
</article>
HTML
  PUT_CODE=$(curl -sS -o /dev/null -w "%{http_code}" \
    -X PUT "$REPORT_URL" \
    -H "Authorization: Bearer $SERVICE_TOKEN" \
    -H "Content-Type: text/html; charset=utf-8" \
    --data-binary @"$STUB_FILE") || PUT_CODE=000

  if [ "$PUT_CODE" != "200" ] && [ "$PUT_CODE" != "201" ] && [ "$PUT_CODE" != "204" ]; then
    log "ERROR: failed to save stub dream (HTTP $PUT_CODE)"
    exit 1
  fi
  log "Stub saved (HTTP $PUT_CODE)"
  # Stubs don't count toward the streak.
  NIGHT_OFF=1
fi

# 11. Update streak.json.
#     - Active dream → increment if last_active_date was yesterday,
#       reset to 1 otherwise (gap days reset).
#     - Night-off (or stub) → reset to 0, last_active_date untouched
#       so a future active day starts fresh.
STREAK_URL="$API_BASE_URL/api/storage/apps/$APP_ID/streak.json"
STREAK_FILE="$WORK_DIR/streak.json"
NEW_STREAK_FILE="$WORK_DIR/streak.new.json"
curl -sS -o "$STREAK_FILE" \
  -H "Authorization: Bearer $SERVICE_TOKEN" \
  "$STREAK_URL" >/dev/null 2>&1 || true

python3 - "$STREAK_FILE" "$NEW_STREAK_FILE" "$TODAY" "$NIGHT_OFF" <<'PY' 2>>"$LOG_FILE"
import json, sys
from datetime import date, timedelta

path, out_path, today_str, night_off_str = sys.argv[1:5]
night_off = night_off_str == "1"

try:
    with open(path, "r", encoding="utf-8") as f:
        cur = json.load(f)
        if not isinstance(cur, dict):
            cur = {}
except Exception:
    cur = {}

current = int(cur.get("current", 0) or 0)
last = cur.get("last_active_date") or None

if night_off:
    new_obj = {"current": 0, "last_active_date": last}
else:
    today = date.fromisoformat(today_str)
    new_current = 1
    if isinstance(last, str):
        try:
            last_d = date.fromisoformat(last)
            if today - last_d == timedelta(days=1):
                new_current = current + 1
            elif today == last_d:
                # Same-day re-run: keep counter.
                new_current = current if current >= 1 else 1
            else:
                new_current = 1
        except Exception:
            new_current = 1
    new_obj = {"current": new_current, "last_active_date": today_str}

with open(out_path, "w", encoding="utf-8") as f:
    json.dump(new_obj, f)
PY

if [ -s "$NEW_STREAK_FILE" ]; then
  STREAK_PUT=$(curl -sS -o /dev/null -w "%{http_code}" \
    -X PUT "$STREAK_URL" \
    -H "Authorization: Bearer $SERVICE_TOKEN" \
    -H "Content-Type: application/json" \
    --data-binary @"$NEW_STREAK_FILE") || STREAK_PUT=000
  log "Streak update PUT $STREAK_PUT ($(cat "$NEW_STREAK_FILE"))"
fi

# 12. Build the tl;dr for the push notification by stripping HTML
#     from the <details>...<p>...</p>...</details> intro.
TLDR=$(python3 - "$WORK_DIR/extracted.html" <<'PY' 2>>"$LOG_FILE"
import re, sys
try:
    with open(sys.argv[1], "r", encoding="utf-8") as f:
        html = f.read()
except Exception:
    print("")
    sys.exit(0)

m = re.search(
    r'<details\b[^>]*\bclass="dreaming-report__summary"[^>]*>.*?<p\b[^>]*>(.*?)</p>',
    html, re.DOTALL,
)
if not m:
    print("")
    sys.exit(0)

text = re.sub(r"<[^>]+>", " ", m.group(1))
text = re.sub(r"\s+", " ", text).strip()
if len(text) > 200:
    text = text[:200].rstrip() + "…"
print(text)
PY
)

if [ -z "$TLDR" ]; then
  if [ "$NIGHT_OFF" = "1" ]; then
    TLDR="Quiet day yesterday — taking the night off."
  else
    TLDR="Your morning dream for $TODAY is ready."
  fi
fi

# 13. Notify.
NOTIF_BODY=$(python3 -c "
import json, sys
print(json.dumps({
    'title': \"Today's dream is ready\",
    'body': '''$TLDR'''.strip(),
    'source_type': 'app',
    'source_id': '$APP_ID',
    'target': '/app/$APP_ID',
    'actions': [
        {'action': 'open_app', 'title': 'Read', 'target': '/app/$APP_ID'}
    ],
}))
")
curl -sS -X POST "$API_BASE_URL/api/notifications/send" \
  -H "Authorization: Bearer $SERVICE_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$NOTIF_BODY" >> "$LOG_FILE" 2>&1

log "Done."
