import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import DOMPurify from 'https://esm.sh/dompurify@3'

// Sanitization profile for agent-produced report HTML. Mirrors
// app-news's profile exactly — the dreamer can't reach the web
// today, but the input it summarises (chat snippets, activity
// records) is untrusted user-adjacent data. A poisoned chat title
// could otherwise inject <script>/onerror=/javascript: URIs into
// the HTML the dreamer quotes, which renders verbatim under the
// owner's JWT. We allow <details>/<summary> because the report
// shell uses them; everything else stays on the standard html
// profile.
const SANITIZE_CONFIG = {
  USE_PROFILES: { html: true },
  ADD_TAGS: ['details', 'summary'],
  FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'meta', 'link'],
  FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover', 'onfocus', 'onblur', 'onsubmit', 'formaction', 'srcset'],
  ALLOWED_URI_REGEXP: /^(?:https?):/i,
}

function sanitizeReportHtml(raw) {
  if (!raw) return ''
  return DOMPurify.sanitize(raw, SANITIZE_CONFIG)
}

// Provider display order + UI labels. Same shape as app-news: the
// per-model list is fetched at runtime from
// `GET /api/auth/providers/models`. The fallback below is the bare
// minimum so an offline picker can still save *something*.
const PROVIDER_ORDER = [
  { key: 'claude', label: 'Claude Code' },
  { key: 'codex', label: 'OpenAI Codex' },
]

const FALLBACK_GROUPS = [
  {
    key: 'claude',
    label: 'Claude Code',
    models: [{ id: 'claude-opus-4-7', name: 'Opus 4.7' }],
  },
  {
    key: 'codex',
    label: 'OpenAI Codex',
    models: [{ id: 'gpt-5.5', name: 'gpt-5.5' }],
  },
]

const DEFAULT_PROVIDER = FALLBACK_GROUPS[0].key
const DEFAULT_MODEL = FALLBACK_GROUPS[0].models[0].id

const VERBOSITY_OPTIONS = [
  { id: 'terse', label: 'Terse', hint: 'A short paragraph; the bare highlights.' },
  { id: 'standard', label: 'Standard', hint: 'A few paragraphs; suggestions; one closing thought.' },
  { id: 'chatty', label: 'Chatty', hint: 'Longer narrative; more pattern-spotting.' },
]
const DEFAULT_VERBOSITY = 'standard'

// Default editorial brief — kept in sync with the bundled topics.txt
// so "Reset to default" writes the same text the installer seeded.
const DEFAULT_TOPICS = `This is your editorial brief — edit it to make the dream yours. The
text below is what the dreamer reads each night to decide what to
notice and how to write it. Be opinionated; the more specific you
are, the better the report.

Voice: warm but not effusive. Tell me the meaningful patterns, skip
the trivial. If I had a long chat about X, surface what was
unresolved or what I might want to follow up on. Don't list every
action — synthesize.

What to weight: chats that ended mid-thought, apps I opened
repeatedly (a sign something's pulling me back), and anything I
installed but didn't actually open yet. These are the highest-signal
moments.

What to skip: routine app opens (e.g. the same notes app every
morning is not news), short throwaway chats, and any activity from
the Dreaming app itself.

Anticipation, not surveillance: the goal of "today you might want
to" is to surface things I'd thank you for noticing — a half-finished
draft, a chat I should reply to, a habit I'm forming and might want
to lean into. Don't invent generic productivity tips.

Tone: write like a thoughtful friend who's been quietly paying
attention, not a corporate dashboard summarising my KPIs. One closing
observation per report — something durable worth noticing.
`

const S = {
  root: {
    height: '100%', display: 'flex', flexDirection: 'column',
    background: 'var(--bg)', color: 'var(--text)',
    fontFamily: 'var(--font)',
    maxWidth: '100%', overflowX: 'hidden',
  },
  header: {
    padding: '18px 20px 0', display: 'flex', alignItems: 'center',
    justifyContent: 'space-between', flexShrink: 0, gap: '12px',
    flexWrap: 'wrap',
  },
  titleRow: {
    display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap',
  },
  title: {
    fontSize: '22px', fontWeight: 700, letterSpacing: '-0.3px',
    margin: 0,
  },
  streakBadge: {
    display: 'inline-flex', alignItems: 'center', gap: '4px',
    padding: '3px 9px', borderRadius: '999px',
    background: 'var(--accent-dim, rgba(99,102,241,0.15))',
    color: 'var(--accent)',
    border: '1px solid var(--border)',
    fontSize: '12px', fontWeight: 600, lineHeight: 1.2,
    whiteSpace: 'nowrap',
  },
  streakBadgeQuiet: {
    background: 'var(--surface)',
    color: 'var(--muted)',
  },
  todayLabel: {
    fontSize: '12px', color: 'var(--muted)', whiteSpace: 'nowrap',
  },
  tabs: {
    display: 'flex', gap: '2px', background: 'var(--surface)',
    borderRadius: '8px', padding: '3px', border: '1px solid var(--border)',
  },
  tab: (active) => ({
    padding: '6px 14px', borderRadius: '6px', border: 'none', cursor: 'pointer',
    fontSize: '13px', fontWeight: 500,
    background: active ? 'var(--accent)' : 'transparent',
    color: active ? '#fff' : 'var(--muted)',
    transition: 'all 0.15s',
  }),
  divider: { height: '1px', background: 'var(--border)', margin: '14px 20px 0' },
  scroll: {
    flex: 1, overflowY: 'auto', overflowX: 'hidden',
    padding: '14px 20px 32px',
    wordBreak: 'break-word', overflowWrap: 'anywhere',
  },

  // Reports — list of dated dreams, newest on top.
  reportList: {
    display: 'flex', flexDirection: 'column', gap: '10px',
    maxWidth: '720px', margin: '0 auto',
  },
  reportCard: (expanded) => ({
    border: '1px solid var(--border)',
    borderRadius: '12px',
    background: 'var(--surface)',
    overflow: 'hidden',
    transition: 'border-color 0.15s',
    borderColor: expanded ? 'var(--accent)' : 'var(--border)',
  }),
  reportCardHeader: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    gap: '12px', padding: '12px 16px', cursor: 'pointer',
    userSelect: 'none', background: 'transparent',
    border: 'none', width: '100%', textAlign: 'left',
    color: 'var(--text)', fontFamily: 'var(--font)',
  },
  reportCardDate: {
    fontSize: '14px', fontWeight: 600, lineHeight: 1.3,
  },
  reportCardChevron: {
    fontSize: '11px', color: 'var(--muted)',
    transition: 'transform 0.15s',
  },
  reportCardBody: {
    padding: '4px 16px 18px',
    borderTop: '1px solid var(--border)',
  },
  reportContainer: {
    fontSize: '15px', lineHeight: 1.65, color: 'var(--text)',
    wordBreak: 'break-word', overflowWrap: 'anywhere',
  },
  empty: {
    textAlign: 'center', padding: '50px 20px', color: 'var(--muted)',
    fontSize: '13px', lineHeight: 1.6,
  },
  loading: {
    textAlign: 'center', padding: '50px 20px', color: 'var(--muted)',
    fontSize: '13px',
  },
  topRow: {
    display: 'flex', alignItems: 'center', gap: '10px',
    marginBottom: '14px', flexWrap: 'wrap',
    maxWidth: '720px', margin: '0 auto 14px',
  },
  generateBtn: (busy) => ({
    padding: '7px 14px', borderRadius: '8px',
    border: '1px solid var(--border)',
    background: busy ? 'var(--surface)' : 'var(--accent)',
    color: busy ? 'var(--muted)' : '#fff',
    cursor: busy ? 'default' : 'pointer',
    fontSize: '13px', fontWeight: 500, whiteSpace: 'nowrap',
  }),
  statusHint: { fontSize: '12px', color: 'var(--muted)' },
  errorToast: { fontSize: '12px', color: 'var(--red, #ef4444)' },

  // Settings
  settingsWrap: { maxWidth: '720px', margin: '0 auto' },
  settingsSection: { marginBottom: '24px' },
  label: { fontSize: '13px', fontWeight: 600, margin: '0 0 4px', display: 'block' },
  note: { fontSize: '12px', color: 'var(--muted)', margin: '0 0 10px', lineHeight: 1.5 },
  topicsTextarea: {
    width: '100%', minHeight: '140px',
    fontFamily: 'var(--font)',
    fontSize: '13px', lineHeight: 1.55, padding: '12px',
    background: 'var(--surface)', color: 'var(--text)',
    border: '1px solid var(--border)', borderRadius: '8px',
    resize: 'vertical', outline: 'none', boxSizing: 'border-box',
    whiteSpace: 'pre-wrap', wordBreak: 'break-word',
    overflowWrap: 'anywhere', maxWidth: '100%',
  },
  btnRow: { display: 'flex', alignItems: 'center', gap: '8px', marginTop: '10px', flexWrap: 'wrap' },
  btn: {
    padding: '7px 16px', border: 'none', borderRadius: '10px',
    background: 'var(--accent)', color: '#fff',
    fontSize: '13px', fontWeight: 600, cursor: 'pointer',
  },
  linkBtn: {
    background: 'none', border: 'none', padding: 0,
    color: 'var(--accent)', fontSize: '12px', cursor: 'pointer',
    textDecoration: 'underline',
  },
  toast: { fontSize: '12px', color: 'var(--green, #4caf50)' },
  timeRow: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' },
  timeInput: {
    padding: '7px 10px', fontSize: '14px',
    background: 'var(--surface)', color: 'var(--text)',
    border: '1px solid var(--border)', borderRadius: '8px',
    outline: 'none', width: '120px',
  },
  tzRow: {
    display: 'flex', alignItems: 'center', gap: '8px',
    marginTop: '8px', fontSize: '12.5px', color: 'var(--muted)',
    flexWrap: 'wrap',
  },
  nextRun: {
    display: 'flex', alignItems: 'baseline', gap: '6px',
    marginTop: '6px', fontSize: '12.5px',
    color: 'var(--text)', flexWrap: 'wrap',
  },
  nextRunClock: { fontWeight: 600 },
  nextRunCountdown: { color: 'var(--muted)' },
  btnSecondary: {
    padding: '7px 14px', borderRadius: '10px',
    border: '1px solid var(--border)',
    background: 'var(--surface)', color: 'var(--text)',
    fontSize: '13px', fontWeight: 600, cursor: 'pointer',
  },
  btnSecondaryBusy: {
    padding: '7px 14px', borderRadius: '10px',
    border: '1px solid var(--border)',
    background: 'var(--surface)', color: 'var(--muted)',
    fontSize: '13px', fontWeight: 600, cursor: 'default',
  },
  modelList: {
    display: 'flex', flexDirection: 'column', gap: '14px', marginTop: '6px',
  },
  modelGroup: { display: 'flex', flexDirection: 'column', gap: '6px' },
  modelGroupHeader: {
    display: 'flex', alignItems: 'center', gap: '8px',
    fontSize: '11px', fontWeight: 600,
    textTransform: 'uppercase', letterSpacing: '0.6px',
    color: 'var(--muted)',
    margin: '2px 4px 4px',
  },
  modelGroupHint: {
    fontSize: '10.5px', fontWeight: 500,
    textTransform: 'none', letterSpacing: 0,
    color: 'var(--muted)',
    opacity: 0.85,
  },
  modelRow: (on, disabled) => ({
    display: 'flex', alignItems: 'center', gap: '10px',
    padding: '10px 12px', borderRadius: '10px',
    cursor: disabled ? 'not-allowed' : 'pointer',
    background: on ? 'var(--accent-dim)' : 'var(--surface)',
    border: `1px solid ${on ? 'var(--accent)' : 'var(--border)'}`,
    opacity: disabled && !on ? 0.55 : 1,
    fontSize: '13px', fontWeight: 500, userSelect: 'none',
  }),
  modelRowMain: { display: 'flex', flexDirection: 'column', gap: '2px', flex: 1 },
  modelRowTitle: { fontWeight: 600 },
  modelRowSub: { fontSize: '11.5px', color: 'var(--muted)', fontWeight: 400 },
  verbositySelect: {
    padding: '7px 10px', fontSize: '13px',
    background: 'var(--surface)', color: 'var(--text)',
    border: '1px solid var(--border)', borderRadius: '8px',
    outline: 'none', minWidth: '180px',
  },
  streakRow: {
    display: 'flex', alignItems: 'baseline', gap: '10px',
    flexWrap: 'wrap', marginTop: '4px',
  },
  streakNumber: {
    fontSize: '24px', fontWeight: 700, color: 'var(--text)',
  },
  streakLastSeen: {
    fontSize: '12px', color: 'var(--muted)',
  },
}

// Scoped stylesheet for the agent-emitted .dreaming-report markup.
// Mirrors app-news's REPORT_CSS but with the dreaming-report__ prefix.
// Injected once at app mount because dangerouslySetInnerHTML content
// has no other hook into our styles.
const REPORT_CSS = `
.dreaming-report__summary {
  margin: 0 0 18px;
  padding: 10px 14px;
  background: var(--accent-dim, rgba(99,102,241,0.12));
  border-left: 3px solid var(--accent);
  border-radius: 6px;
}
.dreaming-report__summary > summary {
  cursor: pointer;
  font-weight: 600;
  font-size: 13px;
  color: var(--accent);
  letter-spacing: 0.2px;
  text-transform: uppercase;
  list-style: none;
}
.dreaming-report__summary > summary::-webkit-details-marker { display: none; }
.dreaming-report__summary > summary::after {
  content: ' ▾';
  font-size: 11px;
  color: var(--muted);
}
.dreaming-report__summary[open] > summary::after { content: ' ▴'; }
.dreaming-report__summary > p {
  margin: 8px 0 0;
  font-size: 14px;
  line-height: 1.6;
  color: var(--text);
}
.dreaming-report__body { margin-top: 8px; }
.dreaming-report__body h2 {
  font-size: 17px;
  font-weight: 700;
  letter-spacing: -0.2px;
  margin: 22px 0 8px;
  color: var(--text);
}
.dreaming-report__body h3 {
  font-size: 14px;
  font-weight: 600;
  margin: 16px 0 6px;
  color: var(--text);
}
.dreaming-report__body p {
  margin: 0 0 12px;
}
.dreaming-report__body a {
  color: var(--accent);
  text-decoration: underline;
  text-decoration-thickness: 1px;
  text-underline-offset: 2px;
}
.dreaming-report__body blockquote {
  margin: 12px 0;
  padding: 6px 14px;
  border-left: 3px solid var(--border);
  color: var(--muted);
  font-style: italic;
}
.dreaming-report__body ul, .dreaming-report__body ol {
  margin: 0 0 12px;
  padding-left: 22px;
}
.dreaming-report__body li { margin-bottom: 4px; }
`

function formatDate(dateStr) {
  const d = new Date(dateStr + 'T12:00:00')
  return d.toLocaleDateString(undefined, {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  })
}

function shortDate(dateStr) {
  const d = new Date(dateStr + 'T12:00:00')
  return d.toLocaleDateString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric',
  })
}

function todayLocalDateStr() {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

// Compute the next firing of an hour/minute schedule. Same logic
// as app-news — when `useLocalTz` is true the hour/minute are local
// clock, otherwise UTC (matching the cron sync's interpretation).
function nextRunDate(hour, minute, useLocalTz) {
  const now = new Date()
  const next = new Date(now)
  if (useLocalTz) {
    next.setHours(hour, minute, 0, 0)
  } else {
    next.setUTCHours(hour, minute, 0, 0)
  }
  if (next <= now) {
    next.setDate(next.getDate() + 1)
  }
  return next
}

function formatCountdown(next, now) {
  const ms = next.getTime() - now.getTime()
  if (ms <= 0) return 'any moment'
  const totalSec = Math.floor(ms / 1000)
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  if (h >= 1) return `in ${h}h ${m}m`
  if (m >= 1) return `in ${m}m`
  return `in ${totalSec}s`
}

function formatLocalClock(date) {
  try {
    return new Intl.DateTimeFormat(undefined, {
      hour: '2-digit', minute: '2-digit',
    }).format(date)
  } catch {
    const h = String(date.getHours()).padStart(2, '0')
    const m = String(date.getMinutes()).padStart(2, '0')
    return `${h}:${m}`
  }
}

// Storage helpers — use window.mobius.storage when the offline runtime
// shim has injected it; otherwise fall back to direct fetch against
// /api/storage. This way the app works on main today AND gains
// offline benefits when the sibling session-offline branch merges.
//
// The shim's contract (per the offline-runtime spec): get(path) returns
// the parsed body or null on 404; set(path, value) writes; remove(path)
// deletes. Our fallbacks do the same shape so callers don't branch.
function makeStorage(appId, token) {
  const ms = (typeof window !== 'undefined') ? window.mobius?.storage : null

  const url = (path) => `/api/storage/apps/${appId}/${path}`
  const authHeaders = (extra = {}) => ({
    Authorization: `Bearer ${token}`,
    ...extra,
  })

  async function getJSON(path) {
    if (ms?.get) {
      try { return await ms.get(path) }
      catch { /* fall through to direct fetch */ }
    }
    const r = await fetch(url(path), { headers: authHeaders() })
    if (r.status === 404) return null
    if (!r.ok) return null
    try { return await r.json() }
    catch { return null }
  }

  async function getText(path) {
    if (ms?.get) {
      try {
        const v = await ms.get(path)
        if (typeof v === 'string') return v
        if (v == null) return null
        // ms.get may parse JSON for us; serialise back when caller wants text.
        return JSON.stringify(v)
      } catch { /* fall through */ }
    }
    const r = await fetch(url(path), { headers: authHeaders() })
    if (r.status === 404) return null
    if (!r.ok) return null
    return r.text()
  }

  async function headExists(path) {
    // The shim doesn't have a HEAD primitive yet; cheap GET via the
    // shim still resolves the question (null vs value). For the
    // direct path we use HEAD to avoid pulling the body.
    if (ms?.get) {
      try {
        const v = await ms.get(path)
        return v != null
      } catch { /* fall through */ }
    }
    try {
      const r = await fetch(url(path), { method: 'HEAD', headers: authHeaders() })
      return r.ok
    } catch {
      return false
    }
  }

  async function putJSON(path, obj) {
    if (ms?.set) {
      try { return await ms.set(path, obj) }
      catch { /* fall through */ }
    }
    return fetch(url(path), {
      method: 'PUT',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(obj),
    })
  }

  async function putText(path, text) {
    if (ms?.set) {
      try { return await ms.set(path, text) }
      catch { /* fall through */ }
    }
    return fetch(url(path), {
      method: 'PUT',
      headers: authHeaders({ 'Content-Type': 'text/plain' }),
      body: text,
    })
  }

  return { getJSON, getText, headExists, putJSON, putText }
}

// Plain JSON GET against an arbitrary endpoint (used for the provider
// status / models lookups which live outside per-app storage).
async function fetchJSON(url, token) {
  try {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
    if (!r.ok) return { ok: false, status: r.status }
    return { ok: true, data: await r.json() }
  } catch {
    return { ok: false, status: 0 }
  }
}

// Probe the last 30 days for available dream dates. Same shape as
// app-news's loadReportDates — HEADs each candidate, gives up after
// 5 consecutive misses so a quiet stretch doesn't iterate the full
// month.
async function loadReportDates(storage) {
  const dates = []
  const today = new Date()
  let misses = 0
  for (let i = 0; i < 30; i++) {
    const d = new Date(today)
    d.setDate(d.getDate() - i)
    const dateStr = d.toISOString().slice(0, 10)
    const exists = await storage.headExists(`reports/${dateStr}.html`)
    if (exists) {
      dates.push(dateStr)
      misses = 0
    } else {
      misses++
    }
    if (misses >= 5) break
  }
  return dates
}

async function loadReportHtml(storage, dateStr) {
  return storage.getText(`reports/${dateStr}.html`)
}

// One card in the Reports list. Lazily loads its HTML body the first
// time the user expands it so opening the tab is cheap even when 30
// days of dreams are on disk.
function ReportCard({ dateStr, storage, defaultOpen }) {
  const [open, setOpen] = useState(!!defaultOpen)
  const [html, setHtml] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)

  useEffect(() => {
    if (!open || html !== null) return
    let cancelled = false
    setLoading(true)
    setError(false)
    ;(async () => {
      const body = await loadReportHtml(storage, dateStr)
      if (cancelled) return
      if (body == null) {
        setError(true)
        setHtml('')
      } else {
        setHtml(body)
      }
      setLoading(false)
    })()
    return () => { cancelled = true }
  }, [open, html, storage, dateStr])

  return (
    <div style={S.reportCard(open)}>
      <button
        style={S.reportCardHeader}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span style={S.reportCardDate}>{formatDate(dateStr)}</span>
        <span
          style={{
            ...S.reportCardChevron,
            transform: open ? 'rotate(180deg)' : 'none',
          }}
        >
          ▾
        </span>
      </button>
      {open && (
        <div style={S.reportCardBody}>
          {loading ? (
            <div style={S.loading}>Loading…</div>
          ) : error ? (
            <div style={S.empty}>This dream could not be loaded.</div>
          ) : html ? (
            <div
              style={S.reportContainer}
              // HTML comes from the dreamer (a sub-agent). The input it
              // summarises (chat snippets, activity records) is
              // untrusted user-adjacent content that a malicious chat
              // title could weaponise into <script> tags rendered under
              // the owner's JWT. DOMPurify strips the common XSS shapes
              // before injection — see SANITIZE_CONFIG.
              dangerouslySetInnerHTML={{ __html: sanitizeReportHtml(html) }}
            />
          ) : (
            <div style={S.empty}>Empty report.</div>
          )}
        </div>
      )}
    </div>
  )
}

function ReportsTab({ appId, storage }) {
  const [dates, setDates] = useState([])
  const [loading, setLoading] = useState(true)
  const [schedule, setSchedule] = useState(null)
  // generating: null = idle, {since: Date, knownDates: Set} when polling.
  const [generating, setGenerating] = useState(null)
  const [statusMsg, setStatusMsg] = useState('')
  const [errorMsg, setErrorMsg] = useState('')
  const pollRef = useRef(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const [list, s] = await Promise.all([
        loadReportDates(storage),
        storage.getJSON('schedule.json'),
      ])
      if (cancelled) return
      setDates(list)
      if (s) setSchedule(s)
      setLoading(false)
    })()
    return () => { cancelled = true }
  }, [storage])

  useEffect(() => () => {
    if (pollRef.current) clearInterval(pollRef.current)
  }, [])

  const handleGenerate = useCallback(async () => {
    setErrorMsg('')
    setStatusMsg('Asking the dreamer to run now…')
    let started
    try {
      const r = await fetch(`/api/apps/${appId}/run-job`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${storage._token ?? ''}` },
      })
      if (!r.ok) {
        setStatusMsg('')
        setErrorMsg(`Could not start job (HTTP ${r.status}).`)
        return
      }
      started = Date.now()
    } catch {
      setStatusMsg('')
      setErrorMsg('Could not reach the server.')
      return
    }
    const knownDates = new Set(dates)
    setGenerating({ since: started, knownDates })
    pollRef.current = setInterval(async () => {
      const elapsed = Date.now() - started
      const list = await loadReportDates(storage)
      const fresh = list.find((d) => !knownDates.has(d))
      if (fresh) {
        clearInterval(pollRef.current)
        pollRef.current = null
        setDates(list)
        setGenerating(null)
        setStatusMsg('New dream ready.')
        setTimeout(() => setStatusMsg(''), 3500)
        return
      }
      if (elapsed > 120_000) {
        clearInterval(pollRef.current)
        pollRef.current = null
        setGenerating(null)
        setStatusMsg('')
        setErrorMsg('Dream taking longer than expected. Check back soon.')
      }
    }, 5000)
  }, [appId, dates, storage])

  if (loading) return <div style={S.loading}>Loading dreams…</div>

  return (
    <div>
      <div style={S.topRow}>
        <button
          style={S.generateBtn(!!generating)}
          onClick={handleGenerate}
          disabled={!!generating}
        >
          {generating ? 'Dreaming…' : 'Run dreamer now'}
        </button>
        {statusMsg && <span style={S.statusHint}>{statusMsg}</span>}
        {errorMsg && <span style={S.errorToast}>{errorMsg}</span>}
      </div>

      {dates.length === 0 ? (
        <div style={S.empty}>
          {(() => {
            if (!schedule) {
              return 'Your first dream will land here after tonight. Press “Run dreamer now” to generate one immediately.'
            }
            const hour = schedule.hour ?? 6
            const minute = schedule.minute ?? 0
            const useLocalTz = !!schedule.timezone
            const next = nextRunDate(hour, minute, useLocalTz)
            const clock = formatLocalClock(next)
            return `Your first dream will land here at ${clock}. Press “Run dreamer now” to generate one immediately.`
          })()}
        </div>
      ) : (
        <div style={S.reportList}>
          {dates.map((d, i) => (
            <ReportCard
              key={d}
              dateStr={d}
              storage={storage}
              defaultOpen={i === 0}
            />
          ))}
        </div>
      )}
    </div>
  )
}

// Same stitch helper app-news uses — map backend
// `{claude:[...], codex:[...]}` onto PROVIDER_ORDER, drop providers
// the backend didn't return.
function buildProviderGroups(payload) {
  if (!payload || typeof payload !== 'object') return FALLBACK_GROUPS
  const groups = []
  for (const meta of PROVIDER_ORDER) {
    const rows = Array.isArray(payload[meta.key]) ? payload[meta.key] : null
    if (!rows || rows.length === 0) continue
    groups.push({
      key: meta.key,
      label: meta.label,
      models: rows
        .filter((r) => r && typeof r.id === 'string')
        .map((r) => ({ id: r.id, name: r.name || r.id })),
    })
  }
  return groups.length > 0 ? groups : FALLBACK_GROUPS
}

function SettingsTab({ appId, token, storage, streak }) {
  const [topics, setTopics] = useState('')
  const [hour, setHour] = useState(6)
  const [minute, setMinute] = useState(0)
  const [useLocalTz, setUseLocalTz] = useState(false)
  const [provider, setProvider] = useState(DEFAULT_PROVIDER)
  const [model, setModel] = useState(DEFAULT_MODEL)
  const [verbosity, setVerbosity] = useState(DEFAULT_VERBOSITY)
  const [providerGroups, setProviderGroups] = useState(null)
  const [connectedProviders, setConnectedProviders] = useState(null)
  const [loading, setLoading] = useState(true)
  const [topicsToast, setTopicsToast] = useState('')
  const [scheduleToast, setScheduleToast] = useState('')
  const [agentToast, setAgentToast] = useState('')
  const [verbosityToast, setVerbosityToast] = useState('')
  const [runNowBusy, setRunNowBusy] = useState(false)
  const [runNowToast, setRunNowToast] = useState('')
  const [runNowError, setRunNowError] = useState('')
  const [, setCountdownTick] = useState(0)

  useEffect(() => {
    const id = setInterval(() => setCountdownTick((t) => t + 1), 30_000)
    return () => clearInterval(id)
  }, [])

  const localTz = useMemo(() => {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' }
    catch { return 'UTC' }
  }, [])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const [topicsText, sched, agent, verb, providerStatus, providerModels] = await Promise.all([
        storage.getText('topics.txt'),
        storage.getJSON('schedule.json'),
        storage.getJSON('agent.json'),
        storage.getJSON('verbosity.json'),
        fetchJSON('/api/auth/providers/status', token),
        fetchJSON('/api/auth/providers/models', token),
      ])
      if (cancelled) return

      setTopics(typeof topicsText === 'string' ? topicsText : DEFAULT_TOPICS)
      if (sched) {
        setHour(sched.hour ?? 6)
        setMinute(sched.minute ?? 0)
        setUseLocalTz(!!sched.timezone)
      }
      if (verb && typeof verb.level === 'string') {
        const known = VERBOSITY_OPTIONS.find((v) => v.id === verb.level)
        setVerbosity(known ? known.id : DEFAULT_VERBOSITY)
      }

      const groups = providerModels.ok ? buildProviderGroups(providerModels.data) : FALLBACK_GROUPS
      setProviderGroups(groups)

      let connected = null
      if (providerStatus.ok && providerStatus.data && typeof providerStatus.data === 'object') {
        connected = new Set(
          Object.entries(providerStatus.data)
            .filter(([, v]) => v && v.authenticated)
            .map(([k]) => k),
        )
        setConnectedProviders(connected)
      }

      const storedProvider = agent && typeof agent.provider === 'string' ? agent.provider : null
      const storedModel = agent && typeof agent.model === 'string' ? agent.model : null
      const knownProvider = groups.find((g) => g.key === storedProvider)
      if (knownProvider) {
        setProvider(knownProvider.key)
        // Trust the persisted model id even if it isn't in the fetched
        // list — the user (or a future shell update) may know about a
        // model we haven't surfaced. fetch.sh just passes --model
        // through; the CLI is the source of truth.
        setModel(storedModel || knownProvider.models[0].id)
      } else {
        let chosen = null
        if (connected) {
          for (const g of groups) {
            if (connected.has(g.key)) { chosen = g; break }
          }
        }
        if (!chosen) chosen = groups[0]
        setProvider(chosen.key)
        setModel(chosen.models[0].id)
      }

      setLoading(false)
    })()
    return () => { cancelled = true }
  }, [storage, token])

  const saveTopics = useCallback(async () => {
    await storage.putText('topics.txt', topics)
    setTopicsToast('Saved ✓')
    setTimeout(() => setTopicsToast(''), 2000)
  }, [storage, topics])

  const resetTopics = useCallback(async () => {
    setTopics(DEFAULT_TOPICS)
    await storage.putText('topics.txt', DEFAULT_TOPICS)
    setTopicsToast('Reset to default ✓')
    setTimeout(() => setTopicsToast(''), 2000)
  }, [storage])

  const saveSchedule = useCallback(async () => {
    const payload = { hour, minute }
    if (useLocalTz) payload.timezone = localTz
    else payload.timezone = null
    await storage.putJSON('schedule.json', payload)
    setScheduleToast('Saved ✓')
    setTimeout(() => setScheduleToast(''), 2000)
  }, [storage, hour, minute, useLocalTz, localTz])

  const saveAgent = useCallback(async (nextProvider, nextModel) => {
    setProvider(nextProvider)
    setModel(nextModel)
    await storage.putJSON('agent.json', { provider: nextProvider, model: nextModel })
    setAgentToast('Saved ✓')
    setTimeout(() => setAgentToast(''), 2000)
  }, [storage])

  const saveVerbosity = useCallback(async (level) => {
    setVerbosity(level)
    await storage.putJSON('verbosity.json', { level })
    setVerbosityToast('Saved ✓')
    setTimeout(() => setVerbosityToast(''), 2000)
  }, [storage])

  const onTimeChange = useCallback((e) => {
    const [h, m] = e.target.value.split(':').map(Number)
    setHour(h); setMinute(m)
  }, [])

  const handleRunNow = useCallback(async () => {
    if (runNowBusy) return
    setRunNowBusy(true)
    setRunNowError('')
    setRunNowToast('')
    try {
      const r = await fetch(`/api/apps/${appId}/run-job`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!r.ok) {
        setRunNowError(`Could not start job (HTTP ${r.status}).`)
      } else {
        setRunNowToast('Dreamer started — your report will appear in Reports shortly.')
        setTimeout(() => setRunNowToast(''), 4000)
      }
    } catch {
      setRunNowError('Could not reach the server.')
    } finally {
      setRunNowBusy(false)
    }
  }, [appId, token, runNowBusy])

  if (loading) return <div style={S.loading}>Loading settings…</div>

  const timeValue = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
  const localEquiv = (() => {
    if (useLocalTz) return `${timeValue} ${localTz}`
    const d = new Date()
    d.setUTCHours(hour, minute, 0, 0)
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  })()
  const tzLabel = useLocalTz
    ? `Dreaming at ${timeValue} ${localTz} (your local time).`
    : `Dreaming at ${timeValue} UTC ≈ ${localEquiv} in your local time (${localTz}).`

  return (
    <div style={S.settingsWrap}>
      <div style={S.settingsSection}>
        <label style={S.label}>Streak</label>
        <p style={S.note}>
          Counts consecutive days the dreamer found meaningful Möbius
          activity to write about. Resets when you take a night off.
        </p>
        <div style={S.streakRow}>
          <span style={S.streakNumber}>
            {streak?.current ? `🔥 ${streak.current} day${streak.current === 1 ? '' : 's'}` : '0 days'}
          </span>
          {streak?.last_active_date && (
            <span style={S.streakLastSeen}>
              Last active dream: {shortDate(streak.last_active_date)}
            </span>
          )}
        </div>
      </div>

      <div style={S.settingsSection}>
        <label style={S.label}>Editorial brief</label>
        <p style={S.note}>
          Describe what you want the dreamer to notice — voice, what to
          weight, what to skip. Plain English; no formatting needed.
        </p>
        <textarea
          style={S.topicsTextarea}
          value={topics}
          onChange={(e) => setTopics(e.target.value)}
          rows={12}
          spellCheck={true}
        />
        <p style={{ ...S.note, marginTop: '6px', marginBottom: 0 }}>
          This is your editorial brief. Tell the dreamer what you want —
          tone, what to anticipate, what to ignore. The technical schema
          (HTML shape) is handled separately.
        </p>
        <div style={S.btnRow}>
          <button style={S.btn} onClick={saveTopics}>Save</button>
          <button style={S.linkBtn} onClick={resetTopics}>Reset to default</button>
          {topicsToast && <span style={S.toast}>{topicsToast}</span>}
        </div>
      </div>

      <div style={S.settingsSection}>
        <label style={S.label}>Verbosity</label>
        <p style={S.note}>
          How much room the dreamer takes. Terse for a single paragraph,
          chatty for more pattern-spotting.
        </p>
        <select
          style={S.verbositySelect}
          value={verbosity}
          onChange={(e) => saveVerbosity(e.target.value)}
        >
          {VERBOSITY_OPTIONS.map((opt) => (
            <option key={opt.id} value={opt.id}>{opt.label} — {opt.hint}</option>
          ))}
        </select>
        {verbosityToast && (
          <div style={{ ...S.btnRow, marginTop: '8px' }}>
            <span style={S.toast}>{verbosityToast}</span>
          </div>
        )}
      </div>

      <div style={S.settingsSection}>
        <label style={S.label}>Agent / Model</label>
        <p style={S.note}>
          Which model writes your nightly dream. Pick any model from a
          connected provider — disconnected providers stay visible but
          inert; connect them from the shell’s Settings.
        </p>
        <div style={S.modelList}>
          {providerGroups === null ? (
            <div style={S.note}>Loading models…</div>
          ) : providerGroups.map((group) => {
            const isConnected = !connectedProviders
              || connectedProviders.has(group.key)
            return (
              <div key={group.key} style={S.modelGroup}>
                <div style={S.modelGroupHeader}>
                  <span>{group.label}</span>
                  {!isConnected && (
                    <span style={S.modelGroupHint}>· Not connected</span>
                  )}
                </div>
                {group.models.map((m) => {
                  const on = provider === group.key && model === m.id
                  const disabled = !isConnected && !on
                  return (
                    <div
                      key={`${group.key}-${m.id}`}
                      style={S.modelRow(on, disabled)}
                      onClick={() => {
                        if (disabled) return
                        saveAgent(group.key, m.id)
                      }}
                      role="radio"
                      aria-checked={on}
                      aria-disabled={disabled}
                    >
                      <input
                        type="radio"
                        checked={on}
                        readOnly
                        disabled={disabled}
                        style={{ accentColor: 'var(--accent)' }}
                      />
                      <div style={S.modelRowMain}>
                        <span style={S.modelRowTitle}>{m.name}</span>
                        <span style={S.modelRowSub}>{m.id}</span>
                      </div>
                    </div>
                  )
                })}
              </div>
            )
          })}
        </div>
        {agentToast && (
          <div style={{ ...S.btnRow, marginTop: '8px' }}>
            <span style={S.toast}>{agentToast}</span>
          </div>
        )}
      </div>

      <div style={S.settingsSection}>
        <label style={S.label}>Dream time</label>
        <p style={S.note}>
          When the dreamer runs each night. Default is 06:00 local-ish
          (UTC) so the report is waiting when you wake up. Schedule
          changes apply within 10 minutes.
        </p>
        <div style={S.timeRow}>
          <input
            type="time"
            style={S.timeInput}
            value={timeValue}
            onChange={onTimeChange}
            title={tzLabel}
          />
        </div>
        {(() => {
          const next = nextRunDate(hour, minute, useLocalTz)
          const clock = formatLocalClock(next)
          const countdown = formatCountdown(next, new Date())
          return (
            <div style={S.nextRun}>
              <span>Next run:</span>
              <span style={S.nextRunClock}>{clock}</span>
              <span style={S.nextRunCountdown}>({countdown})</span>
            </div>
          )
        })()}
        <div style={S.tzRow}>{tzLabel}</div>
        <label
          style={{
            ...S.tzRow,
            cursor: 'pointer', color: 'var(--text)', marginTop: '6px',
          }}
        >
          <input
            type="checkbox"
            checked={useLocalTz}
            onChange={(e) => setUseLocalTz(e.target.checked)}
            style={{ accentColor: 'var(--accent)' }}
          />
          <span>Use my local time ({localTz}) — handles DST automatically</span>
        </label>

        <div style={S.btnRow}>
          <button style={S.btn} onClick={saveSchedule}>Save schedule</button>
          <button
            style={runNowBusy ? S.btnSecondaryBusy : S.btnSecondary}
            onClick={handleRunNow}
            disabled={runNowBusy}
            aria-busy={runNowBusy}
          >
            {runNowBusy ? 'Running…' : 'Run now'}
          </button>
          {scheduleToast && <span style={S.toast}>{scheduleToast}</span>}
          {runNowToast && <span style={S.toast}>{runNowToast}</span>}
          {runNowError && <span style={S.errorToast}>{runNowError}</span>}
        </div>
      </div>
    </div>
  )
}

export default function App({ appId, token }) {
  const [tab, setTab] = useState('reports')
  const [streak, setStreak] = useState(null)

  // Build the storage adapter once per (appId, token) — the same
  // instance is shared between Reports and Settings so a future
  // window.mobius.storage cache (when the offline runtime lands)
  // doesn't get round-tripped twice.
  const storage = useMemo(() => {
    const s = makeStorage(appId, token)
    // The Reports tab's "Run now" path uses the raw token to POST
    // /api/apps/<id>/run-job (not a storage endpoint), so we stash
    // it on the adapter rather than threading another prop. Underscore
    // prefix flags this as an implementation detail, not part of the
    // storage contract callers should reach for.
    s._token = token
    return s
  }, [appId, token])

  // Load streak on mount + refresh when the user re-enters the tab
  // (cheap, and the cron may have updated it in the background).
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const s = await storage.getJSON('streak.json')
      if (!cancelled) setStreak(s || { current: 0, last_active_date: null })
    })()
    return () => { cancelled = true }
  }, [storage, tab])

  const today = todayLocalDateStr()
  const streakActive = streak && (streak.current ?? 0) > 0
  const streakLabel = streakActive
    ? `🔥 ${streak.current} day${streak.current === 1 ? '' : 's'}`
    : 'No streak yet'

  return (
    <div style={S.root}>
      <style>{REPORT_CSS}</style>
      <div style={S.header}>
        <div style={S.titleRow}>
          <h1 style={S.title}>Dreaming</h1>
          <span
            style={streakActive ? S.streakBadge : { ...S.streakBadge, ...S.streakBadgeQuiet }}
            title={streak?.last_active_date
              ? `Last active dream: ${shortDate(streak.last_active_date)}`
              : 'No active dream yet'}
          >
            {streakLabel}
          </span>
          <span style={S.todayLabel}>{shortDate(today)}</span>
        </div>
        <div style={S.tabs}>
          <button style={S.tab(tab === 'reports')} onClick={() => setTab('reports')}>
            Reports
          </button>
          <button style={S.tab(tab === 'settings')} onClick={() => setTab('settings')}>
            Settings
          </button>
        </div>
      </div>
      <div style={S.divider} />
      <div style={S.scroll}>
        {tab === 'reports'
          ? <ReportsTab appId={appId} storage={storage} />
          : <SettingsTab appId={appId} token={token} storage={storage} streak={streak} />}
      </div>
    </div>
  )
}
