/* Dreaming — the nightly morning-brief viewer.
 *
 * Lists the dated reports the dreaming agent leaves overnight, tracks a
 * streak, and lets the owner set the run hour and model. Opening a brief
 * shows TWO things stacked: the brief HTML up top (a sandboxed, script-free
 * iframe — the agent's static page) and, beneath it, the MORNING CHAT the
 * nightly run opened — the conversation about that brief, live, with a real
 * composer and tappable AskUserQuestion cards. The brief is the read; the
 * chat is where the partner steers the next night.
 *
 * Data contract (unchanged, load-bearing):
 *  - List reports:  GET /api/storage/apps-list/{appId}/reports/   (cursor-paged)
 *  - Read a brief:  GET /api/storage/apps/{appId}/reports/<date>.html  (TEXT)
 *  - settings.json / state.json: JSON via the same storage base.
 *  - Reports render in a SANDBOXED srcDoc iframe with NO allow-scripts.
 *
 * Brief↔chat link: the cron creates the morning chat (`POST /api/chats`,
 * title "Morning brief — <date>") and SHOULD write a sibling
 * `reports/<date>.meta.json` = { "chat_id": "<id>" } so the date maps to a
 * chat without guessing. The app reads that meta with its app token; when a
 * chat_id resolves it mounts the real ChatView via `window.mobius.chat({
 * mount, chatId })` (the embed runs in the shell origin with the owner JWT —
 * the only path that can read/post an owner-created chat; the app token alone
 * is 403'd on /api/chats). No chat_id (or no `window.mobius.chat`) → the
 * brief stands alone, gracefully.
 */
import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VERBOSITY_OPTIONS = [
  { id: 'terse', label: 'Terse', hint: 'A short paragraph — just the highlights.' },
  { id: 'standard', label: 'Standard', hint: 'A few paragraphs, a suggestion or two, one closing thought.' },
  { id: 'chatty', label: 'Chatty', hint: 'A longer narrative with more pattern-spotting.' },
]
const DEFAULT_VERBOSITY = 'standard'
const DEFAULT_AGENT_ID = 'builder'
const PROVIDER_LABELS = {
  claude: 'Claude Code',
  codex: 'OpenAI Codex',
}
const PROVIDER_ORDER = [
  { key: 'claude', label: PROVIDER_LABELS.claude },
  { key: 'codex', label: PROVIDER_LABELS.codex },
]
const FALLBACK_MODEL_GROUPS = [
  {
    key: 'claude',
    label: PROVIDER_LABELS.claude,
    models: [
      { id: 'claude-opus-4-8', name: 'Opus 4.8' },
      { id: 'claude-sonnet-4-6', name: 'Sonnet 4.6' },
      { id: 'claude-haiku-4-5-20251001', name: 'Haiku 4.5' },
    ],
  },
  {
    key: 'codex',
    label: PROVIDER_LABELS.codex,
    models: [{ id: 'gpt-5.5', name: 'gpt-5.5' }],
  },
]
const DEFAULT_PROVIDER = FALLBACK_MODEL_GROUPS[0].key
const DEFAULT_MODEL = FALLBACK_MODEL_GROUPS[0].models[0].id

// The default schedule: 06:00 local -> "0 6 * * *". We only ever let the
// user pick an hour (minute pinned to 0), so the cron field is always
// "0 <h> * * *". parseCronHour / buildCron are the single round-trip
// between the picker's hour and that string.
const DEFAULT_HOUR = 6
const DEFAULT_CRON = '0 6 * * *'

// Pull the hour out of a "0 <h> * * *" cron string. Returns null for
// anything that doesn't match the minute-0, single-hour shape this app
// writes — a hand-edited cron (e.g. "30 6 * * *" or "0 6,18 * * *")
// shouldn't be silently coerced to an hour the picker can't represent;
// the caller falls back to the default and the UI notes it can't show
// a custom schedule rather than lying about one.
function parseCronHour(cron) {
  if (typeof cron !== 'string') return null
  const parts = cron.trim().split(/\s+/)
  if (parts.length !== 5) return null
  const [min, hr, dom, mon, dow] = parts
  if (min !== '0' || dom !== '*' || mon !== '*' || dow !== '*') return null
  if (!/^\d{1,2}$/.test(hr)) return null
  const h = Number(hr)
  if (h < 0 || h > 23) return null
  return h
}

function buildCron(hour) {
  return `0 ${hour} * * *`
}

const REPORT_CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'font-src data:',
  "base-uri 'none'",
  "form-action 'none'",
].join('; ')

export function hardenReportHtml(html) {
  const body = typeof html === 'string' ? html : ''
  const meta = `<meta http-equiv="Content-Security-Policy" content="${REPORT_CSP}">`
  if (/<head[\s>]/i.test(body)) return body.replace(/<head([^>]*)>/i, `<head$1>${meta}`)
  if (/<html[\s>]/i.test(body)) return body.replace(/<html([^>]*)>/i, `<html$1><head>${meta}</head>`)
  return `<!doctype html><html><head>${meta}</head><body>${body}</body></html>`
}

// "0 6 * * *" -> "06:00" for the <input type="time"> value.
function hourToTimeValue(hour) {
  return `${String(hour).padStart(2, '0')}:00`
}

// A friendly clock label for the schedule summary — "6:00 AM" in the
// user's locale, so the settings header reads as plain language.
function hourClockLabel(hour) {
  const d = new Date()
  d.setHours(hour, 0, 0, 0)
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

async function fetchAgents(token) {
  const r = await fetch('/api/agents', {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!r.ok) throw new Error(`agents ${r.status}`)
  const data = await r.json()
  return Array.isArray(data.agents) ? data.agents : []
}

function buildModelGroups(payload) {
  if (!payload || typeof payload !== 'object') return FALLBACK_MODEL_GROUPS
  const groups = []
  for (const meta of PROVIDER_ORDER) {
    const rows = Array.isArray(payload[meta.key]) ? payload[meta.key] : null
    if (!rows || rows.length === 0) continue
    groups.push({
      key: meta.key,
      label: meta.label,
      models: rows
        .filter((row) => row && typeof row.id === 'string')
        .map((row) => ({ id: row.id, name: row.name || row.id })),
    })
  }
  return groups
}

async function fetchModelConfig(token) {
  const headers = { Authorization: `Bearer ${token}` }
  const [statusRes, modelsRes] = await Promise.all([
    fetch('/api/auth/providers/status', { headers }).catch(() => null),
    fetch('/api/auth/providers/models', { headers }).catch(() => null),
  ])
  let connected = null
  if (statusRes?.ok) {
    const data = await statusRes.json()
    connected = new Set(
      Object.entries(data || {})
        .filter(([, value]) => value && value.authenticated)
        .map(([key]) => key),
    )
  }
  const models = modelsRes?.ok ? buildModelGroups(await modelsRes.json()) : FALLBACK_MODEL_GROUPS
  return { connected, models }
}

// ---------------------------------------------------------------------------
// Date helpers — report names are <YYYY-MM-DD>.
// ---------------------------------------------------------------------------

function todayLocalDateStr() {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function yesterdayLocalDateStr() {
  const d = new Date()
  d.setDate(d.getDate() - 1)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

// Relative label for a card: "Today" / "Yesterday" / full date.
function relativeLabel(dateStr) {
  if (dateStr === todayLocalDateStr()) return 'Today'
  if (dateStr === yesterdayLocalDateStr()) return 'Yesterday'
  // Anchor at noon so the date doesn't slip a day under a timezone offset.
  const d = new Date(dateStr + 'T12:00:00')
  if (Number.isNaN(d.getTime())) return dateStr
  return d.toLocaleDateString(undefined, {
    weekday: 'long', month: 'long', day: 'numeric',
  })
}

// The smaller line under the relative label — full date for Today/Yesterday,
// and the year for older cards (so a card from a different year isn't
// ambiguous).
function subLabel(dateStr) {
  const d = new Date(dateStr + 'T12:00:00')
  if (Number.isNaN(d.getTime())) return ''
  const rel = relativeLabel(dateStr)
  if (rel === 'Today' || rel === 'Yesterday') {
    return d.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })
  }
  return d.toLocaleDateString(undefined, { year: 'numeric' })
}

// Weekday initial for the card's date glyph — a small calendar-ish tile that
// gives the list a visual rhythm without a heavy date component.
function weekdayInitial(dateStr) {
  const d = new Date(dateStr + 'T12:00:00')
  if (Number.isNaN(d.getTime())) return '·'
  return d.toLocaleDateString(undefined, { weekday: 'short' }).slice(0, 1)
}

function dayOfMonth(dateStr) {
  const d = new Date(dateStr + 'T12:00:00')
  if (Number.isNaN(d.getTime())) return ''
  return String(d.getDate())
}

// ---------------------------------------------------------------------------
// Theme + motion. Structural colors are CSS variables so light + dark both
// work; the dream-violet accent is the one committed hardcode. A handful of
// keyframes (drift, shimmer, rise) feed loading + entrance states so they feel
// alive rather than static.
//
// One module-level `const CSS` is rendered once at the app root as
// <style>{CSS}</style>; the app's class prefix is `dr-`. The shared chrome
// (Root / Header / Sheet / Empty / Card / Button / Input / Segmented /
// ChatEmbed / SyncPill) is fenced with `/* mobius-ui:<Block> v1 … */` markers
// so a future extraction is mechanical; app-specific blocks (aurora, moon
// tile, date tile, streak badge, brief↔chat split, settings) stay below as
// unfenced `dr-` rules and keep their exact current values. The dream-violet
// accent (#7c6cf0 / #a78bfa) is the one committed hardcode the theme can't
// express. Structural colors are theme tokens.
// ---------------------------------------------------------------------------

const ACCENT = '#7c6cf0'        // dreaming's own violet
const ACCENT_2 = '#a78bfa'      // lighter companion for gradients/glows
const ACCENT_DIM = 'rgba(124,108,240,0.13)'
const ACCENT_DIM_2 = 'rgba(167,139,250,0.10)'

const CSS = `
@keyframes dr-drift {
  0%   { transform: translateY(0) rotate(0deg); opacity: .85; }
  50%  { transform: translateY(-6px) rotate(4deg); opacity: 1; }
  100% { transform: translateY(0) rotate(0deg); opacity: .85; }
}
@keyframes dr-rise {
  from { opacity: 0; transform: translateY(8px); }
  to   { opacity: 1; transform: translateY(0); }
}
@keyframes dr-spin {
  to { transform: rotate(360deg); }
}

/* mobius-ui:Root v1 — keep in sync; library candidate. Diverge below the marker only. */
.dr-root {
  position: relative;
  display: flex; flex-direction: column;
  height: 100%; width: 100%; max-width: 100%;
  overflow-x: hidden;
  background: var(--bg); color: var(--text); font-family: var(--font);
  -webkit-font-smoothing: antialiased;
}
.dr-scroll {
  flex: 1; min-height: 0;
  overflow-y: auto; overflow-x: hidden;
  padding: 16px 20px 40px;
  word-break: break-word; overflow-wrap: anywhere;
  position: relative; z-index: 1;
}
/* /mobius-ui:Root */

/* mobius-ui:Header v1 — keep in sync; library candidate. Diverge below the marker only. */
.dr-header {
  flex: 0 0 auto;
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  flex-wrap: wrap;
  padding: 22px 20px 0;
  position: relative; z-index: 1;
}
.dr-brand { display: flex; align-items: center; gap: 11px; min-width: 0; }
.dr-mark {
  flex: 0 0 auto; width: 34px; height: 34px; border-radius: 11px;
  display: flex; align-items: center; justify-content: center;
  background: linear-gradient(135deg, ${ACCENT} 0%, ${ACCENT_2} 100%);
  box-shadow: 0 4px 16px -6px ${ACCENT};
}
.dr-mark-glyph { font-size: 18px; line-height: 1; animation: dr-drift 6s ease-in-out infinite; }
.dr-brand-text { display: flex; flex-direction: column; min-width: 0; line-height: 1.15; }
.dr-title { margin: 0; font-size: 21px; font-weight: 750; letter-spacing: -0.5px; }
.dr-subtitle { font-size: 11.5px; color: var(--muted); font-weight: 500; margin-top: 1px; }
.dr-header-right { display: flex; align-items: center; gap: 9px; flex-wrap: wrap; flex: 0 0 auto; position: relative; z-index: 1; }
/* /mobius-ui:Header */

/* mobius-ui:Empty v1 — keep in sync; library candidate. Diverge below the marker only. */
.dr-empty {
  display: flex; flex-direction: column; align-items: center; text-align: center;
  max-width: 440px; margin: 0 auto; padding: 60px 24px 40px;
  color: var(--muted); font-size: 14px; line-height: 1.65;
}
.dr-empty-mark {
  width: 74px; height: 74px; margin: 0 auto 18px; border-radius: 22px;
  display: flex; align-items: center; justify-content: center;
  background: linear-gradient(160deg, ${ACCENT_DIM} 0%, ${ACCENT_DIM_2} 100%);
  border: 1px solid var(--border);
}
.dr-empty-mark-glyph { font-size: 34px; animation: dr-drift 6s ease-in-out infinite; }
.dr-empty-title { font-size: 17px; font-weight: 700; color: var(--text); letter-spacing: -0.2px; margin-bottom: 8px; }
/* /mobius-ui:Empty */

/* mobius-ui:Card v1 — keep in sync; library candidate. Diverge below the marker only. */
.dr-card {
  display: flex; align-items: stretch; gap: 14px; width: 100%; min-height: 44px;
  padding: 15px 16px; text-align: left;
  background: var(--surface); color: var(--text); font-family: var(--font);
  border: 1px solid var(--border); border-radius: 16px;
  position: relative; overflow: hidden; cursor: pointer;
  transition: border-color .16s ease, transform .12s ease, box-shadow .16s ease, background .16s ease;
}
button.dr-card { cursor: pointer; }
.dr-card:hover { border-color: ${ACCENT}; box-shadow: 0 6px 22px -12px ${ACCENT}; }
.dr-card:active { transform: scale(.992); }
.dr-card:focus-visible { outline: 2px solid ${ACCENT}; outline-offset: 2px; }
.dr-card.is-latest { border-left: 3px solid ${ACCENT}; }
/* /mobius-ui:Card */

/* mobius-ui:Button v1 — keep in sync; library candidate. Diverge below the marker only. */
.dr-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 5px;
  min-height: 44px; padding: 10px 16px; border-radius: 10px;
  border: 1px solid var(--border); background: var(--surface); color: var(--text);
  font-family: var(--font); font-size: 13px; font-weight: 650; cursor: pointer; white-space: nowrap;
  transition: background .14s ease, border-color .14s ease, transform .1s ease, color .14s ease;
}
.dr-btn:active { transform: scale(.97); }
.dr-btn:focus-visible { outline: 2px solid ${ACCENT}; outline-offset: 2px; }
.dr-btn:disabled { opacity: 0.5; cursor: default; transform: none; }
/* /mobius-ui:Button */

/* mobius-ui:Segmented v1 — keep in sync; library candidate. Diverge below the marker only. */
.dr-seg {
  display: flex; gap: 2px; padding: 3px;
  background: var(--surface); border: 1px solid var(--border); border-radius: 10px;
}
.dr-seg-btn {
  min-height: 44px; padding: 6px 15px; border: none; border-radius: 7px;
  background: transparent; color: var(--muted); font-family: var(--font);
  font-size: 13px; font-weight: 650; cursor: pointer; transition: background .15s, color .15s;
}
.dr-seg-btn:hover { color: var(--text); }
.dr-seg-btn.is-active { background: ${ACCENT}; color: #fff; }
/* /mobius-ui:Segmented */

/* mobius-ui:ChatEmbed v1 — keep in sync; library candidate. Diverge below the marker only. */
.dr-chat-embed { width: 100%; flex: 1; min-height: 420px; }
.dr-chat-embed iframe { display: block; width: 100%; height: 100%; border: 0; }
/* /mobius-ui:ChatEmbed */

/* mobius-ui:Spinner v1 — keep in sync; library candidate. */
.dr-spinner {
  width: 26px; height: 26px; border-radius: 50%;
  border: 2.5px solid ${ACCENT_DIM}; border-top-color: ${ACCENT};
  animation: dr-spin 0.8s linear infinite;
}
.dr-spinner-sm { width: 16px; height: 16px; border-width: 2px; }
@media (prefers-reduced-motion: reduce) { .dr-spinner { animation: none; } }
/* /mobius-ui:Spinner */

/* mobius-ui:Scrollskin v1 — keep in sync; library candidate. Add the \`dr-scroll\` class to a scroller. */
.dr-scroll::-webkit-scrollbar { width: 9px; height: 9px; }
.dr-scroll::-webkit-scrollbar-thumb { background: var(--border); border-radius: 99px; border: 2px solid transparent; background-clip: padding-box; }
.dr-scroll::-webkit-scrollbar-thumb:hover { background: var(--muted); background-clip: padding-box; }
/* /mobius-ui:Scrollskin */

/* ---- App-specific (dreaming) — keep exact current values ---- */

/* The detail view reuses the shared empty shape for its missing/error notes,
   but with a tighter top inset than the list's first-run empty. */
.dr-empty.is-compact { padding-top: 56px; }

/* Entrance + press affordances. A handful of dreaming surfaces ride a small
   rise-in on mount; pressable controls get the same active/focus feel as the
   shared card without being one. */
.dr-rise { animation: dr-rise .32s cubic-bezier(.22,.61,.36,1) both; }
.dr-pressable { transition: background .14s ease, border-color .14s ease, transform .1s ease, color .14s ease; }
.dr-pressable:active { transform: scale(.97); }
.dr-pressable:focus-visible { outline: 2px solid ${ACCENT}; outline-offset: 2px; }

/* A faint aurora wash behind the header — pure decoration, pointer-none, so
   the top of the app reads as a sky rather than a flat bar. */
.dr-aurora {
  position: absolute; top: 0; left: 0; right: 0; height: 220px;
  background: radial-gradient(120% 90% at 18% -10%, ${ACCENT_DIM} 0%, transparent 55%), radial-gradient(110% 80% at 92% -20%, ${ACCENT_DIM_2} 0%, transparent 60%);
  pointer-events: none; z-index: 0;
}
.dr-divider { height: 1px; background: var(--border); margin: 16px 20px 0; position: relative; z-index: 1; }

/* Streak badge — header pill + standalone streak bar share the base; the bar
   variant bumps padding + font. */
.dr-streak-badge {
  display: inline-flex; align-items: center; gap: 5px;
  padding: 5px 11px; border-radius: 999px;
  background: ${ACCENT_DIM}; color: ${ACCENT};
  border: 1px solid transparent;
  font-size: 12.5px; font-weight: 650; line-height: 1.2; white-space: nowrap;
}
.dr-streak-badge.is-quiet {
  background: var(--surface); color: var(--muted); border-color: var(--border);
}
.dr-streak-bar { max-width: 660px; margin: 0 auto 16px; display: flex; }
.dr-streak-bar .dr-streak-badge { padding: 7px 13px; font-size: 13px; }
.dr-streak-flame { animation: dr-drift 4s ease-in-out infinite; }
.dr-streak-num { font-weight: 750; }
.dr-streak-unit { font-weight: 550; }
.dr-streak-dots { margin-left: 4px; letter-spacing: 1px; opacity: 0.55; font-size: 9px; }

/* Reports list + dated card */
.dr-list { display: flex; flex-direction: column; gap: 11px; max-width: 660px; margin: 0 auto; }
.dr-date-tile {
  width: 46px; flex-shrink: 0; border-radius: 12px;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 0; align-self: center;
  background: ${ACCENT_DIM}; color: ${ACCENT};
  padding: 8px 0; line-height: 1;
}
.dr-date-tile.is-latest {
  background: linear-gradient(160deg, ${ACCENT} 0%, ${ACCENT_2} 100%); color: #fff;
}
.dr-date-tile-day { font-size: 10px; font-weight: 700; letter-spacing: 0.5px; text-transform: uppercase; opacity: 0.92; }
.dr-date-tile-num { font-size: 19px; font-weight: 750; letter-spacing: -0.5px; }
.dr-card-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; justify-content: center; }
.dr-card-label-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dr-card-label { font-size: 16px; font-weight: 700; letter-spacing: -0.2px; line-height: 1.2; }
.dr-card-sub { font-size: 12px; color: var(--muted); font-weight: 500; }
.dr-card-tldr {
  font-size: 13px; color: var(--muted); line-height: 1.5; margin-top: 5px;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}
.dr-card-chevron { align-self: center; font-size: 20px; color: var(--muted); flex-shrink: 0; line-height: 1; opacity: 0.7; }
.dr-latest-pill {
  font-size: 10px; font-weight: 750; letter-spacing: 0.7px;
  text-transform: uppercase; color: #fff;
  background: ${ACCENT}; padding: 2px 8px; border-radius: 999px;
}

/* Loading / error / offline states */
.dr-loading-wrap { text-align: center; padding: 64px 24px; color: var(--muted); font-size: 13px; }
.dr-loading-wrap .dr-spinner { margin: 0 auto 14px; }
.dr-error-box {
  max-width: 660px; margin: 0 auto; padding: 16px; border-radius: 14px;
  border: 1px solid var(--border); background: var(--surface);
  color: var(--text); font-size: 13px; line-height: 1.55;
  display: flex; flex-direction: column; gap: 10px;
}
.dr-retry-btn {
  align-self: flex-start; padding: 7px 14px; border-radius: 9px;
  border: 1px solid ${ACCENT}; background: transparent; color: ${ACCENT};
  font-size: 12.5px; font-weight: 650; cursor: pointer; font-family: var(--font);
}
.dr-offline-banner {
  max-width: 660px; margin: 0 auto 14px; padding: 10px 14px;
  border-radius: 12px; background: ${ACCENT_DIM}; border: 1px solid var(--border);
  color: var(--text); font-size: 12.5px; line-height: 1.45;
  display: flex; align-items: center; gap: 8px;
}

/* Report detail — brief + chat split view */
.dr-detail {
  position: absolute; inset: 0; display: flex; flex-direction: column;
  background: var(--bg); z-index: 5;
}
.dr-detail-bar {
  display: flex; align-items: center; gap: 12px;
  padding: 11px 14px; border-bottom: 1px solid var(--border);
  flex-shrink: 0; background: var(--surface);
}
.dr-back-btn {
  display: inline-flex; align-items: center; gap: 5px;
  padding: 7px 13px 7px 9px; border-radius: 10px;
  border: 1px solid var(--border); background: var(--bg);
  color: var(--text); font-size: 13px; font-weight: 650;
  cursor: pointer; font-family: var(--font); flex-shrink: 0;
}
.dr-back-glyph { font-size: 16px; }
.dr-detail-title { display: flex; flex-direction: column; min-width: 0; line-height: 1.25; flex: 1; }
.dr-detail-title-main { font-size: 15px; font-weight: 700; letter-spacing: -0.2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dr-detail-title-sub { font-size: 11.5px; color: var(--muted); font-weight: 500; }
.dr-split-body {
  flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden;
  display: flex; flex-direction: column;
}
.dr-brief-panel {
  flex-shrink: 0; display: flex; flex-direction: column;
  border-bottom: 1px solid var(--border);
}
.dr-brief-iframe { width: 100%; border: none; background: var(--bg); display: block; }
.dr-brief-loading {
  min-height: 320px; display: flex; flex-direction: column;
  align-items: center; justify-content: center; gap: 12px;
  color: var(--muted); font-size: 13px;
}
.dr-chat-mount-wrap { position: relative; }
.dr-chat-panel { flex-shrink: 0; display: flex; flex-direction: column; background: var(--bg); }
.dr-chat-header { display: flex; align-items: center; gap: 8px; padding: 13px 16px 9px; flex-shrink: 0; }
.dr-chat-header-dot {
  width: 7px; height: 7px; border-radius: 50%; background: ${ACCENT};
  box-shadow: 0 0 0 4px ${ACCENT_DIM}; flex-shrink: 0;
}
.dr-chat-header-text { font-size: 13px; font-weight: 700; letter-spacing: -0.1px; }
.dr-chat-header-hint { font-size: 11.5px; color: var(--muted); font-weight: 500; margin-left: auto; }
.dr-chat-resolving {
  padding: 20px 16px 28px; display: flex; align-items: center; gap: 10px;
  color: var(--muted); font-size: 12.5px;
}
.dr-no-chat-note {
  margin: 14px 16px 22px; padding: 14px 16px; border-radius: 13px;
  background: var(--surface); border: 1px dashed var(--border);
  color: var(--muted); font-size: 12.5px; line-height: 1.55;
  display: flex; align-items: flex-start; gap: 10px;
}
.dr-no-chat-glyph { font-size: 15px; line-height: 1.2; }
.dr-feedback-row { margin: 12px 16px 18px; padding-top: 12px; border-top: 1px solid var(--border); }
.dr-feedback-btn {
  display: inline-flex; align-items: center; justify-content: center;
  min-height: 40px; padding: 8px 14px; border-radius: 10px;
  border: 1px solid ${ACCENT}; background: ${ACCENT_DIM};
  color: ${ACCENT}; font-size: 13px; font-weight: 700;
  cursor: pointer; font-family: var(--font);
}

/* Settings */
.dr-settings-wrap { max-width: 580px; margin: 0 auto; display: flex; flex-direction: column; gap: 22px; }
.dr-settings-card {
  background: var(--surface); border: 1px solid var(--border);
  border-radius: 16px; padding: 18px; display: flex; flex-direction: column; gap: 10px;
}
.dr-section-head { display: flex; align-items: center; gap: 10px; }
.dr-section-icon {
  width: 30px; height: 30px; border-radius: 9px; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  background: ${ACCENT_DIM}; font-size: 15px;
}
.dr-section-label { font-size: 14.5px; font-weight: 700; letter-spacing: -0.1px; margin: 0; }
.dr-note { font-size: 12.5px; color: var(--muted); margin: 0; line-height: 1.55; }
.dr-note-strong { color: var(--text); font-weight: 650; }
.dr-time-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-top: 2px; }
.dr-time-input {
  padding: 9px 12px; font-size: 16px; font-family: var(--font); font-weight: 600;
  background: var(--bg); color: var(--text);
  border: 1px solid var(--border); border-radius: 10px;
  outline: none; width: 132px;
}
.dr-custom-cron-note {
  font-size: 12px; color: var(--muted); line-height: 1.5;
  padding: 10px 12px; border-radius: 11px;
  background: var(--bg); border: 1px solid var(--border); margin-top: 2px;
}
.dr-custom-cron-note .dr-time-row { margin-top: 10px; }
.dr-agent-select {
  width: 100%; min-height: 42px; padding: 9px 12px;
  border: 1px solid var(--border); border-radius: 10px;
  background: var(--bg); color: var(--text); font-size: 14px;
  font-family: var(--font); font-weight: 650; outline: none;
}
.dr-agent-meta {
  font-size: 12px; color: var(--muted); line-height: 1.5;
  padding: 10px 12px; border-radius: 11px;
  background: var(--bg); border: 1px solid var(--border);
}
.dr-model-label {
  font-size: 11px; color: var(--muted); font-weight: 750;
  text-transform: uppercase; letter-spacing: 0.4px; margin-top: 4px;
}
.dr-save-row { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-top: 2px; }
.dr-save-btn {
  padding: 10px 22px; border-radius: 12px; border: none;
  background: ${ACCENT}; color: #fff;
  font-size: 13.5px; font-weight: 700; cursor: pointer;
  font-family: var(--font); transition: background 0.15s, opacity .15s;
  box-shadow: 0 6px 18px -8px ${ACCENT};
}
.dr-save-btn:disabled {
  background: var(--surface); color: var(--muted); cursor: default; box-shadow: none;
}
.dr-toast { font-size: 12.5px; color: var(--green, #3fb950); font-weight: 650; }
.dr-error-toast { font-size: 12.5px; color: var(--danger, #f85149); font-weight: 650; }
.dr-schedule-hint {
  font-size: 12px; color: var(--muted); line-height: 1.55;
  padding: 11px 13px; border-radius: 12px;
  background: ${ACCENT_DIM}; border: 1px solid var(--border);
  display: flex; align-items: flex-start; gap: 8px;
}

@media (prefers-reduced-motion: reduce) {
  .dr-rise, .dr-mark-glyph, .dr-empty-mark-glyph, .dr-streak-flame { animation: none !important; }
}
`


// ---------------------------------------------------------------------------
// Storage — raw fetch with the app token (per the data contract). JSON paths
// parse JSON; report bodies are read as text. A real 404 (storage empty on
// first run) is normal and returns the `notFound` shape so callers can tell
// it apart from a network failure (`error`) and treat each correctly.
// ---------------------------------------------------------------------------

function makeStorage(appId, token) {
  const ms = (typeof window !== 'undefined' && window.mobius && window.mobius.storage) || null
  const headers = { Authorization: `Bearer ${token}` }
  const base = `/api/storage/apps/${appId}`
  const listBase = `/api/storage/apps-list/${appId}`

  async function getJSON(path) {
    try {
      if (ms && typeof ms.get === 'function') {
        const data = await ms.get(path)
        return data == null ? { notFound: true } : { data }
      }
      const r = await fetch(`${base}/${path}`, { headers })
      if (r.status === 404) return { notFound: true }
      if (!r.ok) return { error: r.status }
      return { data: await r.json() }
    } catch {
      return { error: 0 }
    }
  }

  async function putJSON(path, obj) {
    if (ms && typeof ms.set === 'function') {
      await ms.set(path, obj)
      return true
    }
    const r = await fetch(`${base}/${path}`, {
      method: 'PUT',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(obj),
    })
    if (!r.ok) throw new Error(`PUT ${path} failed (${r.status})`)
    return true
  }

  async function getReportHtml(name) {
    // Report bodies are raw HTML documents — read as text, not JSON.
    try {
      const r = await fetch(`${base}/reports/${name}`, { headers })
      if (r.status === 404) return { notFound: true }
      if (!r.ok) return { error: r.status }
      return { data: await r.text() }
    } catch {
      return { error: 0 }
    }
  }

  // Resolve the morning chat for a report date. The cron SHOULD write a
  // sibling `reports/<date>.meta.json` = { "chat_id": "<id>" } when it opens
  // the morning chat; this reads it (with the app token, same as every other
  // read). Returns the chat_id string, or null when there's no meta yet (the
  // brief then stands alone). A network error is swallowed to null too — the
  // brief is still readable; the chat just doesn't mount this open.
  async function getReportChatId(dateStr) {
    try {
      const r = await fetch(`${base}/reports/${dateStr}.meta.json`, { headers })
      if (!r.ok) return null
      const data = await r.json()
      const id = data && (data.chat_id ?? data.chatId ?? data.morning_chat)
      return typeof id === 'string' && id.trim() ? id.trim() : null
    } catch {
      return null
    }
  }

  // Enumerate reports via the listing endpoint (newest-first), walking the
  // cursor. A non-advancing cursor is treated as a server fault rather than
  // spinning forever. Returns { dates: [...] } on success, or { error } /
  // { notFound } so the caller can distinguish "no reports yet" from "the
  // listing call failed" and keep its cached snapshot in the latter case.
  async function listReportDates() {
    const out = []
    let cursor = null
    try {
      for (let guard = 0; guard < 50; guard++) {
        const url = `${listBase}/reports/`
          + (cursor ? `?cursor=${encodeURIComponent(cursor)}` : '')
        const r = await fetch(url, { headers })
        if (r.status === 404) return { dates: [] } // dir not created yet = empty
        if (!r.ok) return { error: r.status }
        const data = await r.json()
        for (const e of data.entries || []) {
          if (e.type === 'file' && typeof e.name === 'string' && e.name.endsWith('.html')) {
            out.push(e.name.slice(0, -'.html'.length))
          }
        }
        const prev = cursor
        cursor = data.next_cursor
        if (!cursor) break
        if (cursor === prev) return { error: -1 } // server returned same page
      }
    } catch {
      return { error: 0 }
    }
    // ISO date names sort lexicographically = chronologically; newest first.
    out.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
    return { dates: out }
  }

  return { getJSON, putJSON, getReportHtml, getReportChatId, listReportDates }
}

// ---------------------------------------------------------------------------
// Tiny offline snapshot. Dreaming reads via direct fetch (text bodies +
// apps-list), neither of which the platform read-cache covers, so we keep our
// own localStorage snapshot: the dates list, the streak, and the latest
// summary. This is read-only mirror state — only the cron writes reports, so
// the snapshot just paints the same thing the user saw before they lost
// connectivity. Bodies aren't cached here (the report iframe re-fetches; if
// offline it shows a graceful error), only the cheap list metadata.
// ---------------------------------------------------------------------------

const CACHE_VERSION = 1
function cacheKey(appId) { return `dreaming:${appId}:list:v${CACHE_VERSION}` }

function readCache(appId) {
  try {
    const raw = localStorage.getItem(cacheKey(appId))
    if (!raw) return null
    const p = JSON.parse(raw)
    if (!p || typeof p !== 'object') return null
    return {
      dates: Array.isArray(p.dates) ? p.dates.filter((d) => typeof d === 'string') : [],
      streak: Number.isFinite(p.streak) ? p.streak : 0,
      lastSummary: typeof p.lastSummary === 'string' ? p.lastSummary : '',
      lastRun: typeof p.lastRun === 'string' ? p.lastRun : '',
    }
  } catch {
    return null
  }
}

function writeCache(appId, snap) {
  try {
    localStorage.setItem(cacheKey(appId), JSON.stringify(snap))
  } catch {
    // Quota / private-mode Safari: skip silently. In-memory state still works.
  }
}

// ---------------------------------------------------------------------------
// Online/offline hook — runtime signal if present, else navigator.onLine.
// ---------------------------------------------------------------------------

function useOnline() {
  const initial = (() => {
    if (typeof window === 'undefined') return true
    if (typeof window.mobius?.online === 'boolean') return window.mobius.online
    return navigator.onLine !== false
  })()
  const [online, setOnline] = useState(initial)
  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    const up = () => setOnline(true)
    const down = () => setOnline(false)
    window.addEventListener('online', up)
    window.addEventListener('offline', down)
    let unsub = null
    if (window.mobius && typeof window.mobius.onChange === 'function') {
      unsub = window.mobius.onChange((s) => {
        if (typeof s?.online === 'boolean') setOnline(s.online)
      })
    }
    return () => {
      window.removeEventListener('online', up)
      window.removeEventListener('offline', down)
      if (unsub) unsub()
    }
  }, [])
  return online
}

// ---------------------------------------------------------------------------
// Morning chat embed. `window.mobius.chat({ mount, chatId })` mounts the real
// ChatView (composer + live SSE + tappable AskUserQuestion cards) inside a
// nested same-origin iframe that runs in the SHELL origin — so it carries the
// owner JWT and can read/post the owner-created morning chat the cron opened.
// (The app token alone is 403'd on /api/chats; this is the supported path.)
//
// We MUST pass an existing chatId. The runtime can lazy-create a chat when
// none is given, but that would make a brand-new empty chat, not find the
// morning one — so a null chatId here renders nothing (the caller shows its
// own "no chat" note). The handle is torn down on unmount / date change so we
// never leak the nested iframe.
// ---------------------------------------------------------------------------

function MorningChat({ chatId }) {
  const mountRef = useRef(null)
  const [phase, setPhase] = useState('mounting') // mounting | live | unavailable

  useEffect(() => {
    const mount = mountRef.current
    if (!mount || !chatId) { setPhase('unavailable'); return undefined }
    if (!window.mobius || typeof window.mobius.chat !== 'function') {
      // Running outside the shell embed (e.g. standalone) — no chat bridge.
      setPhase('unavailable')
      return undefined
    }
    let handle = null
    let cancelled = false
    setPhase('mounting')
    Promise.resolve(window.mobius.chat({ mount, chatId }))
      .then((h) => {
        if (cancelled) { try { h && h.destroy && h.destroy() } catch {} return }
        handle = h
        setPhase('live')
      })
      .catch(() => { if (!cancelled) setPhase('unavailable') })
    return () => {
      cancelled = true
      try { handle && handle.destroy && handle.destroy() } catch {}
      // Belt-and-suspenders: the runtime appends one iframe to `mount`; clear
      // any leftover node so a fast date switch can't stack two embeds.
      if (mount) { try { mount.replaceChildren() } catch {} }
    }
  }, [chatId])

  if (phase === 'unavailable') {
    return (
      <div className="dr-no-chat-note">
        <span aria-hidden="true" className="dr-no-chat-glyph">💬</span>
        <span>
          The conversation about this brief isn’t available here. Open it from
          your chat list to reply.
        </span>
      </div>
    )
  }

  return (
    <div className="dr-chat-mount-wrap">
      {phase === 'mounting' && (
        <div className="dr-chat-resolving">
          <span className="dr-spinner dr-spinner-sm" aria-hidden="true" />
          Opening the conversation…
        </div>
      )}
      <div ref={mountRef} className="dr-chat-embed" style={{ display: phase === 'live' ? 'block' : 'none' }} />
    </div>
  )
}

function FeedbackLauncher({ dateStr, chatId }) {
  const openFeedbackChat = () => {
    const draft = [
      `Feedback on the Dreaming brief for ${dateStr}:`,
      '',
      'My feedback:',
    ].join('\n')
    window.parent.postMessage(
      chatId
        ? { type: 'moebius:open-chat', chatId, draft }
        : { type: 'moebius:new-chat', draft },
      window.location.origin,
    )
  }
  return (
    <div className="dr-feedback-row">
      <button className="dr-feedback-btn dr-pressable" onClick={openFeedbackChat}>
        Give feedback on this brief
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Report detail — the brief + chat split view.
//
// The brief is the static, script-free HTML the agent authored: rendered in a
// SANDBOXED srcDoc iframe with NO allow-scripts (containment). Beneath it, the
// morning chat. We resolve the chat_id from `reports/<date>.meta.json` (the
// cron's sibling), then mount the embed. Back is wired through the shell
// nav helper so the phone's back gesture returns to the list with a real
// previous-screen preview.
//
// The brief iframe auto-sizes to its content (the document is short — a
// morning read), measured via the iframe's own scrollHeight after load, so
// the page scrolls as one column (brief, then chat) instead of nesting two
// scroll regions. Same-origin sandbox lets us read contentDocument for that
// measurement; no scripts run inside.
// ---------------------------------------------------------------------------

function ReportDetail({ dateStr, storage, online, onBack }) {
  const [state, setState] = useState({ phase: 'loading', html: '' })
  const [chatId, setChatId] = useState(undefined) // undefined=resolving, null=none, string=id
  const [briefHeight, setBriefHeight] = useState(360)
  const iframeRef = useRef(null)

  // Load the brief body + resolve its chat in parallel.
  useEffect(() => {
    let cancelled = false
    setState({ phase: 'loading', html: '' })
    setChatId(undefined)
    setBriefHeight(360)
    ;(async () => {
      const res = await storage.getReportHtml(`${dateStr}.html`)
      if (cancelled) return
      if (res.data != null) setState({ phase: 'ready', html: hardenReportHtml(res.data) })
      else if (res.notFound) setState({ phase: 'missing', html: '' })
      else setState({ phase: 'error', html: '' })
    })()
    ;(async () => {
      const id = await storage.getReportChatId(dateStr)
      if (!cancelled) setChatId(id)
    })()
    return () => { cancelled = true }
  }, [dateStr, storage])

  // Size the brief iframe to its content so the column scrolls as one. The
  // sandbox is same-origin (no scripts), so contentDocument is readable. We
  // re-measure on a ResizeObserver of the inner body for late layout (web
  // fonts, images) and clamp to a sane range.
  const measure = useCallback(() => {
    const el = iframeRef.current
    if (!el) return
    try {
      const doc = el.contentDocument
      if (!doc || !doc.body) return
      const h = Math.max(doc.body.scrollHeight, doc.documentElement.scrollHeight)
      if (h > 0) setBriefHeight(Math.min(Math.max(h, 200), 100000))
    } catch {
      // Cross-origin guard (shouldn't happen with allow-same-origin) — leave
      // the default height; the inner doc keeps its own scroll as a fallback.
    }
  }, [])

  const onIframeLoad = useCallback(() => {
    measure()
    try {
      const doc = iframeRef.current?.contentDocument
      if (doc && doc.body && typeof ResizeObserver !== 'undefined') {
        const ro = new ResizeObserver(() => measure())
        ro.observe(doc.body)
        // Stash so we can disconnect on unmount via the iframe element.
        iframeRef.current.__ro = ro
      }
    } catch {}
  }, [measure])

  useEffect(() => () => {
    try { iframeRef.current?.__ro?.disconnect() } catch {}
  }, [])

  return (
    <div className="dr-detail dr-rise">
      <div className="dr-detail-bar">
        <button
          className="dr-back-btn dr-pressable"
          onClick={onBack} aria-label="Back to reports"
        >
          <span aria-hidden="true" className="dr-back-glyph">‹</span> Briefs
        </button>
        <div className="dr-detail-title">
          <span className="dr-detail-title-main">{relativeLabel(dateStr)}’s brief</span>
          <span className="dr-detail-title-sub">{subLabel(dateStr)}</span>
        </div>
      </div>

      {state.phase === 'loading' && (
        <div className="dr-brief-loading">
          <span className="dr-spinner" aria-hidden="true" />
          <span>Opening your brief…</span>
        </div>
      )}

      {state.phase === 'missing' && (
        <div className="dr-empty is-compact">
          This brief is no longer available.
        </div>
      )}

      {state.phase === 'error' && (
        <div className="dr-empty is-compact">
          {online
            ? 'This brief could not be loaded. Try opening it again in a moment.'
            : 'You’re offline — open this brief again once you’re back online.'}
        </div>
      )}

      {state.phase === 'ready' && (
        <div className="dr-split-body dr-scroll">
          <div className="dr-brief-panel">
            <iframe
              ref={iframeRef}
              className="dr-brief-iframe"
              style={{ height: `${briefHeight}px` }}
              title={`Morning brief for ${dateStr}`}
              srcDoc={state.html}
              onLoad={onIframeLoad}
              // The report is static HTML/CSS authored by the agent. sandbox
              // WITHOUT allow-scripts is the containment: same-origin so its
              // own <style> + relative anchors resolve (and we can measure its
              // height), but no script execution.
              sandbox="allow-same-origin"
            />
          </div>

          <div className="dr-chat-panel">
            <div className="dr-chat-header">
              <span className="dr-chat-header-dot" aria-hidden="true" />
              <span className="dr-chat-header-text">Morning conversation</span>
              {chatId && <span className="dr-chat-header-hint">tap a card or reply below</span>}
            </div>
            {chatId === undefined ? (
              <div className="dr-chat-resolving">
                <span className="dr-spinner dr-spinner-sm" aria-hidden="true" />
                Finding the conversation…
              </div>
            ) : chatId === null ? (
              <div className="dr-no-chat-note">
                <span aria-hidden="true" className="dr-no-chat-glyph">🌙</span>
                <span>
                  No conversation was opened for this brief — it’s a read-only
                  morning note. When a brief has questions for you, the chat
                  appears here so you can answer with a tap.
                </span>
              </div>
            ) : (
              <MorningChat chatId={chatId} />
            )}
            <FeedbackLauncher dateStr={dateStr} chatId={chatId} />
          </div>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Reports list
// ---------------------------------------------------------------------------

function ReportsList({ appId, storage, online, onOpen }) {
  const cached = useMemo(() => readCache(appId), [appId])
  const [dates, setDates] = useState(cached?.dates || [])
  const [streak, setStreak] = useState(cached?.streak || 0)
  const [lastSummary, setLastSummary] = useState(cached?.lastSummary || '')
  const [phase, setPhase] = useState('loading') // loading | ready | error
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setPhase((p) => (dates.length ? p : 'loading'))
      const [listRes, stateRes] = await Promise.all([
        storage.listReportDates(),
        storage.getJSON('state.json'),
      ])
      if (cancelled) return

      // state.json: 404 is normal (cron hasn't written it) -> streak 0.
      let nextStreak = 0
      let nextSummary = ''
      let nextLastRun = ''
      if (stateRes.data && typeof stateRes.data === 'object') {
        nextStreak = Number.isFinite(stateRes.data.streak) ? stateRes.data.streak : 0
        nextSummary = typeof stateRes.data.last_summary === 'string' ? stateRes.data.last_summary : ''
        nextLastRun = typeof stateRes.data.last_run === 'string' ? stateRes.data.last_run : ''
      } else if (stateRes.error != null && cached) {
        // Couldn't reach state.json (offline) — keep the cached header.
        nextStreak = cached.streak
        nextSummary = cached.lastSummary
      }
      setStreak(nextStreak)
      setLastSummary(nextSummary)

      if (listRes.dates) {
        // Listing succeeded (even if empty []): trust the server.
        setDates(listRes.dates)
        setPhase('ready')
        writeCache(appId, {
          dates: listRes.dates, streak: nextStreak,
          lastSummary: nextSummary, lastRun: nextLastRun,
        })
      } else if (cached && cached.dates.length) {
        // Listing failed but we have a cached snapshot — show it.
        setDates(cached.dates)
        setPhase('ready')
      } else {
        // Listing failed and nothing cached — surface a retryable error.
        setPhase('error')
      }
    })()
    return () => { cancelled = true }
    // reloadKey forces a manual retry; dates intentionally excluded so a
    // state update inside the effect doesn't re-trigger it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appId, storage, reloadKey])

  if (phase === 'loading' && dates.length === 0) {
    return (
      <div className="dr-loading-wrap">
        <span className="dr-spinner" aria-hidden="true" />
        <div>Gathering last night’s dream…</div>
      </div>
    )
  }

  if (phase === 'error' && dates.length === 0) {
    return (
      <div className="dr-error-box">
        <span>
          {online
            ? 'Couldn’t load your briefs just now.'
            : 'You’re offline and there’s nothing cached yet.'}
        </span>
        {online && (
          <button className="dr-retry-btn dr-pressable" onClick={() => setReloadKey((k) => k + 1)}>
            Try again
          </button>
        )}
      </div>
    )
  }

  if (dates.length === 0) {
    return (
      <div className="dr-empty">
        <div className="dr-empty-mark">
          <span className="dr-empty-mark-glyph" aria-hidden="true">🌙</span>
        </div>
        <div className="dr-empty-title">No briefs yet</div>
        Dreaming runs overnight — consolidating what the day’s agents learned,
        tidying your Mind, and tending your apps. Your first morning brief will
        be waiting right here.
      </div>
    )
  }

  return (
    <div className="dr-rise">
      <StreakBar streak={streak} />
      {!online && (
        <div className="dr-offline-banner">
          <span aria-hidden="true">🌙</span>
          Offline — showing your last cached briefs. Tonight’s dream appears
          once you’re back online.
        </div>
      )}
      <div className="dr-list">
        {dates.map((d, i) => (
          <button
            key={d}
            className={`dr-card${i === 0 ? ' is-latest' : ''}`}
            onClick={() => onOpen(d)}
          >
            <div className={`dr-date-tile${i === 0 ? ' is-latest' : ''}`} aria-hidden="true">
              <span className="dr-date-tile-day">{weekdayInitial(d)}</span>
              <span className="dr-date-tile-num">{dayOfMonth(d)}</span>
            </div>
            <div className="dr-card-main">
              <div className="dr-card-label-row">
                <span className="dr-card-label">{relativeLabel(d)}</span>
                {i === 0 && <span className="dr-latest-pill">Latest</span>}
              </div>
              <span className="dr-card-sub">{subLabel(d)}</span>
              {i === 0 && lastSummary && (
                <span className="dr-card-tldr">{lastSummary}</span>
              )}
            </div>
            <span className="dr-card-chevron" aria-hidden="true">›</span>
          </button>
        ))}
      </div>
    </div>
  )
}

function StreakBar({ streak }) {
  if (!streak || streak < 1) return null
  const flames = Math.min(streak, 5)
  return (
    <div className="dr-streak-bar">
      <span className="dr-streak-badge">
        <span aria-hidden="true" className="dr-streak-flame">🔥</span>
        <strong className="dr-streak-num">{streak}</strong>
        <span className="dr-streak-unit">
          {streak === 1 ? 'morning in a row' : 'mornings in a row'}
        </span>
        <span aria-hidden="true" className="dr-streak-dots">
          {'•'.repeat(flames)}
        </span>
      </span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function SettingsTab({ appId, storage, online, token }) {
  const [hour, setHour] = useState(DEFAULT_HOUR)
  const [excludeApps, setExcludeApps] = useState([])
  const [settingsExtra, setSettingsExtra] = useState({})
  const [agents, setAgents] = useState([])
  const [agentId, setAgentId] = useState(DEFAULT_AGENT_ID)
  const [agentsPhase, setAgentsPhase] = useState('loading')
  const [provider, setProvider] = useState(DEFAULT_PROVIDER)
  const [model, setModel] = useState(DEFAULT_MODEL)
  const [modelGroups, setModelGroups] = useState(null)
  const [connectedProviders, setConnectedProviders] = useState(null)
  // The raw cron we loaded — when it's a custom shape parseCronHour can't
  // represent (a non-zero minute, multiple hours), we surface it read-only
  // rather than silently rewriting it to "0 <h> * * *" on the next save.
  const [rawCron, setRawCron] = useState(DEFAULT_CRON)
  const [cronIsCustom, setCronIsCustom] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [toast, setToast] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const res = await storage.getJSON('settings.json')
      if (cancelled) return
      const s = res.data && typeof res.data === 'object' ? res.data : null
      if (s) {
        setSettingsExtra(s)
        const parsedHour = parseCronHour(s.cron)
        if (parsedHour != null) {
          setHour(parsedHour)
          setCronIsCustom(false)
        } else if (typeof s.cron === 'string' && s.cron.trim()) {
          // Hand-edited / multi-hour cron — keep it, show it read-only.
          setRawCron(s.cron)
          setCronIsCustom(true)
        } else if (Number.isFinite(s.hour) && s.hour >= 0 && s.hour <= 23) {
          // Legacy seed shape used hour/minute/timezone. Preserve it as a
          // readable default, then save in the cron shape the runner expects.
          setHour(s.hour)
          setCronIsCustom(false)
        }
        if (Array.isArray(s.exclude_apps)) setExcludeApps(s.exclude_apps)
        if (typeof s.agent_id === 'string' && s.agent_id.trim()) {
          setAgentId(s.agent_id.trim())
        }
        if (typeof s.provider === 'string' && s.provider.trim()) {
          setProvider(s.provider.trim())
        }
        if (typeof s.model === 'string' && s.model.trim()) {
          setModel(s.model.trim())
        }
      }
      // res.notFound (first run) -> keep the 06:00 / standard defaults.
      setLoading(false)
    })()
    return () => { cancelled = true }
  }, [storage])

  useEffect(() => {
    let cancelled = false
    setAgentsPhase('loading')
    fetchAgents(token)
      .then((rows) => {
        if (cancelled) return
        setAgents(rows)
        setAgentsPhase('ready')
        setAgentId((current) => {
          if (!rows.length || rows.some((agent) => agent.id === current)) return current
          const fallback = rows.find((agent) => agent.id === DEFAULT_AGENT_ID) || rows[0]
          return fallback.id
        })
      })
      .catch(() => {
        if (cancelled) return
        setAgentsPhase('error')
      })
    return () => { cancelled = true }
  }, [token])

  useEffect(() => {
    let cancelled = false
    fetchModelConfig(token)
      .then(({ connected, models }) => {
        if (cancelled) return
        setConnectedProviders(connected)
        setModelGroups(models)
      })
      .catch(() => {
        if (cancelled) return
        setModelGroups(FALLBACK_MODEL_GROUPS)
      })
    return () => { cancelled = true }
  }, [token])

  const onTimeChange = useCallback((e) => {
    // <input type="time"> can be cleared to "" -> NaN. Drop NaN so we never
    // write a corrupt cron; the input repaints with the last good value.
    const [hStr] = e.target.value.split(':')
    const h = Number(hStr)
    if (Number.isFinite(h) && h >= 0 && h <= 23) {
      setHour(h)
      setCronIsCustom(false) // editing the hour adopts the standard shape
    }
  }, [])

  const save = useCallback(async () => {
    if (saving) return
    setSaving(true)
    setError('')
    setToast('')
    // Preserve a custom cron verbatim if the user never touched the hour;
    // otherwise write the standard "0 <h> * * *".
    const cron = cronIsCustom ? rawCron : buildCron(hour)
    const selectedAgent = agents.find((agent) => agent.id === agentId) || null
    try {
      await storage.putJSON('settings.json', {
        ...settingsExtra,
        cron,
        hour,
        minute: 0,
        timezone: settingsExtra.timezone ?? null,
        exclude_apps: excludeApps,
        agent_id: selectedAgent?.id || agentId || null,
        provider: provider || selectedAgent?.provider || settingsExtra.provider || DEFAULT_PROVIDER,
        model: model || selectedAgent?.model || settingsExtra.model || null,
        effort: selectedAgent ? (selectedAgent.effort ?? null) : (settingsExtra.effort ?? null),
      })
      setToast('Saved ✓')
      setTimeout(() => setToast(''), 2600)
    } catch {
      setError(online ? 'Could not save — try again.' : 'You’re offline — reconnect to save.')
    } finally {
      setSaving(false)
    }
  }, [saving, cronIsCustom, rawCron, hour, excludeApps, agentId, agents, provider, model, settingsExtra, storage, online])

  if (loading) {
    return (
      <div className="dr-loading-wrap">
        <span className="dr-spinner" aria-hidden="true" />
        <div>Loading settings…</div>
      </div>
    )
  }

  return (
    <div className="dr-settings-wrap dr-rise">
      <div className="dr-settings-card">
        <div className="dr-section-head">
          <span className="dr-section-icon" aria-hidden="true">⏰</span>
          <h2 className="dr-section-label">When to dream</h2>
        </div>
        <p className="dr-note">
          Pick the hour your morning brief should be ready. Dreaming writes it
          overnight so it’s waiting when you wake.
        </p>
        {cronIsCustom ? (
          <div className="dr-custom-cron-note">
            You have a custom schedule set (<code>{rawCron}</code>). Pick an
            hour below to switch to a simple daily time, or leave it as-is.
            <div className="dr-time-row">
              <input
                type="time"
                step="3600"
                className="dr-time-input"
                value={hourToTimeValue(hour)}
                onChange={onTimeChange}
                aria-label="Daily brief time"
              />
              <span className="dr-note">on the hour, every day</span>
            </div>
          </div>
        ) : (
          <div className="dr-time-row">
            <input
              type="time"
              step="3600"
              className="dr-time-input"
              value={hourToTimeValue(hour)}
              onChange={onTimeChange}
              aria-label="Daily brief time"
            />
            <span className="dr-note">
              ready around <strong className="dr-note-strong">{hourClockLabel(hour)}</strong>, every day
            </span>
          </div>
        )}
        <div className="dr-schedule-hint">
          <span aria-hidden="true">💡</span>
          <span>
            Schedule changes take effect after the dreaming agent re-installs
            its overnight job — usually by the next run. The app saves your
            preference; the agent picks it up from there.
          </span>
        </div>
      </div>

      <div className="dr-settings-card">
        <div className="dr-section-head">
          <span className="dr-section-icon" aria-hidden="true">🤖</span>
          <h2 className="dr-section-label">Who dreams</h2>
        </div>
        <p className="dr-note">
          Pick the named agent for the overnight pass. Dreaming keeps its own
          procedure; the agent supplies provider, model, and effort.
        </p>
        <select
          className="dr-agent-select"
          value={agentId}
          onChange={(e) => setAgentId(e.target.value)}
          disabled={agentsPhase === 'loading' || agents.length === 0}
          aria-label="Dreaming agent"
        >
          {agents.length === 0 ? (
            <option value={agentId}>
              {agentsPhase === 'loading' ? 'Loading agents...' : 'Builder'}
            </option>
          ) : agents.map((agent) => (
            <option key={agent.id} value={agent.id}>
              {agent.icon ? `${agent.icon} ` : ''}{agent.label || agent.id}
            </option>
          ))}
        </select>
        {agentsPhase === 'error' ? (
          <div className="dr-agent-meta">Could not load agents. The saved agent will stay unchanged.</div>
        ) : (
          <div className="dr-agent-meta">
            {(() => {
              const selected = agents.find((agent) => agent.id === agentId)
              if (!selected) return 'Builder uses the default Dreaming model settings.'
              const provider = PROVIDER_LABELS[selected.provider] || selected.provider || 'default provider'
              const model = selected.model || 'default model'
              const effort = selected.effort ? `, ${selected.effort} effort` : ''
              return `${provider}, ${model}${effort}`
            })()}
          </div>
        )}
        <div className="dr-model-label">Nightly model</div>
        {modelGroups === null ? (
          <div className="dr-note">Loading models…</div>
        ) : (
          <>
            <select
              className="dr-agent-select"
              value={`${provider}\t${model}`}
              onChange={(e) => {
                const [nextProvider, nextModel] = e.target.value.split('\t')
                if (nextProvider && nextModel) {
                  setProvider(nextProvider)
                  setModel(nextModel)
                }
              }}
              aria-label="Dreaming model"
            >
              {!modelGroups.some((group) =>
                group.key === provider && group.models.some((m) => m.id === model)
              ) && (
                <option value={`${provider}\t${model}`}>
                  Current: {model || DEFAULT_MODEL}
                </option>
              )}
              {modelGroups.map((group) => {
                const isConnected = !connectedProviders || connectedProviders.has(group.key)
                return (
                  <optgroup
                    key={group.key}
                    label={`${group.label}${isConnected ? '' : ' (not connected)'}`}
                  >
                    {group.models.map((m) => {
                      const on = provider === group.key && model === m.id
                      return (
                        <option
                          key={`${group.key}-${m.id}`}
                          value={`${group.key}\t${m.id}`}
                          disabled={!isConnected && !on}
                        >
                          {m.name} ({m.id})
                        </option>
                      )
                    })}
                  </optgroup>
                )
              })}
            </select>
            <div className="dr-agent-meta">
              {(modelGroups.find((group) => group.key === provider)?.label || provider)}
              {' · '}
              {model}
            </div>
          </>
        )}
      </div>

      <div className="dr-save-row">
        <button className="dr-save-btn dr-pressable" onClick={save} disabled={saving}>
          {saving ? 'Saving…' : 'Save settings'}
        </button>
        {toast && <span className="dr-toast">{toast}</span>}
        {error && <span className="dr-error-toast">{error}</span>}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

export default function App({ appId, token }) {
  const [tab, setTab] = useState('reports')
  const [openDate, setOpenDate] = useState(null)
  const detailNavRef = useRef(null)
  const online = useOnline()
  const storage = useMemo(() => makeStorage(appId, token), [appId, token])

  // Surface the streak in the header on the reports tab. We read it once
  // here (cheap, cached) so the badge is present even before the list
  // finishes its own load. The list keeps its own authoritative copy.
  const [headerStreak, setHeaderStreak] = useState(() => readCache(appId)?.streak || 0)
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const res = await storage.getJSON('state.json')
      if (cancelled) return
      if (res.data && Number.isFinite(res.data.streak)) {
        setHeaderStreak(res.data.streak)
      }
    })()
    return () => { cancelled = true }
  }, [storage, appId])

  const closeDetail = useCallback(() => {
    try { detailNavRef.current?.close?.() } catch {}
    detailNavRef.current = null
    setOpenDate(null)
  }, [])

  const openDetail = useCallback(async (dateStr) => {
    try { detailNavRef.current?.close?.() } catch {}
    detailNavRef.current = null
    if (window.mobius?.nav?.open) {
      const handle = window.mobius.nav.open('dreaming-report', () => {
        detailNavRef.current = null
        setOpenDate(null)
      })
      detailNavRef.current = handle
      await handle.ready?.catch(() => false)
      if (detailNavRef.current !== handle) return
    }
    setOpenDate(dateStr)
  }, [])

  useEffect(() => () => {
    try { detailNavRef.current?.close?.() } catch {}
  }, [])

  return (
    <div className="dr-root">
      <style>{CSS}</style>
      <div className="dr-aurora" aria-hidden="true" />
      <div className="dr-header">
        <div className="dr-brand">
          <span className="dr-mark" aria-hidden="true">
            <span className="dr-mark-glyph">🌙</span>
          </span>
          <div className="dr-brand-text">
            <h1 className="dr-title">Dreaming</h1>
            <span className="dr-subtitle">your overnight brief</span>
          </div>
        </div>
        <div className="dr-header-right">
          {headerStreak >= 1 && (
            <span className="dr-streak-badge" title={`${headerStreak} mornings in a row`}>
              <span aria-hidden="true">🔥</span>
              {headerStreak}
            </span>
          )}
          <div className="dr-seg" role="tablist" aria-label="View">
            <button
              role="tab"
              aria-selected={tab === 'reports'}
              className={`dr-seg-btn${tab === 'reports' ? ' is-active' : ''}`}
              onClick={() => setTab('reports')}
            >
              Briefs
            </button>
            <button
              role="tab"
              aria-selected={tab === 'settings'}
              className={`dr-seg-btn${tab === 'settings' ? ' is-active' : ''}`}
              onClick={() => { closeDetail(); setTab('settings') }}
            >
              Settings
            </button>
          </div>
        </div>
      </div>
      <div className="dr-divider" />
      <div className="dr-scroll">
        {tab === 'reports' ? (
          <>
            <ReportsList
              appId={appId}
              storage={storage}
              online={online}
              onOpen={openDetail}
            />
            {openDate && (
              <ReportDetail
                dateStr={openDate}
                storage={storage}
                online={online}
                onBack={closeDetail}
              />
            )}
          </>
        ) : (
          <SettingsTab appId={appId} storage={storage} online={online} token={token} />
        )}
      </div>
    </div>
  )
}
