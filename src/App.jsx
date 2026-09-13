import { useState, useMemo, useEffect, useCallback, useRef, Fragment } from 'react'
import { createPortal } from 'react-dom'
import { supabase } from './lib/supabase'
import ApprovalPage from './ApprovalPage'
import {
  Users, UserPlus, Calendar, Target, Menu, X, Search,
  Clock, Check, Save, XCircle, Loader2,
  UserCheck, Trash2, LogOut, ArrowLeft, ArrowRight, Eye, Pencil, ChevronDown, ChevronUp, AlertTriangle,
  Mail, MessageSquare, Ban, History, Copy, List
} from 'lucide-react'

// ---------------------------------------------------------------------------
// Fixed pick-lists. These are UI constants (dropdown options), not fake rows —
// swap the arrays' contents to match your real values whenever you confirm them.
// ---------------------------------------------------------------------------
const LEAD_STATUS_OPTIONS = ['New', 'Contacted', 'Unsubscribed']
const NURTURE_STAGE_OPTIONS = ['Cold', 'Warming', 'Outreach', 'Confirmed']
const EVENT_STATUS_OPTIONS = ['Planned', 'Active', 'Completed', 'Cancelled']
const PARTICIPANT_ROLE_OPTIONS = ['Speaker', 'Sponsor', 'Delegate']
const PARTICIPANT_STATUS_OPTIONS = ['Invited', 'Confirmed', 'Attended', 'Cancelled']
const INDUSTRY_OPTIONS = ['Insurance', 'Banking', 'Finance']
const LEAD_PURPOSE_CHOICES = ['Delegate Acquisition', 'Sponsor Acquisition', 'ABM', 'Not Categorized Yet']
// people.owner_email — must exactly match what the Make.com send scenario
// matches against ( alia@ / abdool@ / chris@connectiva.events). A
// free-text input here risks the exact same silent-mismatch bug found
// earlier (a trailing space on one row meant that lead was invisible to
// its assigned persona) — a fixed dropdown makes that class of bug
// impossible to reintroduce by hand.
const OWNER_EMAIL_OPTIONS = [
  'alia@connectiva.events',
  'abdool@connectiva.events',
  'chris@connectiva.events',
]

// ---------------------------------------------------------------------------
// CHANNEL CONTRACT — this must match what the Make.com scenarios actually
// read/write, NOT an arbitrary UI choice. Confirmed against live scenarios:
//
//   Email        -> ready to send when email_campaign = true AND
//                    email_campaign_stage IS NULL
//   Cold calling -> ready to call when cold_calling = true AND
//                    (cold_calling_stage IS NULL OR cold_calling_stage = 'Not Pitched')
//                    ALSO requires a phone number (mobile or phone) and a
//                    linked company (Make's query INNER JOINs companies).
//   Social/LinkedIn -> NOT wired to a confirmed live contract yet (HeyReach
//                    scenario still undecided). Left inert on purpose — the
//                    app does not set its boolean/stage automatically.
//
// Once a lead exists, its *_stage fields are owned by the automations (an AI
// cold-calling agent writes branching outcomes like 'Not Pitched' / 'Send
// Email'; the email scenario writes things like 'email sent' / 'send
// failed'). The CRM must never blind-overwrite these on a routine save, so
// they are shown read-only in the edit view instead of editable dropdowns.
// ---------------------------------------------------------------------------
const CHANNEL_FIELDS = [
  { key: 'cold_calling_stage', boolKey: 'cold_calling', label: 'Cold calling', live: true },
  { key: 'email_campaign_stage', boolKey: 'email_campaign', label: 'Email', live: true },
  { key: 'social_media_stage', boolKey: 'social_media', label: 'Social / LinkedIn', live: false },
]

// Defaults applied when converting people to leads in bulk from the People
// page. Every channel starts ON (meaning: start tracking it) unless turned
// off — either for the whole batch, or as a one-off exception for a
// specific person.
const ALL_CHANNELS_ON = CHANNEL_FIELDS.reduce((acc, cf) => ({ ...acc, [cf.key]: true }), {})

const NAV_ITEMS = [
  { key: 'people', label: 'People', icon: Users },
  { key: 'leads', label: 'Leads', icon: Target },
  { key: 'events', label: 'Events', icon: Calendar },
  { key: 'attendees', label: 'Attendees', icon: UserCheck },
  { key: 'agenda', label: 'Agenda', icon: List },
  { key: 'sponsors', label: 'Sponsors', icon: Target },
  { key: 'display-order', label: 'Display Order', icon: UserCheck },
  { key: 'approval', label: 'Approval', icon: Mail },
  { key: 'create', label: 'Create', icon: UserPlus },
]

const AVATAR_PALETTE = [
  { bg: '#EFE6DC', fg: '#8A5A34' },
  { bg: '#DCE7E3', fg: '#2F6E5C' },
  { bg: '#E4E1F2', fg: '#5B4E9C' },
  { bg: '#F2E3E1', fg: '#A8503E' },
  { bg: '#E1EAF2', fg: '#3A6690' },
]
function avatarStyle(name) {
  let hash = 0
  const s = name || ''
  for (let i = 0; i < s.length; i++) hash = s.charCodeAt(i) + ((hash << 5) - hash)
  return AVATAR_PALETTE[Math.abs(hash) % AVATAR_PALETTE.length]
}
function initials(a, b) {
  return `${(a || ' ')[0]}${(b || ' ')[0]}`.toUpperCase()
}
function formatDate(d) {
  if (!d) return '—'
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}
function formatDateTime(d) {
  if (!d) return '—'
  return new Date(d).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })
}

// ---------------------------------------------------------------------------
// Person Prev/Next navigation — the filtered id list from PeoplePage is
// written to localStorage under a one-off random key ("navKey"), and that
// key travels with the URL (?navKey=...) when a person is opened in a new
// tab. sessionStorage was tried first, but browsers only copy sessionStorage
// into a script-opened tab when it keeps a same-origin opener relationship —
// window.open with 'noopener'/'noreferrer' (needed to stop the new tab
// redirecting the original one) breaks that inheritance, so the new tab saw
// an empty list and silently fell back to an unfiltered rebuild. That's why
// Next used to walk through everyone instead of just, say, Delegate
// Acquisition. localStorage + a URL-carried key sidesteps that entirely.
// ---------------------------------------------------------------------------
const NAV_MANIFEST_KEY = 'crm_person_nav_manifest'

function generateNavKey() {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

function savePersonNavList(navKey, ids) {
  try {
    localStorage.setItem(`crm_person_nav_${navKey}`, JSON.stringify(ids))
    // Keep only the most recent 20 saved lists so localStorage doesn't grow
    // without bound across a long session of opening people in tabs.
    const manifest = JSON.parse(localStorage.getItem(NAV_MANIFEST_KEY) || '[]')
    manifest.push(navKey)
    while (manifest.length > 20) {
      const stale = manifest.shift()
      localStorage.removeItem(`crm_person_nav_${stale}`)
    }
    localStorage.setItem(NAV_MANIFEST_KEY, JSON.stringify(manifest))
  } catch {
    // localStorage unavailable — Prev/Next will just be disabled
  }
}

function getPersonNavNeighbors(navKey, personId) {
  let ids = []
  if (navKey) {
    try {
      ids = JSON.parse(localStorage.getItem(`crm_person_nav_${navKey}`) || '[]')
    } catch {
      ids = []
    }
  }
  const idx = ids.findIndex(id => String(id) === String(personId))
  if (idx === -1) return { previousId: null, nextId: null }
  return {
    previousId: idx > 0 ? ids[idx - 1] : null,
    nextId: idx < ids.length - 1 ? ids[idx + 1] : null,
  }
}

// navIds (optional): the exact ordered list of ids currently on screen
// (i.e. PeoplePage's `filtered`) — saved under a fresh navKey right before
// opening the new tab, with that key appended to the URL, so the new tab's
// Prev/Next always matches what you were actually looking at, including
// the lead purpose filter.
function openPersonInNewTab(personId, navIds) {
  const url = new URL(window.location.href)
  url.searchParams.set('person', personId)
  url.searchParams.delete('prev')
  url.searchParams.delete('next')
  if (navIds) {
    const navKey = generateNavKey()
    savePersonNavList(navKey, navIds)
    url.searchParams.set('navKey', navKey)
  } else {
    url.searchParams.delete('navKey')
  }
  window.open(url.toString(), '_blank', 'noopener,noreferrer')
}

async function buildPersonNavListFromDB() {
  const PAGE = 1000
  let allRows = []
  let from = 0
  while (true) {
    const { data, error } = await supabase
      .from('people')
      .select('person_id')
      .order('created_at', { ascending: false })
      .order('person_id', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) return []
    allRows = allRows.concat(data || [])
    if (!data || data.length < PAGE) break
    from += PAGE
  }

  const { data: leadRows } = await supabase.from('leads').select('person_id')
  const leadIds = new Set((leadRows || []).map(r => r.person_id))

  return allRows.map(r => r.person_id).filter(id => !leadIds.has(id))
}

function externalUrl(u) {
  if (!u) return null
  const trimmed = u.trim()
  if (!trimmed) return null
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
}

const PAGE_SIZE = 15
function paginate(items, page) {
  const start = (page - 1) * PAGE_SIZE
  return items.slice(start, start + PAGE_SIZE)
}
function Pagination({ page, setPage, total }) {
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const [jumpValue, setJumpValue] = useState('')

  const commitJump = () => {
    const n = parseInt(jumpValue, 10)
    if (!Number.isNaN(n)) {
      setPage(Math.min(totalPages, Math.max(1, n)))
    }
    setJumpValue('')
  }

  return (
    <div className="crm-pagination">
      <span>Page {page} of {totalPages} · {total} total</span>
      <button className="crm-page-btn" onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page <= 1}>Prev</button>
      <button className="crm-page-btn" onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page >= totalPages}>Next</button>
      <div className="crm-pagination-jump">
        <input
          type="number"
          min={1}
          max={totalPages}
          className="crm-pagination-jump-input"
          placeholder={`${page}`}
          value={jumpValue}
          onChange={e => setJumpValue(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') commitJump() }}
        />
        <span className="crm-pagination-jump-of">of {totalPages}</span>
        <button className="crm-page-btn" onClick={commitJump}>Go</button>
      </div>
    </div>
  )
}

function FieldLabel({ children }) {
  return <label className="crm-field-label">{children}</label>
}

// Autocomplete company picker — loads the full companies list once, filters
// client-side (case-insensitive substring) as the user types, and lets them
// pick an existing company from a dropdown instead of retyping the name.
// The moment the typed text exactly matches an existing name (any casing),
// company_id is auto-resolved — so "connectiva" while "Connectiva" already
// exists in the DB attaches to the SAME row instead of risking a near-dupe.
// A new company is only ever created when nothing in the list matches at all,
// and even then only on save (see saveEdit/save's ilike-then-insert fallback).
function CompanyPicker({ value, onChange, showToast }) {
  const [query, setQuery] = useState(value?.company_name || '')
  const [companies, setCompanies] = useState([])
  const [loaded, setLoaded] = useState(false)
  const [open, setOpen] = useState(false)
  const [showEdit, setShowEdit] = useState(false)
  const [coords, setCoords] = useState(null)
  const wrapRef = useRef(null)
  const inputRef = useRef(null)

  useEffect(() => {
    setQuery(value?.company_name || '')
  }, [value?.company_id, value?.company_name])

useEffect(() => {
  if (loaded) return
  ;(async () => {
    const PAGE = 1000
    let allRows = []
    let from = 0
    while (true) {
      const { data, error } = await supabase
        .from('companies')
        .select('company_id, company_name, country')
        .order('company_name', { ascending: true })
        .range(from, from + PAGE - 1)
      if (error) break
      allRows = allRows.concat(data || [])
      if (!data || data.length < PAGE) break
      from += PAGE
    }
    setCompanies(allRows)
    setLoaded(true)
  })()
}, [loaded])

  // Recompute the dropdown's screen position (viewport-relative, since we
  // use position:fixed) any time it opens, and keep it in sync on scroll —
  // including scrolling INSIDE the table wrapper, since that's the ancestor
  // that used to clip this dropdown.
  const updateCoords = useCallback(() => {
    if (!inputRef.current) return
    const r = inputRef.current.getBoundingClientRect()
    setCoords({ top: r.bottom + 4, left: r.left, width: r.width })
  }, [])

  useEffect(() => {
    if (!open) return
    updateCoords()
    const onScrollOrResize = () => updateCoords()
    // capture:true so this fires on scroll of ANY ancestor, not just window
    // (e.g. the .crm-table-wrap's own overflow:auto scroll).
    window.addEventListener('scroll', onScrollOrResize, true)
    window.addEventListener('resize', onScrollOrResize)
    return () => {
      window.removeEventListener('scroll', onScrollOrResize, true)
      window.removeEventListener('resize', onScrollOrResize)
    }
  }, [open, updateCoords])

  useEffect(() => {
    const onClickOutside = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target) &&
          !e.target.closest('.crm-company-dropdown')) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onClickOutside)
    return () => document.removeEventListener('mousedown', onClickOutside)
  }, [])

  const q = query.trim().toLowerCase()
  const matches = q
    ? companies.filter(c => (c.company_name || '').toLowerCase().includes(q))
    : companies

  const exactMatch = companies.find(c => (c.company_name || '').toLowerCase() === q)
  const isExistingCompany = !!value?.company_id
  const isNewCompany = q.length > 0 && !isExistingCompany

  const selectCompany = (c) => {
    setQuery(c.company_name)
    onChange({ company_id: c.company_id, company_name: c.company_name, country: c.country || '' })
    setOpen(false)
  }

  const handleChange = (e) => {
    const v = e.target.value
    setQuery(v)
    setOpen(true)
    updateCoords()
    const exact = companies.find(c => (c.company_name || '').toLowerCase() === v.trim().toLowerCase())
    if (!v.trim()) {
      onChange(null)
      return
    }
    onChange(
      exact
        ? { company_id: exact.company_id, company_name: v, country: exact.country || '' }
        : { company_id: null, company_name: v, country: value?.country || '' }
    )
  }

  const handleCountryChange = (e) => {
    onChange({ company_id: value?.company_id || null, company_name: query, country: e.target.value })
  }

  const handleCompanySaved = (updated) => {
    setQuery(updated.company_name)
    onChange(updated)
    setCompanies(prev => prev.map(c => (c.company_id === updated.company_id ? { ...c, ...updated } : c)))
  }

  return (
    <div ref={wrapRef} className="crm-company-picker">
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <input
          ref={inputRef}
          className="crm-input"
          value={query}
          placeholder="Company name"
          onChange={handleChange}
          onFocus={() => { setOpen(true); updateCoords() }}
          style={{ flex: 1 }}
        />
        {isExistingCompany && (
          <button
            type="button"
            className="crm-icon-action"
            onClick={() => setShowEdit(true)}
            title="Edit this company"
            aria-label="Edit this company"
          >
            <Pencil size={14} />
          </button>
        )}
      </div>

      {isNewCompany && (
        <input
          className="crm-input"
          style={{ marginTop: 6 }}
          value={value?.country || ''}
          onChange={handleCountryChange}
          placeholder="Country (new company)"
        />
      )}

      {open && coords && (matches.length > 0 || (q && !exactMatch)) && createPortal(
        <div
          className="crm-company-dropdown"
          style={{ position: 'fixed', top: coords.top, left: coords.left, width: coords.width, right: 'auto' }}
        >
          {matches.map(c => {
            const isExact = (c.company_name || '').toLowerCase() === q
            return (
              <div
                key={c.company_id}
                className={`crm-company-dropdown-item${isExact ? ' exact' : ''}`}
                onMouseDown={() => selectCompany(c)}
              >
                {c.company_name}{c.country ? ` — ${c.country}` : ''}
              </div>
            )
          })}
          {q && !exactMatch && (
            <div
              className="crm-company-dropdown-create"
              onMouseDown={() => setOpen(false)}
            >
              + Create new company "{query.trim()}"
            </div>
          )}
        </div>,
        document.body
      )}

      {showEdit && isExistingCompany && (
        <CompanyEditModal
          company={{ company_id: value.company_id, company_name: value.company_name, country: value.country }}
          onClose={() => setShowEdit(false)}
          onSaved={handleCompanySaved}
          showToast={showToast}
        />
      )}
    </div>
  )
}

// ----------------------------------------------------------------------------
// Edit an EXISTING company row directly — since companies is its own table
// linked by company_id FK, this updates the shared row once and every person
// pointing at that company_id reflects it immediately. No cascade needed.
// ----------------------------------------------------------------------------
function CompanyEditModal({ company, onClose, onSaved, showToast }) {
  const [name, setName] = useState(company.company_name || '')
  const [country, setCountry] = useState(company.country || '')
  const [saving, setSaving] = useState(false)

  const save = async () => {
    if (!name.trim()) return
    setSaving(true)
    const { error } = await supabase
      .from('companies')
      .update({ company_name: name.trim(), country: country.trim() || null, updated_at: new Date().toISOString(),
              })
      .eq('company_id', company.company_id)
    setSaving(false)
    if (error) {
      showToast && showToast(`Couldn't update company: ${error.message}`, true)
      return
    }
    showToast && showToast("Company updated — reflected everywhere it's linked")
    onSaved({ company_id: company.company_id, company_name: name.trim(), country: country.trim() })
    onClose()
  }

  return (
    <div className="crm-modal-overlay">
      <div className="crm-modal-backdrop" onClick={onClose} />
      <div className="crm-modal-card" style={{ maxWidth: 400 }}>
        <h4 className="crm-confirm-heading">Edit company</h4>
        <p className="crm-confirm-note">
          Updates the shared record — every person linked to this company reflects it immediately.
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <FieldLabel>Company name</FieldLabel>
            <input className="crm-input" value={name} onChange={e => setName(e.target.value)} />
          </div>
          <div>
            <FieldLabel>Country</FieldLabel>
            <input className="crm-input" value={country} onChange={e => setCountry(e.target.value)} />
          </div>
        </div>
        <div className="crm-confirm-actions" style={{ marginTop: 18 }}>
          <button className="crm-btn-secondary" onClick={onClose} disabled={saving}>Cancel</button>
          <button
            className="crm-submit-btn"
            style={{ width: 'auto', padding: '10px 20px' }}
            onClick={save}
            disabled={saving || !name.trim()}
          >
            {saving ? <Loader2 size={15} className="crm-spin" /> : <Save size={15} />} Save
          </button>
        </div>
      </div>
    </div>
  )
}
// ---------------------------------------------------------------------------
// Styles — plain CSS, no Tailwind dependency.
// ---------------------------------------------------------------------------
const CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600&family=Inter:wght@400;500;600;700&display=swap');

  html, body, #root { margin: 0; padding: 0; height: 100%; width: 100%; }

  .crm-root {
    --ink-950: #14161C; --ink-900: #1D2027; --ink-700: #4A4F5A; --ink-400: #8A8F99;
    --paper: #F6F5F1; --surface: #FFFFFF; --line: #E7E4DD;
    --accent: #0E6F5C; --accent-soft: #E3EFEA; --accent-ink: #0B5647;
    --amber: #B8862E; --amber-soft: #F3E9D6;
    --red: #B23A3A; --red-soft: #F5E3E1;
    --navy: #081026; --navy-2: #0C1530;
    font-family: Inter, ui-sans-serif, system-ui, sans-serif;
    background: var(--paper); color: var(--ink-900);
    height: 100vh; width: 100%; display: flex; overflow: hidden; box-sizing: border-box;
  }
  .crm-root *, .crm-root *::before, .crm-root *::after { box-sizing: border-box; }
  .crm-display { font-family: 'Fraunces', serif; }

  .crm-sidebar { display: none; flex-direction: column; flex-shrink: 0; background: var(--navy); width: 248px; transition: width .2s ease; }
  .crm-sidebar.collapsed { width: 76px; }
  @media (min-width: 860px) { .crm-sidebar { display: flex; } }
  .crm-sidebar-head { display: flex; align-items: center; justify-content: space-between; padding: 24px 20px; }
  .crm-logo { font-family: 'Fraunces', serif; font-size: 20px; letter-spacing: -0.02em; color: #F4F3EF; white-space: nowrap; }
  .crm-logo span { color: #7FD1B9; }
  .crm-logo-dot { width: 28px; height: 28px; border-radius: 8px; background: #7FD1B9; }
  .crm-icon-btn { width: 32px; height: 32px; border-radius: 8px; border: none; background: transparent; color: #9AA0AC; display: flex; align-items: center; justify-content: center; cursor: pointer; }
  .crm-icon-btn:hover { background: rgba(255,255,255,0.06); }
  .crm-nav { flex: 1; padding: 0 12px; display: flex; flex-direction: column; gap: 4px; }
  .crm-nav-btn { display: flex; align-items: center; gap: 12px; width: 100%; padding: 10px 12px; border-radius: 10px; border: none; cursor: pointer; font-size: 13.5px; font-weight: 500; background: transparent; color: #B7BBC4; transition: background-color .15s ease, color .15s ease; text-align: left; }
  .crm-nav-btn.collapsed { justify-content: center; }
  .crm-nav-btn.active { background: rgba(127,209,185,0.14); color: #7FD1B9; }
  .crm-nav-btn:hover:not(.active) { background: rgba(255,255,255,0.05); }
  .crm-sidebar-foot { padding: 18px 20px; font-size: 11px; color: #5B5F69; border-top: 1px solid rgba(255,255,255,0.06); }

  .crm-drawer-overlay { display: none; position: fixed; inset: 0; z-index: 40; }
  .crm-drawer-overlay.open { display: flex; }
  .crm-drawer-backdrop { position: absolute; inset: 0; background: rgba(0,0,0,0.4); }
  .crm-drawer-panel { position: relative; width: 240px; display: flex; flex-direction: column; background: var(--navy); }
  @media (min-width: 860px) { .crm-drawer-overlay { display: none !important; } }

  .crm-main { flex: 1; display: flex; flex-direction: column; min-width: 0; }
  .crm-header { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 20px 20px; border-bottom: 1px solid var(--line); background: var(--surface); flex-shrink: 0; }
  @media (min-width: 860px) { .crm-header { padding: 20px 36px; } }
  .crm-header-left { display: flex; align-items: center; gap: 12px; min-width: 0; }
  .crm-mobile-menu-btn { display: flex; flex-shrink: 0; width: 36px; height: 36px; align-items: center; justify-content: center; border-radius: 8px; border: 1px solid var(--line); background: var(--surface); cursor: pointer; }
  @media (min-width: 860px) { .crm-mobile-menu-btn { display: none; } }
  .crm-back-btn { display: flex; flex-shrink: 0; width: 36px; height: 36px; align-items: center; justify-content: center; border-radius: 8px; border: 1px solid var(--line); background: var(--surface); cursor: pointer; color: var(--ink-700); }
  .crm-back-btn:hover { background: var(--paper); }
  .crm-page-title { font-size: 24px; line-height: 1.2; color: var(--ink-950); margin: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  @media (min-width: 860px) { .crm-page-title { font-size: 28px; } }
  .crm-page-sub { font-size: 13px; color: var(--ink-400); margin: 2px 0 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .crm-header-right { display: flex; align-items: center; gap: 12px; flex-shrink: 0; }
  .crm-user-avatar { width: 36px; height: 36px; border-radius: 999px; display: flex; align-items: center; justify-content: center; font-size: 13px; font-weight: 600; background: var(--accent-soft); color: var(--accent-ink); flex-shrink: 0; }

  .crm-content { flex: 1; overflow: auto; padding: 24px 20px; }
  @media (min-width: 860px) { .crm-content { padding: 28px 36px; } }

  .crm-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin-bottom: 18px; }
  .crm-search-box { display: flex; align-items: center; gap: 8px; padding: 9px 14px; border-radius: 999px; border: 1px solid var(--line); background: var(--surface); flex: 1; min-width: 220px; }
  .crm-search-box input { background: transparent; border: none; outline: none; font-size: 13.5px; color: var(--ink-900); width: 100%; }
  .crm-filter-select { padding: 9px 14px; border-radius: 999px; border: 1px solid var(--line); background: var(--surface); font-size: 13px; color: var(--ink-700); cursor: pointer; }
  .crm-toggle-chip { display: flex; align-items: center; gap: 7px; padding: 9px 14px; border-radius: 999px; border: 1px solid var(--line); background: var(--surface); font-size: 13px; color: var(--ink-700); cursor: pointer; user-select: none; }
  .crm-toggle-chip.on { background: var(--accent-soft); color: var(--accent-ink); border-color: transparent; }
  .crm-count-note { font-size: 12.5px; color: var(--ink-400); margin-left: auto; white-space: nowrap; }

  .crm-pagination { display: flex; align-items: center; gap: 10px; justify-content: flex-end; padding: 12px 4px; font-size: 13px; color: var(--ink-700); }
  .crm-page-btn { padding: 6px 12px; border-radius: 8px; border: 1px solid var(--line); background: var(--surface); cursor: pointer; font-size: 13px; }
  .crm-page-btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .crm-pagination-jump { display: flex; align-items: center; gap: 6px; margin-left: 6px; }
  .crm-pagination-jump-input { width: 56px; padding: 6px 8px; border-radius: 8px; border: 1px solid var(--line); font-size: 13px; font-family: inherit; text-align: center; outline: none; }
  .crm-pagination-jump-input:focus { border-color: var(--accent); }
  .crm-pagination-jump-of { font-size: 12.5px; color: var(--ink-400); white-space: nowrap; }
  
  .crm-table-wrap { border: 1px solid var(--line); background: var(--surface); border-radius: 16px; overflow: auto; }
  .crm-table { width: 100%; font-size: 13.5px; border-collapse: collapse; min-width: 760px; }
  .crm-table thead tr { border-bottom: 1px solid var(--line); }
  .crm-table th { text-align: left; padding: 12px 18px; font-weight: 500; font-size: 11px; text-transform: uppercase; letter-spacing: 0.03em; color: var(--ink-400); white-space: nowrap; }
  .crm-table td { padding: 10px 18px; border-bottom: 1px solid var(--line); color: var(--ink-700); vertical-align: middle; }
  .crm-table tbody tr:hover td { background: #FAFAF8; }
  .crm-table tbody tr.editing td { background: var(--accent-soft); }
  .crm-table tbody tr.clickable { cursor: pointer; }
  .crm-table tbody tr.disabled { opacity: 0.45; cursor: not-allowed; }
  .crm-table tbody tr.disabled:hover td { background: inherit; }
  .crm-table tbody tr:last-child td { border-bottom: none; }
  .crm-name-cell { display: flex; align-items: center; gap: 10px; font-weight: 500; color: var(--ink-950); }
  .crm-empty-row td { text-align: center; padding: 40px 24px; color: var(--ink-400); }
  .crm-avatar { width: 32px; height: 32px; border-radius: 999px; display: flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 600; flex-shrink: 0; }

  .crm-company-picker { position: relative; }
 .crm-company-dropdown {
  position: fixed; z-index: 999;
  background: var(--surface, #FFFFFF);
  border: 1px solid var(--line, #E7E4DD);
  border-radius: 10px;
  box-shadow: 0 8px 24px rgba(0,0,0,0.12);
  max-height: 220px; overflow-y: auto;
}
  .crm-company-dropdown-item {
  padding: 9px 14px; font-size: 13.5px;
  color: var(--ink-900, #1D2027); cursor: pointer;
}
 .crm-company-dropdown-item:hover { background: var(--paper, #F6F5F1); }
.crm-company-dropdown-item.exact { color: var(--accent-ink, #0B5647); font-weight: 500; }
.crm-company-dropdown-create {
  padding: 9px 14px; font-size: 13px;
  color: var(--accent-ink, #0B5647); cursor: pointer;
  border-top: 1px solid var(--line, #E7E4DD); font-weight: 500;
}
.crm-company-dropdown-create:hover { background: var(--accent-soft, #E3EFEA); }

  .crm-cell-input { width: 100%; min-width: 90px; padding: 6px 8px; border-radius: 6px; border: 1px solid var(--line); font-size: 13px; font-family: inherit; outline: none; }
  .crm-cell-input:focus { border-color: var(--accent); }
  .crm-cell-input + .crm-cell-input { margin-top: 4px; }
  .crm-cell-select { width: 100%; padding: 6px 8px; border-radius: 6px; border: 1px solid var(--line); font-size: 13px; font-family: inherit; background: #fff; }
  .crm-row-actions { display: flex; gap: 6px; white-space: nowrap; }
  .crm-icon-action { width: 28px; height: 28px; border-radius: 7px; border: 1px solid var(--line); background: var(--surface); display: flex; align-items: center; justify-content: center; cursor: pointer; }
  .crm-icon-action:hover { background: var(--paper); }
  .crm-icon-action.save { color: var(--accent-ink); border-color: var(--accent); }
  .crm-icon-action.cancel { color: var(--red); }
  .crm-badge { font-size: 11px; font-weight: 500; padding: 3px 9px; border-radius: 999px; white-space: nowrap; }
  .crm-lead-tag { font-size: 10.5px; font-weight: 600; color: var(--accent-ink); background: var(--accent-soft); padding: 2px 8px; border-radius: 999px; margin-left: 8px; white-space: nowrap; }
  .crm-muted { color: var(--ink-400); font-size: 12.5px; }
  .crm-history-tag {
    font-size: 11.5px;
    padding: 3px 8px;
    border-radius: 999px;
    background: var(--paper);
    border: 1px solid var(--line);
    color: var(--ink-700);
    cursor: help;
  }
  .crm-spin { animation: crm-spin-kf 0.8s linear infinite; }
  @keyframes crm-spin-kf { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }

  .crm-loading, .crm-error { display: flex; align-items: center; gap: 8px; padding: 40px 0; justify-content: center; color: var(--ink-400); font-size: 14px; }
  .crm-error { color: var(--red); }

  .crm-create-wrap { max-width: 560px; }
  .crm-tabs { display: inline-flex; gap: 4px; padding: 4px; border-radius: 999px; background: var(--surface); border: 1px solid var(--line); margin-bottom: 24px; }
  .crm-tab-btn { padding: 7px 16px; border-radius: 999px; border: none; font-size: 13.5px; font-weight: 500; background: transparent; color: var(--ink-700); cursor: pointer; }
  .crm-tab-btn.active { background: var(--navy); color: #F4F3EF; }
  .crm-form { display: flex; flex-direction: column; gap: 16px; border: 1px solid var(--line); background: var(--surface); border-radius: 16px; padding: 24px; }
  .crm-form-row { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  .crm-field-label { display: block; font-size: 11px; font-weight: 500; text-transform: uppercase; letter-spacing: 0.03em; color: var(--ink-400); margin-bottom: 6px; }
  .crm-input, .crm-select, .crm-textarea { width: 100%; padding: 10px 14px; border-radius: 10px; font-size: 13.5px; outline: none; border: 1px solid var(--line); background: var(--surface); color: var(--ink-900); font-family: inherit; }
  .crm-textarea { resize: vertical; min-height: 70px; }
  .crm-input:focus, .crm-select:focus, .crm-textarea:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
  .crm-submit-btn { display: flex; align-items: center; justify-content: center; gap: 6px; width: 100%; padding: 11px; border-radius: 10px; border: none; font-size: 13.5px; font-weight: 500; background: var(--navy); color: #fff; cursor: pointer; }
  .crm-submit-btn:hover { filter: brightness(1.3); }
  .crm-submit-btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .crm-checkbox-row { display: flex; align-items: center; gap: 8px; font-size: 13.5px; color: var(--ink-700); }

  .crm-toast { position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%); z-index: 50; display: flex; align-items: center; gap: 8px; padding: 10px 18px; border-radius: 999px; background: var(--navy); color: #fff; font-size: 13.5px; box-shadow: 0 8px 24px rgba(0,0,0,0.2); }
  .crm-toast.error { background: var(--red); }
  .crm-toast-undo { background: none; border: 1px solid rgba(255,255,255,0.35); color: #fff; border-radius: 999px; padding: 4px 12px; font-size: 12.5px; cursor: pointer; margin-left: 4px; }
  .crm-toast-undo:hover { background: rgba(255,255,255,0.12); }

  /* ---------- Confirm-selection step (Attendees add / People convert-to-lead) ---------- */
  .crm-confirm-wrap { border: 1px solid var(--line); background: var(--surface); border-radius: 16px; padding: 20px; }
  .crm-confirm-heading { font-size: 14px; font-weight: 600; color: var(--ink-950); margin: 0 0 4px; }
  .crm-confirm-note { font-size: 12.5px; color: var(--ink-400); margin: 0 0 16px; }
  .crm-confirm-summary { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 16px; }
  .crm-confirm-summary-item { font-size: 12.5px; padding: 6px 12px; border-radius: 999px; background: var(--paper); border: 1px solid var(--line); color: var(--ink-700); }
  .crm-confirm-summary-item b { color: var(--ink-950); }
  .crm-confirm-list { border: 1px solid var(--line); border-radius: 12px; overflow-y: auto; max-height: 320px; margin-bottom: 18px; }
  .crm-confirm-row { display: flex; align-items: center; justify-content: space-between; padding: 10px 14px; border-bottom: 1px solid var(--line); }
  .crm-confirm-row:last-child { border-bottom: none; }
  .crm-confirm-row-name { font-weight: 500; color: var(--ink-950); font-size: 13.5px; }
  .crm-confirm-row-sub { font-size: 12px; color: var(--ink-400); }
  .crm-confirm-actions { display: flex; gap: 10px; }
  .crm-btn-secondary { padding: 10px 18px; border-radius: 10px; border: 1px solid var(--line); background: var(--surface); font-size: 13.5px; font-weight: 500; cursor: pointer; color: var(--ink-700); }
  .crm-btn-secondary:hover { background: var(--paper); }
  .crm-remove-x { width: 26px; height: 26px; border-radius: 7px; border: none; background: transparent; color: var(--ink-400); cursor: pointer; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
  .crm-remove-x:hover { background: var(--red-soft); color: var(--red); }
  .crm-confirm-empty { padding: 30px; text-align: center; color: var(--ink-400); font-size: 13.5px; }

  .crm-selection-bar { position: sticky; top: 0; z-index: 6; display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 16px; border-radius: 12px; background: var(--accent-soft); border: 1px solid var(--accent); margin-bottom: 14px; box-shadow: 0 4px 14px rgba(14,111,92,0.12); }
  .crm-selection-bar-count { font-size: 13.5px; font-weight: 600; color: var(--accent-ink); }
  .crm-selection-bar-actions { display: flex; align-items: center; gap: 8px; }
  .crm-selection-confirm-btn { display: flex; align-items: center; gap: 6px; padding: 9px 18px; border-radius: 10px; border: none; font-size: 13.5px; font-weight: 600; background: var(--accent-ink); color: #fff; cursor: pointer; }
  .crm-selection-confirm-btn:hover { filter: brightness(1.1); }

  /* ---------- Detail pages (Person / Lead) ---------- */
  .crm-detail-wrap { max-width: 720px; }
  .crm-detail-top { display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; margin-bottom: 4px; }
  .crm-channel-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; }
  .crm-channel-status-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 10px; padding-top: 10px; margin-top: 4px; border-top: 1px solid var(--line); }
  .crm-channel-status-label { font-size: 10.5px; color: var(--ink-400); text-transform: uppercase; letter-spacing: 0.03em; margin-bottom: 5px; }
  .crm-channel-readonly { border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; background: var(--paper); }
  .crm-channel-readonly-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 6px; }
  .crm-channel-note { font-size: 11.5px; color: var(--ink-400); margin-top: 8px; line-height: 1.4; }
  .crm-warn-note { display: flex; align-items: flex-start; gap: 6px; font-size: 11.5px; color: var(--amber); background: var(--amber-soft); border-radius: 8px; padding: 6px 9px; margin-top: 6px; }

  /* ---------- Activity timeline (Lead detail) ---------- */
  .crm-activity-list { display: flex; flex-direction: column; }
  .crm-activity-item { display: flex; gap: 12px; padding: 12px 0; border-bottom: 1px solid var(--line); }
  .crm-activity-item:last-child { border-bottom: none; padding-bottom: 0; }
  .crm-activity-item:first-child { padding-top: 0; }
  .crm-activity-icon { width: 30px; height: 30px; border-radius: 999px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
  .crm-activity-body { flex: 1; min-width: 0; }
  .crm-activity-top { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
  .crm-activity-type { font-size: 13px; font-weight: 600; color: var(--ink-950); }
  .crm-activity-date { font-size: 11.5px; color: var(--ink-400); white-space: nowrap; flex-shrink: 0; }
  .crm-activity-summary { font-size: 12.5px; color: var(--ink-700); margin-top: 3px; line-height: 1.5; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }

  /* ---------- People page: side-by-side convert-to-lead panel ---------- */
  .crm-split-layout { display: flex; gap: 20px; align-items: flex-start; }
  .crm-split-main { flex: 1; min-width: 0; }
  .crm-split-side { width: 320px; flex-shrink: 0; position: sticky; top: 0; }
  @media (max-width: 980px) { .crm-split-layout { flex-direction: column; } .crm-split-side { width: 100%; position: static; } }
  .crm-side-panel { border: 1px solid var(--line); background: var(--surface); border-radius: 16px; padding: 18px; }
  .crm-channel-toggles { display: flex; gap: 8px; flex-wrap: wrap; }
  .crm-channel-toggle { display: flex; align-items: center; gap: 5px; font-size: 11px; padding: 4px 9px; border-radius: 999px; border: 1px solid var(--accent); background: var(--accent-soft); color: var(--accent-ink); cursor: pointer; user-select: none; white-space: nowrap; }
  .crm-channel-toggle.off { border-color: var(--line); background: var(--paper); color: var(--ink-400); }
  .crm-channel-toggle.disabled-live { opacity: 0.5; cursor: not-allowed; }

 /* ---------- Quick convert-to-lead modal (person detail page) ---------- */
  .crm-modal-overlay { position: fixed; inset: 0; z-index: 60; display: flex; align-items: center; justify-content: center; padding: 20px; }
  .crm-modal-backdrop { position: absolute; inset: 0; background: rgba(0,0,0,0.45); }
  .crm-modal-card { position: relative; background: var(--surface); border-radius: 16px; padding: 24px; width: 100%; max-width: 480px; max-height: 88vh; overflow: auto; box-shadow: 0 20px 60px rgba(0,0,0,0.28); }

  /* ---------- Leads page: event picker (step 1) ---------- */
  .crm-event-picker-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 14px; }
  .crm-event-picker-card {
    display: flex; flex-direction: column; gap: 10px; text-align: left;
    padding: 18px; border-radius: 14px; border: 1px solid var(--line);
    background: var(--surface); cursor: pointer; font-family: inherit;
    transition: border-color .15s ease, box-shadow .15s ease, transform .15s ease;
  }
  .crm-event-picker-card:hover { border-color: var(--accent); box-shadow: 0 6px 18px rgba(14,111,92,0.12); transform: translateY(-1px); }
  .crm-event-picker-card-top { display: flex; align-items: center; justify-content: space-between; }
  .crm-event-picker-card-icon { width: 30px; height: 30px; border-radius: 9px; display: flex; align-items: center; justify-content: center; background: var(--accent-soft); color: var(--accent-ink); flex-shrink: 0; }
  .crm-event-picker-card-name { font-size: 14.5px; font-weight: 600; color: var(--ink-950); line-height: 1.3; }
  .crm-event-picker-card-date { font-size: 12px; color: var(--ink-400); display: flex; align-items: center; }

  /* ---------- Notes column truncation (People / Leads tables) ---------- */
  .crm-notes-cell { max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: help; }

  /* ---------- Company / Country sort toggles (People page) ---------- */
  .crm-sort-btns { display: flex; flex-direction: column; gap: 1px; flex-shrink: 0; }
  .crm-sort-btn { border: none; background: transparent; padding: 0; margin: 0; line-height: 0; color: var(--ink-400); cursor: pointer; display: flex; align-items: center; justify-content: center; }
  .crm-sort-btn:hover { color: var(--ink-700); }
  .crm-sort-btn.active { color: var(--accent-ink); }

  .crm-sort-text-btn {
  font-size: 10px;
  font-weight: 600;
  padding: 3px 6px;
  border-radius: 6px;
  border: 1px solid var(--line);
  background: var(--surface);
  color: var(--ink-700);
  cursor: pointer;
  white-space: nowrap;
  line-height: 1;
}
.crm-sort-text-btn:hover { background: var(--paper); }
.crm-sort-text-btn.active { background: var(--accent-soft); color: var(--accent-ink); border-color: var(--accent); }
`

// ---------------------------------------------------------------------------
// Status/stage badge coloring — purely presentational. Uses keyword matching
// rather than an exact-match whitelist, because the automations (Make.com
// scenarios + the AI cold-calling agent) write values the CRM doesn't fully
// control the vocabulary of (e.g. "email sent", "Not Pitched", "Send Email",
// "sent_to_heyreach"). Exact-match-only badges silently fall through to a
// generic color the moment automation writes something new — keyword
// matching degrades more gracefully.
// ---------------------------------------------------------------------------
function badgeTone(value) {
  const v = (value || '').toLowerCase()

  if (['converted', 'accepted', 'success'].some(k => v === k))
    return { bg: 'var(--accent-ink)', fg: '#fff' }

  if (v.includes('fail') || v.includes('declined') || v === 'unsubscribed')
    return { bg: 'var(--red-soft)', fg: 'var(--red)' }

  if (['not pitched', 'not started', 'new', 'cold', 'waiting'].some(k => v === k))
    return { bg: 'var(--line)', fg: 'var(--ink-700)' }

  if (v.includes('sent') || v.includes('replied') || v.includes('progress') || v.includes('connect') ||
      ['contacted', 'warming', 'outreach', 'responded', 'send email'].some(k => v === k))
    return { bg: 'var(--accent-soft)', fg: 'var(--accent-ink)' }

  if (!v) return null
  return { bg: 'var(--amber-soft)', fg: 'var(--amber)' }
}
function Badge({ value }) {
  if (!value) return <span style={{ color: 'var(--ink-400)' }}>—</span>
  const tone = badgeTone(value)
  return <span className="crm-badge" style={{ background: tone.bg, color: tone.fg }}>{value}</span>
}

// ---------------------------------------------------------------------------
// Activity timeline helpers — activity_type values are written by the
// Make.com "Email Track Reply" scenario ('email_sent' from the send
// scenario, 'Reply', 'Unsubscribe', 'Email Bounced' from the reply-tracking
// one). Icon/tone mapping degrades gracefully (falls back to a generic
// clock icon + neutral tone) for any future activity_type the automations
// start writing that the CRM doesn't explicitly know about yet.
// ---------------------------------------------------------------------------
const ACTIVITY_ICON_MAP = {
  email_sent: Mail,
  'Reply': MessageSquare,
  'Unsubscribe': Ban,
  'Email Bounced': AlertTriangle,
}
function activityIcon(type) {
  return ACTIVITY_ICON_MAP[type] || History
}
function activityTone(type) {
  if (type === 'Email Bounced') return { bg: 'var(--red-soft)', fg: 'var(--red)' }
  if (type === 'Unsubscribe') return { bg: 'var(--amber-soft)', fg: 'var(--amber)' }
  if (type === 'Reply') return { bg: 'var(--accent-soft)', fg: 'var(--accent-ink)' }
  return { bg: 'var(--line)', fg: 'var(--ink-700)' }
}

// Sticky bar that appears the instant one or more rows are selected, pinned
// to the top of the scroll area, so the "review & confirm" action never
// requires scrolling past the candidate table to find it.
function SelectionBar({ count, noun = 'selected', label, onConfirm }) {
  if (count === 0) return null
  return (
    <div className="crm-selection-bar">
      <span className="crm-selection-bar-count">{count} {noun}</span>
      <div className="crm-selection-bar-actions">
        <button className="crm-selection-confirm-btn" onClick={onConfirm}>
          <Check size={15} /> {label}
        </button>
      </div>
    </div>
  )
}

// Shared review step: show exactly who's about to be affected and the bulk
// field values that will be applied, let the person drop individuals before
// committing, then Confirm or go Back to keep adjusting the selection.
function ConfirmSelectionPanel({ heading, note, items, summary, onRemove, onConfirm, onBack, confirming, confirmLabel }) {
  return (
    <div className="crm-confirm-wrap">
      <h4 className="crm-confirm-heading">{heading}</h4>
      {note && <p className="crm-confirm-note">{note}</p>}

      {summary && summary.length > 0 && (
        <div className="crm-confirm-summary">
          {summary.map((s, i) => (
            <span key={i} className="crm-confirm-summary-item">{s.label}: <b>{s.value}</b></span>
          ))}
        </div>
      )}

      <div className="crm-confirm-list">
        {items.map(item => (
          <div key={item.id} className="crm-confirm-row">
            <div>
              <div className="crm-confirm-row-name">{item.primary}</div>
              {item.secondary && <div className="crm-confirm-row-sub">{item.secondary}</div>}
              {item.warning && <div className="crm-warn-note"><AlertTriangle size={12} style={{ flexShrink: 0, marginTop: 1 }} />{item.warning}</div>}
            </div>
            <button className="crm-remove-x" onClick={() => onRemove(item.id)} aria-label={`Remove ${item.primary}`}>
              <X size={14} />
            </button>
          </div>
        ))}
        {items.length === 0 && <div className="crm-confirm-empty">Nothing left selected — go back to pick people.</div>}
      </div>

      <div className="crm-confirm-actions">
        <button className="crm-btn-secondary" onClick={onBack}>Back to editing</button>
        <button className="crm-submit-btn" style={{ width: 'auto', padding: '10px 20px' }} onClick={onConfirm} disabled={items.length === 0 || confirming}>
          {confirming ? <Loader2 size={15} className="crm-spin" /> : <Check size={15} />}
          {confirmLabel}
        </button>
      </div>
    </div>
  )
}

// Builds the actual DB row fields for the channels that are effectively "on"
// for a given person, following the confirmed Make.com contract: set the
// boolean true and leave the stage column NULL. Never write a placeholder
// string like 'Not started' into a stage column — that's what silently hides
// leads from the Make.com scenarios that key off IS NULL.
function buildChannelRowFields(effectiveOnFn, subjectKey) {
  const fields = {}
  CHANNEL_FIELDS.forEach(cf => {
    if (!cf.live) return 
    if (effectiveOnFn(subjectKey, cf.key)) {
      fields[cf.boolKey] = true
      fields[cf.key] = null
    }
  })
  return fields
}

// Warnings shown when a person is missing what a live channel's Make.com
// scenario actually requires to pick the lead up at all. Cold calling's
// query INNER JOINs companies and requires COALESCE(mobile, phone) IS NOT
// NULL — a lead can be created "successfully" and still be permanently
// invisible to that scenario if these are missing.
function channelReadinessWarning(person, channelKey) {
  if (channelKey === 'cold_calling_stage') {
    const missing = []
    if (!person.mobile && !person.phone) missing.push('no phone number')
    if (!person.company_id) missing.push('no company linked')
    if (missing.length > 0) return `Cold calling won't reach them yet — ${missing.join(', ')}.`
  }
  return null
}

async function resolveCompanyId(companyInput) {
  if (!companyInput) return { companyId: null, error: null }

  if (companyInput.company_id) {
    const { error } = await supabase
      .from('companies')
      .update({
        company_name: companyInput.company_name?.trim() || null,
        country: companyInput.country?.trim() || null,
        updated_at: new Date().toISOString(),
      })
      .eq('company_id', companyInput.company_id)
    if (error) return { companyId: null, error }
    return { companyId: companyInput.company_id, error: null }
  }

  const name = companyInput.company_name?.trim()
  if (!name) return { companyId: null, error: null }

  const { data: existing, error: lookupError } = await supabase
    .from('companies')
    .select('company_id')
    .ilike('company_name', name)
    .limit(1)
    .maybeSingle()
  if (lookupError) return { companyId: null, error: lookupError }

  if (existing) {
    return { companyId: existing.company_id, error: null }
  }

  const { data: created, error: createError } = await supabase
    .from('companies')
    .insert({ company_name: name, country: companyInput.country?.trim() || null })
    .select('company_id')
    .single()
  if (createError) return { companyId: null, error: createError }
  return { companyId: created.company_id, error: null }
}
// Small modal used for the "single-person, fully editable" convert-to-lead
// flow from a person's detail page. Pre-filled with sane defaults; every
// field stays editable before it writes anything. Channel selection is a
// simple on/off toggle per channel (matching the bulk flow and the Make.com
// contract) rather than a free-text stage picker — the CRM should never be
// the one inventing a starting stage value.
function QuickConvertModal({ person, onClose, onConfirm, creating }) {
  const [form, setForm] = useState({
    lead_purpose: '',
    nurture_stage: 'Outreach',
    owner: '',
    notes: '',
  })
  const [channels, setChannels] = useState(ALL_CHANNELS_ON)
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value })
  const toggleChannel = (key) => setChannels(prev => ({ ...prev, [key]: !prev[key] }))

  const warnings = CHANNEL_FIELDS
    .filter(cf => cf.live && channels[cf.key])
    .map(cf => channelReadinessWarning(person, cf.key))
    .filter(Boolean)

  return (
    <div className="crm-modal-overlay">
      <div className="crm-modal-backdrop" onClick={onClose} />
      <div className="crm-modal-card">
        <h4 className="crm-confirm-heading">Convert {person.first_name} {person.last_name} to a lead</h4>
        <p className="crm-confirm-note">Defaults are pre-filled — adjust anything before creating.</p>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div className="crm-form-row">
            <div>
              <FieldLabel>Status</FieldLabel>
              <div className="crm-input" style={{ background: 'var(--paper)', color: 'var(--ink-700)' }}>
                New
              </div>
            </div>
            <div>
              <FieldLabel>Nurture stage</FieldLabel>
              <select className="crm-select" value={form.nurture_stage} onChange={set('nurture_stage')}>
                {NURTURE_STAGE_OPTIONS.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
          </div>
          <div className="crm-form-row">
            <div><FieldLabel>Purpose</FieldLabel><input className="crm-input" value={form.lead_purpose} onChange={set('lead_purpose')} placeholder="e.g. Outreach" /></div>
            <div><FieldLabel>Owner</FieldLabel><input className="crm-input" value={form.owner} onChange={set('owner')} /></div>
          </div>

          <div>
            <FieldLabel>Outreach channels</FieldLabel>
            <div className="crm-channel-toggles">
              {CHANNEL_FIELDS.map(cf => (
                <button
                  key={cf.key}
                  type="button"
                  disabled={!cf.live}
                  className={`crm-channel-toggle${channels[cf.key] ? '' : ' off'}${!cf.live ? ' disabled-live' : ''}`}
                  onClick={() => cf.live && toggleChannel(cf.key)}
                  title={!cf.live ? 'Not wired to an active automation yet' : undefined}
                >
                  {channels[cf.key] ? <Check size={11} /> : <X size={11} />} {cf.label}{!cf.live ? ' (inactive)' : ''}
                </button>
              ))}
            </div>
            {warnings.map((w, i) => (
              <div key={i} className="crm-warn-note"><AlertTriangle size={12} style={{ flexShrink: 0, marginTop: 1 }} />{w}</div>
            ))}
          </div>

          <div><FieldLabel>Notes</FieldLabel><textarea className="crm-textarea" value={form.notes} onChange={set('notes')} /></div>
        </div>

        <div className="crm-confirm-actions" style={{ marginTop: 18 }}>
          <button className="crm-btn-secondary" onClick={onClose}>Cancel</button>
          <button
            className="crm-submit-btn"
            style={{ width: 'auto', padding: '10px 20px' }}
            onClick={() => onConfirm({ ...form, lead_status: 'New',...buildChannelRowFields((_, key) => channels[key], null) })}
            disabled={creating}
          >
            {creating ? <Loader2 size={15} className="crm-spin" /> : <Check size={15} />} Create lead
          </button>
        </div>
      </div>
    </div>
  )
}

export default function App() {
  const [activePage, setActivePage] = useState('people')
  const [collapsed, setCollapsed] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)
  const [toast, setToast] = useState(null) // { message, error, onUndo }

  const [leadEventMap, setLeadEventMap] = useState(new Map())
const fetchLeadEventMap = useCallback(async () => {
  const PAGE = 1000
  let allRows = []
  let from = 0
  while (true) {
    const { data, error } = await supabase
      .from('leads')
      .select('person_id, event_id')
      .range(from, from + PAGE - 1)
    if (error) return
    allRows = allRows.concat(data || [])
    if (!data || data.length < PAGE) break
    from += PAGE
  }
  const map = new Map()
  allRows.forEach(r => {
    const key = r.event_id || 'NONE'
    if (!map.has(r.person_id)) map.set(r.person_id, new Set())
    map.get(r.person_id).add(key)
  })
  setLeadEventMap(map)
}, [])
  useEffect(() => { fetchLeadEventMap() }, [fetchLeadEventMap])

  // Called by any conversion flow (bulk from People, or single from Person
  // detail) right after a lead row is successfully inserted, so every flow
  // updates the SAME map that PeoplePage reads from to hide converted people.
  const addToLeadEventMap = useCallback((personId, eventId) => {
    setLeadEventMap(prev => {
      const next = new Map(prev)
      const key = eventId || 'NONE'
      const set = new Set(next.get(personId) || [])
      set.add(key)
      next.set(personId, set)
      return next
    })
  }, [])

  // Called by undo handlers after a lead row is deleted, so undo correctly
  // brings the person back into the People page.
  const removeFromLeadEventMap = useCallback((personId, eventId) => {
    setLeadEventMap(prev => {
      const next = new Map(prev)
      const key = eventId || 'NONE'
      const set = new Set(next.get(personId) || [])
      set.delete(key)
      if (set.size === 0) next.delete(personId)
      else next.set(personId, set)
      return next
    })
  }, [])

  // detail = null | { type: 'person' | 'lead', id }
  // When set, a full-page detail view replaces the current page's content.
  const [detail, setDetail] = useState(null)
useEffect(() => {
  const params = new URLSearchParams(window.location.search)
  const personId = params.get('person')
  const navKey = params.get('navKey')

  if (personId) {
    setDetail({
      type: 'person',
      id: /^\d+$/.test(personId) ? Number(personId) : personId,
      navKey: navKey || null,
    })
  }
}, [])
  
  const openPerson = (id) => setDetail({ type: 'person', id })
  const openLead = (id) => setDetail({ type: 'lead', id })
  const closeDetail = () => setDetail(null)

const navigatePerson = (personId) => {
  if (!personId) return
  const url = new URL(window.location.href)
  url.searchParams.set('person', personId)
  url.searchParams.delete('prev')
  url.searchParams.delete('next')
  window.location.href = url.toString()
}

  const showToast = (message, error = false, onUndo = null) => setToast({ message, error, onUndo })
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), toast.onUndo ? 8000 : 2600)
    return () => clearTimeout(t)
  }, [toast])

  const goTo = (key) => { setActivePage(key); setDetail(null); setMobileOpen(false) }

  const pageMeta = detail
    ? {
        title: detail.type === 'person' ? 'Person details' : 'Lead details',
        sub: 'Full record — view, edit, and save changes below',
      }
    : {
        approval: { title: 'Approval', sub: 'Review AI-drafted replies before they go out' },
        people: { title: 'People', sub: 'All contacts synced from Supabase' },
        leads: { title: 'Leads', sub: 'Every lead across every channel' },
        events: { title: 'Events', sub: 'Events and who attended them' },
        agenda: { title: 'Agenda', sub: 'Manage agenda sessions and programme details' },
        sponsors: { title: 'Sponsors', sub: 'Manage sponsorship deals by event' },
        'display-order': { title: 'Display Order', sub: 'Manage Advisory Board and Speaker display order' },
        attendees: { title: 'Attendees', sub: 'Manage who is attached to each event' },
        create: { title: 'Create', sub: 'Add a new event or person' },
      }[activePage]

  return (
    <div className="crm-root">
      <style>{CSS}</style>

      <aside className={`crm-sidebar${collapsed ? ' collapsed' : ''}`}>
        <SidebarContent collapsed={collapsed} setCollapsed={setCollapsed} activePage={activePage} goTo={goTo} />
      </aside>

      <div className={`crm-drawer-overlay${mobileOpen ? ' open' : ''}`}>
        <div className="crm-drawer-backdrop" onClick={() => setMobileOpen(false)} />
        <aside className="crm-drawer-panel">
          <SidebarContent collapsed={false} setCollapsed={setCollapsed} activePage={activePage} goTo={goTo} onCloseMobile={() => setMobileOpen(false)} />
        </aside>
      </div>

      <div className="crm-main">
        <header className="crm-header">
          <div className="crm-header-left">
            {detail ? (
              <button className="crm-back-btn" onClick={closeDetail} aria-label="Back">
                <ArrowLeft size={18} />
              </button>
            ) : (
              <button className="crm-mobile-menu-btn" onClick={() => setMobileOpen(true)} aria-label="Open menu">
                <Menu size={18} />
              </button>
            )}
            <div style={{ minWidth: 0 }}>
              <h2 className="crm-page-title crm-display">{pageMeta.title}</h2>
              <p className="crm-page-sub">{pageMeta.sub}</p>
            </div>
          </div>
          <div className="crm-header-right">
            <button className="crm-icon-btn" style={{ color: 'var(--ink-700)' }} onClick={() => supabase.auth.signOut()} aria-label="Log out">
            <LogOut size={18} />
           </button>
         </div>
        </header>

        <main className="crm-content">
          {detail && detail.type === 'person' && (
           <PersonDetailPage
              personId={detail.id}
              navKey={detail.navKey}
              onNavigatePerson={navigatePerson}
              showToast={showToast}
              onOpenLead={openLead}
              onLeadCreated={addToLeadEventMap}
              onLeadRemoved={removeFromLeadEventMap}
          />
          )}
          {detail && detail.type === 'lead' && (
            <LeadDetailPage leadId={detail.id} showToast={showToast} onOpenPerson={openPerson} />
          )}
          {activePage === 'people' && (
         <div style={{ display: detail ? 'none' : 'block' }}>
          <PeoplePage
             showToast={showToast}
             onOpenPerson={openPerson}
             sidebarCollapsed={collapsed}
             setSidebarCollapsed={setCollapsed}
             leadEventMap={leadEventMap}
             onLeadCreated={addToLeadEventMap}
             onLeadRemoved={removeFromLeadEventMap}
           />
          </div>
          )}
          {!detail && activePage === 'agenda' && (
            <AgendaPage showToast={showToast} />
          )}
          {!detail && activePage === 'sponsors' && (
            <SponsorsPage showToast={showToast} />
          )}
          {!detail && activePage === 'display-order' && (
            <DisplayOrderPage showToast={showToast} />
          )}
          {!detail && activePage === 'leads' && <LeadsPage showToast={showToast} onOpenLead={openLead} />}
          {!detail && activePage === 'events' && <EventsPage showToast={showToast} />}
          {!detail && activePage === 'approval' && (<ApprovalPage showToast={showToast} />)}
          {!detail && activePage === 'attendees' && <AttendeesPage showToast={showToast} />}
          {!detail && activePage === 'create' && <CreatePage showToast={showToast} />}
        </main>
      </div>

      {toast && (
        <div className={`crm-toast${toast.error ? ' error' : ''}`}>
          <Check size={15} style={{ color: toast.error ? '#fff' : '#7FD1B9' }} />
          {toast.message}
          {toast.onUndo && (
            <button className="crm-toast-undo" onClick={() => { toast.onUndo(); setToast(null) }}>Undo</button>
          )}
        </div>
      )}
    </div>
  )
}

function SidebarContent({ collapsed, setCollapsed, activePage, goTo, onCloseMobile }) {
  return (
    <>
      <div className="crm-sidebar-head">
        {!collapsed && <span className="crm-logo">Connectiva<span>CRM</span></span>}
        {collapsed && <div className="crm-logo-dot" />}
        {onCloseMobile ? (
          <button className="crm-icon-btn" onClick={onCloseMobile} aria-label="Close menu"><X size={18} /></button>
        ) : (
          <button className="crm-icon-btn" onClick={() => setCollapsed(!collapsed)} aria-label="Toggle sidebar"><Menu size={16} /></button>
        )}
      </div>
      <nav className="crm-nav">
        {NAV_ITEMS.map(({ key, label, icon: Icon }) => {
          const active = activePage === key
          return (
            <button key={key} onClick={() => goTo(key)} className={`crm-nav-btn${collapsed ? ' collapsed' : ''}${active ? ' active' : ''}`} title={collapsed ? label : undefined}>
              <Icon size={18} strokeWidth={2} />
              {!collapsed && <span>{label}</span>}
            </button>
          )
        })}
      </nav>
      <div className="crm-sidebar-foot">© ConnectivaCRM</div>
    </>
  )
}

// Small up/down sort toggle next to the Company and Country filter inputs
// on the People table. Clicking the currently-active arrow again clears
// the sort back to the default (created_at) order.
function SortButtons({ columnKey, sortConfig, onSort }) {
  const isAsc = sortConfig.column === columnKey && sortConfig.direction === 'asc'
  const isDesc = sortConfig.column === columnKey && sortConfig.direction === 'desc'
  return (
    <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
      <button
        type="button"
        className={`crm-sort-text-btn${isAsc ? ' active' : ''}`}
        onClick={() => onSort(columnKey, 'asc')}
        aria-label={`Sort ${columnKey} A to Z`}
        title="Sort A to Z"
      >
        A→Z
      </button>
      <button
        type="button"
        className={`crm-sort-text-btn${isDesc ? ' active' : ''}`}
        onClick={() => onSort(columnKey, 'desc')}
        aria-label={`Sort ${columnKey} Z to A`}
        title="Sort Z to A"
      >
        Z→A
      </button>
    </div>
  )
}

// ============================================================
// SEARCHABLE PERSON PICKER
// Used for Speak / Moderate
// ============================================================

function PersonSearchPicker({
  value,
  displayName,
  onChange,
  placeholder = 'Search person...'
}) {
  const [query, setQuery] = useState(displayName || '')
  const [results, setResults] = useState([])
  const [searching, setSearching] = useState(false)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    setQuery(displayName || '')
  }, [displayName, value])

  async function searchPeople(text) {
    const q = text.trim()

    if (q.length < 2) {
      setResults([])
      return
    }

    setSearching(true)

    const { data, error } = await supabase
      .from('people')
      .select('person_id, first_name, last_name')
      .or(
        `first_name.ilike.%${q}%,last_name.ilike.%${q}%`
      )
      .order('first_name', { ascending: true })
      .limit(20)

    setSearching(false)

    if (error) {
      console.error(error)
      setResults([])
      return
    }

    setResults(data || [])
  }

  function handleChange(e) {
    const text = e.target.value

    setQuery(text)
    setOpen(true)

    if (!text) {
      onChange('', null)
      setResults([])
      return
    }

    searchPeople(text)
  }

  return (
    <div
      style={{
        position: 'relative',
        minWidth: 220
      }}
    >
      <input
        className="crm-cell-input"
        value={query}
        placeholder={placeholder}
        onChange={handleChange}
        onFocus={() => {
          setOpen(true)

          if (query.trim().length >= 2) {
            searchPeople(query)
          }
        }}
      />

      {open && (
        <div
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            left: 0,
            width: 260,
            zIndex: 200,
            background: 'var(--surface)',
            border: '1px solid var(--line)',
            borderRadius: 8,
            maxHeight: 240,
            overflowY: 'auto',
            boxShadow: '0 8px 25px rgba(0,0,0,.15)'
          }}
        >
          {searching && (
            <div
              style={{
                padding: 10,
                color: 'var(--ink-400)'
              }}
            >
              Searching...
            </div>
          )}

          {!searching &&
            query.trim().length < 2 && (
              <div
                style={{
                  padding: 10,
                  color: 'var(--ink-400)'
                }}
              >
                Type at least 2 letters
              </div>
            )}

          {!searching &&
            query.trim().length >= 2 &&
            results.length === 0 && (
              <div
                style={{
                  padding: 10,
                  color: 'var(--ink-400)'
                }}
              >
                No people found
              </div>
            )}

          {results.map(person => {
            const name =
              `${person.first_name || ''} ${person.last_name || ''}`.trim()

            return (
              <div
                key={person.person_id}
                style={{
                  padding: '8px 10px',
                  cursor: 'pointer'
                }}
                onMouseDown={e => {
                  e.preventDefault()

                  setQuery(name)
                  setOpen(false)

                  onChange(
                    person.person_id,
                    person
                  )
                }}
              >
                {name}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}


// ============================================================
// SEARCHABLE COMPANY PICKER
// Used for Sponsor
// ============================================================

function CompanySearchPicker({
  value,
  displayName,
  onChange,
  placeholder = 'Search company...'
}) {
  const [query, setQuery] =
    useState(displayName || '')

  const [results, setResults] =
    useState([])

  const [searching, setSearching] =
    useState(false)

  const [open, setOpen] =
    useState(false)

  useEffect(() => {
    setQuery(displayName || '')
  }, [displayName, value])

  async function searchCompanies(text) {
    const q = text.trim()

    if (q.length < 2) {
      setResults([])
      return
    }

    setSearching(true)

    const { data, error } = await supabase
      .from('companies')
      .select('company_id, company_name')
      .ilike('company_name', `%${q}%`)
      .order('company_name', {
        ascending: true
      })
      .limit(20)

    setSearching(false)

    if (error) {
      console.error(error)
      setResults([])
      return
    }

    setResults(data || [])
  }

  function handleChange(e) {
    const text = e.target.value

    setQuery(text)
    setOpen(true)

    if (!text) {
      onChange('', null)
      setResults([])
      return
    }

    searchCompanies(text)
  }

  return (
    <div
      style={{
        position: 'relative',
        minWidth: 220
      }}
    >
      <input
        className="crm-cell-input"
        value={query}
        placeholder={placeholder}
        onChange={handleChange}
        onFocus={() => {
          setOpen(true)

          if (query.trim().length >= 2) {
            searchCompanies(query)
          }
        }}
      />

      {open && (
        <div
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            left: 0,
            width: 280,
            zIndex: 200,
            background: 'var(--surface)',
            border: '1px solid var(--line)',
            borderRadius: 8,
            maxHeight: 240,
            overflowY: 'auto',
            boxShadow:
              '0 8px 25px rgba(0,0,0,.15)'
          }}
        >
          {searching && (
            <div
              style={{
                padding: 10,
                color: 'var(--ink-400)'
              }}
            >
              Searching...
            </div>
          )}

          {!searching &&
            query.trim().length < 2 && (
              <div
                style={{
                  padding: 10,
                  color: 'var(--ink-400)'
                }}
              >
                Type at least 2 letters
              </div>
            )}

          {!searching &&
            query.trim().length >= 2 &&
            results.length === 0 && (
              <div
                style={{
                  padding: 10,
                  color: 'var(--ink-400)'
                }}
              >
                No companies found
              </div>
            )}

          {results.map(company => (
            <div
              key={company.company_id}
              style={{
                padding: '8px 10px',
                cursor: 'pointer'
              }}
              onMouseDown={e => {
                e.preventDefault()

                setQuery(
                  company.company_name || ''
                )

                setOpen(false)

                onChange(
                  company.company_id,
                  company
                )
              }}
            >
              {company.company_name}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}


// ============================================================
// SEARCHABLE MULTI PERSON PICKER
// Used for Panelists
// ============================================================

function PersonMultiSearchPicker({
  values,
  personNames,
  onChange
}) {
  const [query, setQuery] =
    useState('')

  const [results, setResults] =
    useState([])

  const [searching, setSearching] =
    useState(false)

  const [open, setOpen] =
    useState(false)

  const selectedValues = values || []

  async function searchPeople(text) {
    const q = text.trim()

    if (q.length < 2) {
      setResults([])
      return
    }

    setSearching(true)

    const { data, error } = await supabase
      .from('people')
      .select(
        'person_id, first_name, last_name'
      )
      .or(
        `first_name.ilike.%${q}%,last_name.ilike.%${q}%`
      )
      .order('first_name', {
        ascending: true
      })
      .limit(20)

    setSearching(false)

    if (error) {
      console.error(error)
      setResults([])
      return
    }

    setResults(
      (data || []).filter(
        person =>
          !selectedValues.some(
            id =>
              Number(id) ===
              Number(person.person_id)
          )
      )
    )
  }

  function removePerson(personId) {
    onChange(
      selectedValues.filter(
        id =>
          Number(id) !==
          Number(personId)
      ),
      null
    )
  }

  return (
    <div style={{ minWidth: 260 }}>

      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 5,
          marginBottom: 5
        }}
      >
        {selectedValues.map(id => (
          <span
            key={id}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
              padding: '4px 7px',
              borderRadius: 999,
              background:
                'var(--accent-soft)',
              fontSize: 11
            }}
          >
            {personNames[id] || id}

            <button
              type="button"
              onClick={() =>
                removePerson(id)
              }
              style={{
                border: 0,
                background: 'transparent',
                cursor: 'pointer',
                padding: 0
              }}
            >
              ×
            </button>
          </span>
        ))}
      </div>

      <div
        style={{ position: 'relative' }}
      >
        <input
          className="crm-cell-input"
          value={query}
          placeholder="Search panelist..."
          onChange={e => {
            const text =
              e.target.value

            setQuery(text)
            setOpen(true)

            searchPeople(text)
          }}
          onFocus={() => {
            setOpen(true)

            if (
              query.trim().length >= 2
            ) {
              searchPeople(query)
            }
          }}
        />

        {open && (
          <div
            style={{
              position: 'absolute',
              top: 'calc(100% + 4px)',
              left: 0,
              width: 280,
              zIndex: 200,
              background:
                'var(--surface)',
              border:
                '1px solid var(--line)',
              borderRadius: 8,
              maxHeight: 240,
              overflowY: 'auto',
              boxShadow:
                '0 8px 25px rgba(0,0,0,.15)'
            }}
          >
            {searching && (
              <div
                style={{
                  padding: 10,
                  color:
                    'var(--ink-400)'
                }}
              >
                Searching...
              </div>
            )}

            {!searching &&
              query.trim().length <
                2 && (
                <div
                  style={{
                    padding: 10,
                    color:
                      'var(--ink-400)'
                  }}
                >
                  Type at least 2
                  letters
                </div>
              )}

            {results.map(person => {
              const name =
                `${person.first_name || ''} ${person.last_name || ''}`.trim()

              return (
                <div
                  key={
                    person.person_id
                  }
                  style={{
                    padding:
                      '8px 10px',
                    cursor: 'pointer'
                  }}
                  onMouseDown={e => {
                    e.preventDefault()

                    const newValues = [
                      ...selectedValues,
                      person.person_id
                    ]

                    onChange(
                      newValues,
                      person
                    )

                    setQuery('')
                    setResults([])
                    setOpen(false)
                  }}
                >
                  {name}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}


// ============================================================
// AGENDA PAGE
// ============================================================

function AgendaPage({ showToast }) {

  const [agenda, setAgenda] =
    useState([])

  const [loading, setLoading] =
    useState(true)

  const [error, setError] =
    useState(null)

  const [editingId, setEditingId] =
    useState(null)

  const [editForm, setEditForm] =
    useState(null)

  const [saving, setSaving] =
    useState(false)

  // ID → name lookups
  const [personNames, setPersonNames] =
    useState({})

  const [
    companyNames,
    setCompanyNames
  ] = useState({})

  const [
    descriptionRow,
    setDescriptionRow
  ] = useState(null)

  const [
    descriptionText,
    setDescriptionText
  ] = useState('')

  const [
    savingDescription,
    setSavingDescription
  ] = useState(false)

  const [isAdding, setIsAdding] = useState(false)
  const [searchTerm, setSearchTerm] = useState('')
  const [eventFilter, setEventFilter] = useState('')
  const [selectedRows, setSelectedRows] = useState([])
  const [deleting, setDeleting] = useState(false)
  const [events, setEvents] = useState([])

  useEffect(() => {
    fetchAgenda()
    fetchEvents()
  }, [])


  // ==========================================================
  // LOAD EVENTS FOR FILTERS / EDITING
  // ==========================================================

  async function fetchEvents() {
    const { data, error } = await supabase
      .from('events')
      .select('event_id, event_name, start_date')
      .order('start_date', { ascending: false })

    if (!error) setEvents(data || [])
  }

  function getEventLabel(eventId) {
    if (!eventId) return '—'
    const event = events.find(e => e.event_id === eventId)
    return event?.event_name
      ? `${event.event_id} - ${event.event_name}`
      : eventId
  }

  // ==========================================================
  // LOAD AGENDA
  // ==========================================================

  async function fetchAgenda() {
    setLoading(true)
    setError(null)

    const { data, error } =
      await supabase
        .from('agenda')
        .select('*')
        .order('stage_day', {
          ascending: true
        })
        .order('position', {
          ascending: true
        })
        .order('inner_position', {
          ascending: true
        })

    if (error) {
      setError(error.message)
      setAgenda([])
      setLoading(false)
      return
    }

    const rows = data || []

    setAgenda(rows)

    await loadReferenceNames(rows)

    setLoading(false)
  }


  // ==========================================================
  // LOAD ONLY THE PEOPLE / COMPANIES USED BY THE AGENDA
  // ==========================================================

  async function loadReferenceNames(rows) {

    const personIds = new Set()
    const companyIds = new Set()

    rows.forEach(row => {

      if (row.speak_moderate) {
        personIds.add(
          Number(row.speak_moderate)
        )
      }

      if (row.panelist?.length) {
        row.panelist.forEach(id =>
          personIds.add(Number(id))
        )
      }

      if (row.sponsor) {
        companyIds.add(
          Number(row.sponsor)
        )
      }

    })


    // PEOPLE

    const peopleArray =
      Array.from(personIds)

    if (peopleArray.length) {

      const { data } =
        await supabase
          .from('people')
          .select(
            'person_id, first_name, last_name'
          )
          .in(
            'person_id',
            peopleArray
          )

      const map = {}

      ;(data || []).forEach(person => {

        map[person.person_id] =
          `${person.first_name || ''} ${person.last_name || ''}`.trim()

      })

      setPersonNames(map)
    }


    // COMPANIES

    const companyArray =
      Array.from(companyIds)

    if (companyArray.length) {

      const { data } =
        await supabase
          .from('companies')
          .select(
            'company_id, company_name'
          )
          .in(
            'company_id',
            companyArray
          )

      const map = {}

      ;(data || []).forEach(company => {

        map[company.company_id] =
          company.company_name

      })

      setCompanyNames(map)
    }
  }


  // ==========================================================
  // HELPERS
  // ==========================================================

  function getPersonName(id) {
    return (
      personNames[id] ||
      id ||
      '—'
    )
  }


  function getCompanyName(id) {
    return (
      companyNames[id] ||
      id ||
      '—'
    )
  }


  function rememberPerson(person) {

    if (!person) return

    const name =
      `${person.first_name || ''} ${person.last_name || ''}`.trim()

    setPersonNames(prev => ({
      ...prev,
      [person.person_id]: name
    }))
  }


  function rememberCompany(company) {

    if (!company) return

    setCompanyNames(prev => ({
      ...prev,
      [company.company_id]:
        company.company_name
    }))
  }


  // ==========================================================
  // EDIT
  // ==========================================================

  function startEdit(row) {

    setEditingId(row.agenda_id)

    setEditForm({
      theme:
        row.theme || '',

      stage_day:
        row.stage_day || '',

      position:
        row.position ?? '',

      module_id:
        row.module_id || '',

      module_type:
        row.module_type || '',

      inner_position:
        row.inner_position ?? '',

      title:
        row.title || '',

      start_time:
        row.start_time || '',

      panelist:
        row.panelist || [],

      event_id:
        row.event_id || '',

      sponsor:
        row.sponsor ?? '',

      speak_moderate:
        row.speak_moderate ?? '',
    })
  }


  function cancelEdit() {
    setEditingId(null)
    setEditForm(null)
  }


  function setField(field) {

    return e => {

      setEditForm(prev => ({
        ...prev,
        [field]: e.target.value
      }))

    }
  }


  // ==========================================================
  // SAVE ROW
  // ==========================================================

  async function saveRow(row) {

    setSaving(true)

    const updates = {

      theme:
        editForm.theme || null,

      stage_day:
        editForm.stage_day,

      position:
        editForm.position === ''
          ? null
          : Number(
              editForm.position
            ),

      module_id:
        editForm.module_id,

      module_type:
        editForm.module_type ||
        null,

      inner_position:
        editForm.inner_position ===
        ''
          ? null
          : Number(
              editForm.inner_position
            ),

      title:
        editForm.title || null,

      start_time:
        editForm.start_time ||
        null,

      panelist:
        editForm.panelist?.length
          ? editForm.panelist.map(
              Number
            )
          : null,

      event_id:
        editForm.event_id,

      sponsor:
        editForm.sponsor === ''
          ? null
          : Number(
              editForm.sponsor
            ),

      speak_moderate:
        editForm.speak_moderate ===
        ''
          ? null
          : Number(
              editForm.speak_moderate
            ),

      updated_at:
        new Date().toISOString(),
    }


    const { error } =
      await supabase
        .from('agenda')
        .update(updates)
        .eq(
          'agenda_id',
          row.agenda_id
        )

    setSaving(false)


    if (error) {

      showToast(
        `Couldn't save agenda: ${error.message}`,
        true
      )

      return
    }


    setAgenda(prev =>
      prev.map(item =>
        item.agenda_id ===
        row.agenda_id
          ? {
              ...item,
              ...updates
            }
          : item
      )
    )


    setEditingId(null)
    setEditForm(null)

    showToast('Agenda updated')
  }

  // ==========================================================
  // ADD ROW IN AGENDA
  // ==========================================================
  function startAddRow() {
    if (editingId !== null || isAdding) {
      showToast('Finish the current edit first', true)
      return
    }

    const newRow = {
      agenda_id: 'new',

      theme: '',
      stage_day: '',
      position: '',
      module_id: '',
      module_type: '',
      inner_position: '',
      title: '',
      description: null,
      start_time: '',
      panelist: [],
      event_id: '',
      sponsor: '',
      speak_moderate: '',
    }

    setAgenda(prev => [
      newRow,
      ...prev
    ])

    setEditingId('new')
    setIsAdding(true)

    setEditForm({
      theme: '',
      stage_day: '',
      position: '',
      module_id: '',
      module_type: '',
      inner_position: '',
      title: '',
      start_time: '',
      panelist: [],
      event_id: '',
      sponsor: '',
      speak_moderate: '',
    })
  }

  function cancelAddRow() {
      setAgenda(prev =>
        prev.filter(row =>
          row.agenda_id !== 'new'
        )
      )

      setEditingId(null)
      setEditForm(null)
      setIsAdding(false)
  }

  async function saveNewRow() {
    setSaving(true)

    const newRecord = {
      theme:
        editForm.theme || null,

      stage_day:
        editForm.stage_day,

      position:
        editForm.position === ''
          ? null
          : Number(editForm.position),

      module_id:
        editForm.module_id,

      module_type:
        editForm.module_type || null,

      inner_position:
        editForm.inner_position === ''
          ? null
          : Number(editForm.inner_position),

      title:
        editForm.title || null,

      description:
        null,

      start_time:
        editForm.start_time || null,

      panelist:
        editForm.panelist?.length
          ? editForm.panelist.map(Number)
          : null,

      event_id:
        editForm.event_id,

      sponsor:
        editForm.sponsor === ''
          ? null
          : Number(editForm.sponsor),

      speak_moderate:
        editForm.speak_moderate === ''
          ? null
          : Number(editForm.speak_moderate),
    }

    const { data, error } = await supabase
      .from('agenda')
      .insert(newRecord)
      .select()
      .single()

    setSaving(false)

    if (error) {
      showToast(
        `Couldn't add agenda row: ${error.message}`,
        true
      )
      return
    }

    setAgenda(prev =>
      prev.map(row =>
        row.agenda_id === 'new'
          ? data
          : row
      )
    )

    setEditingId(null)
    setEditForm(null)
    setIsAdding(false)

    showToast('Agenda row added')
  }

  // ==========================================================
  // DESCRIPTION POPUP
  // ==========================================================

  function openDescription(row) {

    setDescriptionRow(row)

    setDescriptionText(
      row.description || ''
    )
  }


  function closeDescription() {

    if (savingDescription)
      return

    setDescriptionRow(null)

    setDescriptionText('')
  }


  async function saveDescription() {

    if (!descriptionRow)
      return

    setSavingDescription(true)

    const value =
      descriptionText.trim() ||
      null

    const updatedAt =
      new Date().toISOString()


    const { error } =
      await supabase
        .from('agenda')
        .update({
          description: value,
          updated_at: updatedAt
        })
        .eq(
          'agenda_id',
          descriptionRow.agenda_id
        )


    setSavingDescription(false)


    if (error) {

      showToast(
        `Couldn't save description: ${error.message}`,
        true
      )

      return
    }


    setAgenda(prev =>
      prev.map(row =>
        row.agenda_id ===
        descriptionRow.agenda_id
          ? {
              ...row,
              description:
                value,
              updated_at:
                updatedAt
            }
          : row
      )
    )


    setDescriptionRow(null)

    setDescriptionText('')

    showToast(
      'Description updated'
    )
  }


  // ==========================================================
  // SEARCH + EVENT FILTER
  // ==========================================================

  const eventOptions = useMemo(() => {
    const known = events.map(e => e.event_id).filter(Boolean)
    const used = agenda.map(row => row.event_id).filter(Boolean)
    return [...new Set([...known, ...used])].sort()
  }, [agenda, events])


  const filteredAgenda = useMemo(() => {
    const search = searchTerm
      .trim()
      .toLowerCase()

    return agenda.filter(row => {

      // Filter by event_id
      if (
        eventFilter &&
        row.event_id !== eventFilter
      ) {
        return false
      }

      // If there is no search text, keep the row
      if (!search) {
        return true
      }

      // Fields included in general search
      const searchableText = [
        row.theme,
        row.stage_day,
        row.module_id,
        row.module_type,
        row.title,
        row.event_id
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()

      return searchableText.includes(search)
    })
  }, [
    agenda,
    searchTerm,
    eventFilter
  ])


  // ==========================================================
  // ROW SELECTION + DELETE
  // ==========================================================

  function toggleRowSelection(agendaId) {
    setSelectedRows(prev =>
      prev.includes(agendaId)
        ? prev.filter(id => id !== agendaId)
        : [...prev, agendaId]
    )
  }


  function toggleSelectAll() {
    const visibleIds = filteredAgenda
      .filter(row => row.agenda_id !== 'new')
      .map(row => row.agenda_id)

    const allSelected =
      visibleIds.length > 0 &&
      visibleIds.every(id =>
        selectedRows.includes(id)
      )

    if (allSelected) {
      setSelectedRows(prev =>
        prev.filter(id =>
          !visibleIds.includes(id)
        )
      )
    } else {
      setSelectedRows(prev => [
        ...new Set([
          ...prev,
          ...visibleIds
        ])
      ])
    }
  }


  async function deleteSelectedRows() {
    if (!selectedRows.length) {
      showToast(
        'Select at least one agenda row',
        true
      )
      return
    }

    const confirmed = window.confirm(
      `Delete ${selectedRows.length} selected agenda row${selectedRows.length > 1 ? 's' : ''}?`
    )

    if (!confirmed) return

    setDeleting(true)

    const { error } = await supabase
      .from('agenda')
      .delete()
      .in(
        'agenda_id',
        selectedRows
      )

    setDeleting(false)

    if (error) {
      showToast(
        `Couldn't delete agenda row: ${error.message}`,
        true
      )
      return
    }

    setAgenda(prev =>
      prev.filter(
        row =>
          !selectedRows.includes(
            row.agenda_id
          )
      )
    )

    setSelectedRows([])

    showToast(
      selectedRows.length === 1
        ? 'Agenda row deleted'
        : 'Agenda rows deleted'
    )
  }


  // ==========================================================
  // LOADING
  // ==========================================================

  if (loading) {

    return (
      <div className="crm-loading">

        <Loader2
          size={16}
          className="crm-spin"
        />

        Loading agenda...

      </div>
    )
  }


  if (error) {

    return (
      <div className="crm-error">

        Couldn't load agenda:
        {' '}
        {error}

      </div>
    )
  }


  // ==========================================================
  // TABLE
  // ==========================================================

  return (
    <div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 16,
          marginBottom: 16,
          flexWrap: 'wrap'
        }}
      >

        <div
          style={{
            display: 'flex',
            gap: 10,
            alignItems: 'center',
            flexWrap: 'wrap'
          }}
        >

          <input
            className="crm-input"
            type="text"
            placeholder="Search agenda..."
            value={searchTerm}
            onChange={e =>
              setSearchTerm(e.target.value)
            }
            style={{
              width: 280
            }}
          />


          <select
            className="crm-input"
            value={eventFilter}
            onChange={e =>
              setEventFilter(e.target.value)
            }
            style={{
              width: 200
            }}
          >
            <option value="">
              All Events
            </option>

            {eventOptions.map(eventId => (
              <option
                key={eventId}
                value={eventId}
              >
                {getEventLabel(eventId)}
              </option>
            ))}

          </select>


          {(searchTerm || eventFilter) && (
            <button
              className="crm-btn-secondary"
              onClick={() => {
                setSearchTerm('')
                setEventFilter('')
              }}
            >
              Clear
            </button>
          )}

        </div>


        <div
          style={{
            display: 'flex',
            gap: 8,
            alignItems: 'center'
          }}
        >
          <button
            className="crm-btn-secondary"
            onClick={deleteSelectedRows}
            disabled={
              selectedRows.length === 0 ||
              deleting ||
              editingId !== null
            }
          >
            {deleting
              ? 'Deleting...'
              : `Delete Selected${
                  selectedRows.length
                    ? ` (${selectedRows.length})`
                    : ''
                }`
            }
          </button>

          <button
            className="crm-submit-btn"
            style={{
              width: 'auto',
              padding: '9px 16px'
            }}
            onClick={startAddRow}
            disabled={
              isAdding ||
              editingId !== null
            }
          >
            + Add Agenda Row
          </button>
        </div>

      </div>

      <div className="crm-table-wrap">

        <table className="crm-table">

          <thead>
            <tr>

              <th
                style={{
                  width: 40,
                  textAlign: 'center'
                }}
              >
                <input
                  type="checkbox"
                  checked={
                    filteredAgenda.filter(
                      row => row.agenda_id !== 'new'
                    ).length > 0 &&
                    filteredAgenda
                      .filter(
                        row => row.agenda_id !== 'new'
                      )
                      .every(
                        row =>
                          selectedRows.includes(
                            row.agenda_id
                          )
                      )
                  }
                  onChange={toggleSelectAll}
                />
              </th>

              <th>Theme</th>

              <th>
                Stage / Day
              </th>

              <th>
                Position
              </th>

              <th>
                Module ID
              </th>

              <th>
                Module Type
              </th>

              <th>
                Inner Position
              </th>

              <th>Title</th>

              <th>
                Description
              </th>

              <th>Start</th>

              <th>
                Panelist
              </th>

              <th>Event</th>

              <th>
                Sponsor
              </th>

              <th>
                Speak / Moderate
              </th>

              <th></th>

            </tr>
          </thead>


          <tbody>

            {filteredAgenda.map(row => {

              const editing =
                editingId ===
                row.agenda_id


              return (

                <tr
                  key={
                    row.agenda_id
                  }
                >

                  {/* SELECT ROW */}

                  <td
                    style={{
                      textAlign: 'center'
                    }}
                  >
                    {row.agenda_id !== 'new' && (
                      <input
                        type="checkbox"
                        checked={
                          selectedRows.includes(
                            row.agenda_id
                          )
                        }
                        onChange={() =>
                          toggleRowSelection(
                            row.agenda_id
                          )
                        }
                      />
                    )}
                  </td>


                  {/* THEME */}

                  <td>

                    {editing ? (

                      <input
                        className="crm-cell-input"
                        value={
                          editForm.theme
                        }
                        onChange={
                          setField(
                            'theme'
                          )
                        }
                      />

                    ) : (

                      row.theme ||
                      '—'

                    )}

                  </td>


                  {/* STAGE DAY */}

                  <td>

                    {editing ? (

                      <input
                        className="crm-cell-input"
                        value={
                          editForm.stage_day
                        }
                        onChange={
                          setField(
                            'stage_day'
                          )
                        }
                      />

                    ) : (

                      row.stage_day

                    )}

                  </td>


                  {/* POSITION */}

                  <td>

                    {editing ? (

                      <input
                        className="crm-cell-input"
                        type="number"
                        value={
                          editForm.position
                        }
                        onChange={
                          setField(
                            'position'
                          )
                        }
                      />

                    ) : (

                      row.position ??
                      '—'

                    )}

                  </td>


                  {/* MODULE ID */}

                  <td>

                    {editing ? (

                      <input
                        className="crm-cell-input"
                        value={
                          editForm.module_id
                        }
                        onChange={
                          setField(
                            'module_id'
                          )
                        }
                      />

                    ) : (

                      row.module_id

                    )}

                  </td>


                  {/* MODULE TYPE */}

                  <td>

                    {editing ? (

                      <input
                        className="crm-cell-input"
                        value={
                          editForm.module_type
                        }
                        onChange={
                          setField(
                            'module_type'
                          )
                        }
                      />

                    ) : (

                      row.module_type ||
                      '—'

                    )}

                  </td>


                  {/* INNER POSITION */}

                  <td>

                    {editing ? (

                      <input
                        className="crm-cell-input"
                        type="number"
                        value={
                          editForm.inner_position
                        }
                        onChange={
                          setField(
                            'inner_position'
                          )
                        }
                      />

                    ) : (

                      row.inner_position ??
                      '—'

                    )}

                  </td>


                  {/* TITLE */}

                  <td>

                    {editing ? (

                      <input
                        className="crm-cell-input"
                        value={
                          editForm.title
                        }
                        onChange={
                          setField(
                            'title'
                          )
                        }
                      />

                    ) : (

                      row.title ||
                      '—'

                    )}

                  </td>


                  {/* DESCRIPTION */}

                  <td>

                    <button
                      className="crm-btn-secondary"
                      onClick={() =>
                        openDescription(
                          row
                        )
                      }
                      style={{
                        padding:
                          '5px 10px',
                        whiteSpace:
                          'nowrap'
                      }}
                    >

                      {row.description
                        ? 'View / Edit'
                        : 'Add'}

                    </button>

                  </td>


                  {/* START TIME */}

                  <td>

                    {editing ? (

                      <input
                        className="crm-cell-input"
                        type="time"
                        value={
                          editForm.start_time
                        }
                        onChange={
                          setField(
                            'start_time'
                          )
                        }
                      />

                    ) : (

                      row.start_time ||
                      '—'

                    )}

                  </td>


                  {/* PANELISTS */}

                  <td>

                    {editing ? (

                      <PersonMultiSearchPicker
                        values={
                          editForm.panelist
                        }
                        personNames={
                          personNames
                        }
                        onChange={(
                          values,
                          person
                        ) => {

                          if (person) {
                            rememberPerson(
                              person
                            )
                          }

                          setEditForm(
                            prev => ({
                              ...prev,
                              panelist:
                                values
                            })
                          )
                        }}
                      />

                    ) : (

                      row.panelist
                        ?.length
                        ? row.panelist
                            .map(
                              id =>
                                getPersonName(
                                  id
                                )
                            )
                            .join(', ')
                        : '—'

                    )}

                  </td>


                  {/* EVENT */}

                  <td>

                    {editing ? (

                      <select
                        className="crm-cell-select"
                        value={editForm.event_id}
                        onChange={setField('event_id')}
                      >
                        <option value="">Select event</option>
                        {eventOptions.map(eventId => (
                          <option key={eventId} value={eventId}>
                            {getEventLabel(eventId)}
                          </option>
                        ))}
                      </select>

                    ) : (

                      getEventLabel(row.event_id)

                    )}

                  </td>


                  {/* SPONSOR */}

                  <td>

                    {editing ? (

                      <CompanySearchPicker
                        value={
                          editForm.sponsor
                        }
                        displayName={
                          editForm.sponsor
                            ? getCompanyName(
                                editForm.sponsor
                              )
                            : ''
                        }
                        onChange={(
                          value,
                          company
                        ) => {

                          if (company) {
                            rememberCompany(
                              company
                            )
                          }

                          setEditForm(
                            prev => ({
                              ...prev,
                              sponsor:
                                value
                            })
                          )
                        }}
                      />

                    ) : (

                      row.sponsor
                        ? getCompanyName(
                            row.sponsor
                          )
                        : '—'

                    )}

                  </td>


                  {/* SPEAK / MODERATE */}

                  <td>

                    {editing ? (

                      <PersonSearchPicker
                        value={
                          editForm.speak_moderate
                        }
                        displayName={
                          editForm.speak_moderate
                            ? getPersonName(
                                editForm.speak_moderate
                              )
                            : ''
                        }
                        onChange={(
                          value,
                          person
                        ) => {

                          if (person) {
                            rememberPerson(
                              person
                            )
                          }

                          setEditForm(
                            prev => ({
                              ...prev,
                              speak_moderate:
                                value
                            })
                          )
                        }}
                      />

                    ) : (

                      row.speak_moderate
                        ? getPersonName(
                            row.speak_moderate
                          )
                        : '—'

                    )}

                  </td>


                  {/* ACTION */}

                  <td>
                    {editing ? (
                      <div
                        style={{
                          display: 'flex',
                          gap: 6,
                          whiteSpace: 'nowrap'
                        }}
                      >
                        <button
                          className="crm-submit-btn"
                          style={{
                            width: 'auto',
                            padding: '7px 12px'
                          }}
                          disabled={saving}
                          onClick={() => {
                            if (isAdding && row.agenda_id === 'new') {
                              saveNewRow()
                            } else {
                              saveRow(row)
                            }
                          }}
                        >
                          {saving
                            ? 'Saving...'
                            : 'Save'}
                        </button>

                        <button
                          className="crm-btn-secondary"
                          disabled={saving}
                          onClick={() => {
                            if (isAdding && row.agenda_id === 'new') {
                              cancelAddRow()
                            } else {
                              cancelEdit()
                            }
                          }}
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button
                        className="crm-btn-secondary"
                        onClick={() =>
                          startEdit(row)
                        }
                      >
                        Edit
                      </button>
                    )}
                  </td>

                </tr>
              )

            })}


            {filteredAgenda.length === 0 && (

              <tr>

                <td
                  colSpan={15}
                  style={{
                    textAlign:
                      'center'
                  }}
                >
                  {agenda.length === 0
                    ? 'No agenda records found.'
                    : 'No agenda records match your search.'}
                </td>

              </tr>

            )}

          </tbody>

        </table>

      </div>


      {/* ======================================================
          DESCRIPTION POPUP
      ====================================================== */}

      {descriptionRow && (

        <div className="crm-modal-overlay">

          <div
            className="crm-modal-backdrop"
            onClick={
              closeDescription
            }
          />


          <div
            className="crm-modal-card"
            style={{
              maxWidth: 700
            }}
          >

            <h4 className="crm-confirm-heading">
              Edit description
            </h4>


            <p className="crm-confirm-note">

              {descriptionRow.title ||
                descriptionRow.module_id}

            </p>


            <textarea
              className="crm-input"
              value={
                descriptionText
              }
              onChange={e =>
                setDescriptionText(
                  e.target.value
                )
              }
              rows={12}
              style={{
                resize:
                  'vertical',
                lineHeight: 1.5
              }}
            />


            <div
              className="crm-confirm-actions"
              style={{
                marginTop: 18
              }}
            >

              <button
                className="crm-btn-secondary"
                onClick={
                  closeDescription
                }
                disabled={
                  savingDescription
                }
              >
                Cancel
              </button>


              <button
                className="crm-submit-btn"
                style={{
                  width: 'auto',
                  padding:
                    '10px 20px'
                }}
                onClick={
                  saveDescription
                }
                disabled={
                  savingDescription
                }
              >

                {savingDescription
                  ? 'Saving...'
                  : 'Save description'}

              </button>

            </div>

          </div>

        </div>

      )}

    </div>
  )
}

// ============================================================================
// SPONSORS — sponsorship_deals table
// Shows only the operational fields requested for the CRM. Financial / closing
// fields remain in Supabase but are intentionally not displayed on this page.
// ============================================================================
function SponsorsPage({ showToast }) {
  const [deals, setDeals] = useState([])
  const [events, setEvents] = useState([])
  const [companyNames, setCompanyNames] = useState({})
  const [personNames, setPersonNames] = useState({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const [searchTerm, setSearchTerm] = useState('')
  const [eventFilter, setEventFilter] = useState('')
  const [selectedRows, setSelectedRows] = useState([])
  const [editingId, setEditingId] = useState(null)
  const [editForm, setEditForm] = useState(null)
  const [isAdding, setIsAdding] = useState(false)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)

  useEffect(() => {
    fetchSponsors()
    fetchEvents()
  }, [])

  async function fetchEvents() {
    const { data } = await supabase
      .from('events')
      .select('event_id, event_name, start_date')
      .order('start_date', { ascending: false })

    setEvents(data || [])
  }

  async function fetchSponsors() {
    setLoading(true)
    setError(null)

    const { data, error } = await supabase
      .from('sponsorship_deals')
      .select('deal_id, event_id, company_id, contact_person_id, deal_stage, package_name, notes')
      .order('deal_id', { ascending: false })

    if (error) {
      setError(error.message)
      setDeals([])
      setLoading(false)
      return
    }

    const rows = data || []
    setDeals(rows)
    await loadReferenceNames(rows)
    setLoading(false)
  }

  async function loadReferenceNames(rows) {
    const companyIds = [...new Set(rows.map(r => r.company_id).filter(Boolean).map(Number))]
    const personIds = [...new Set(rows.map(r => r.contact_person_id).filter(Boolean).map(Number))]

    if (companyIds.length) {
      const { data } = await supabase
        .from('companies')
        .select('company_id, company_name')
        .in('company_id', companyIds)

      const map = {}
      ;(data || []).forEach(c => { map[c.company_id] = c.company_name })
      setCompanyNames(prev => ({ ...prev, ...map }))
    }

    if (personIds.length) {
      const { data } = await supabase
        .from('people')
        .select('person_id, first_name, last_name')
        .in('person_id', personIds)

      const map = {}
      ;(data || []).forEach(p => {
        map[p.person_id] = `${p.first_name || ''} ${p.last_name || ''}`.trim()
      })
      setPersonNames(prev => ({ ...prev, ...map }))
    }
  }

  function getEventLabel(eventId) {
    if (!eventId) return '—'
    const event = events.find(e => e.event_id === eventId)
    return event?.event_name
      ? `${event.event_id} - ${event.event_name}`
      : eventId
  }

  function getCompanyName(id) {
    return companyNames[id] || id || '—'
  }

  function getPersonName(id) {
    return personNames[id] || id || '—'
  }

  function rememberCompany(company) {
    if (!company) return
    setCompanyNames(prev => ({
      ...prev,
      [company.company_id]: company.company_name
    }))
  }

  function rememberPerson(person) {
    if (!person) return
    const name = `${person.first_name || ''} ${person.last_name || ''}`.trim()
    setPersonNames(prev => ({
      ...prev,
      [person.person_id]: name
    }))
  }

  const eventOptions = useMemo(() => {
    const known = events.map(e => e.event_id).filter(Boolean)
    const used = deals.map(d => d.event_id).filter(Boolean)
    return [...new Set([...known, ...used])].sort()
  }, [events, deals])

  const filteredDeals = useMemo(() => {
    const search = searchTerm.trim().toLowerCase()

    return deals.filter(row => {
      if (eventFilter && row.event_id !== eventFilter) return false
      if (!search) return true

      const searchable = [
        row.event_id,
        getEventLabel(row.event_id),
        getCompanyName(row.company_id),
        getPersonName(row.contact_person_id),
        row.deal_stage,
        row.package_name,
        row.notes,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()

      return searchable.includes(search)
    })
  }, [deals, searchTerm, eventFilter, events, companyNames, personNames])

  function setField(field) {
    return e => setEditForm(prev => ({ ...prev, [field]: e.target.value }))
  }

  function startEdit(row) {
    if (isAdding || editingId !== null) {
      showToast('Finish the current edit first', true)
      return
    }

    setEditingId(row.deal_id)
    setEditForm({
      event_id: row.event_id || '',
      company_id: row.company_id ?? '',
      contact_person_id: row.contact_person_id ?? '',
      deal_stage: row.deal_stage || '',
      package_name: row.package_name || '',
      notes: row.notes || '',
    })
  }

  function cancelEdit() {
    setEditingId(null)
    setEditForm(null)
  }

  function startAddRow() {
    if (editingId !== null || isAdding) {
      showToast('Finish the current edit first', true)
      return
    }

    const newRow = {
      deal_id: 'new',
      event_id: eventFilter || '',
      company_id: '',
      contact_person_id: '',
      deal_stage: '',
      package_name: '',
      notes: '',
    }

    setDeals(prev => [newRow, ...prev])
    setEditingId('new')
    setIsAdding(true)
    setEditForm({ ...newRow })
  }

  function cancelAddRow() {
    setDeals(prev => prev.filter(row => row.deal_id !== 'new'))
    setEditingId(null)
    setEditForm(null)
    setIsAdding(false)
  }

  function buildPayload() {
    return {
      event_id: editForm.event_id || null,
      company_id: editForm.company_id === '' ? null : Number(editForm.company_id),
      contact_person_id: editForm.contact_person_id === '' ? null : Number(editForm.contact_person_id),
      deal_stage: editForm.deal_stage.trim() || null,
      package_name: editForm.package_name.trim() || null,
      notes: editForm.notes.trim() || null,
      updated_at: new Date().toISOString(),
    }
  }

  async function saveRow(row) {
    setSaving(true)
    const updates = buildPayload()

    const { error } = await supabase
      .from('sponsorship_deals')
      .update(updates)
      .eq('deal_id', row.deal_id)

    setSaving(false)

    if (error) {
      showToast(`Couldn't save sponsor: ${error.message}`, true)
      return
    }

    setDeals(prev => prev.map(item =>
      item.deal_id === row.deal_id ? { ...item, ...updates } : item
    ))
    setEditingId(null)
    setEditForm(null)
    showToast('Sponsor updated')
  }

  async function saveNewRow() {
    setSaving(true)
    const newRecord = buildPayload()

    const { data, error } = await supabase
      .from('sponsorship_deals')
      .insert(newRecord)
      .select('deal_id, event_id, company_id, contact_person_id, deal_stage, package_name, notes')
      .single()

    setSaving(false)

    if (error) {
      showToast(`Couldn't add sponsor: ${error.message}`, true)
      return
    }

    setDeals(prev => prev.map(row => row.deal_id === 'new' ? data : row))
    setEditingId(null)
    setEditForm(null)
    setIsAdding(false)
    showToast('Sponsor added')
  }

  function toggleRowSelection(dealId) {
    setSelectedRows(prev =>
      prev.includes(dealId)
        ? prev.filter(id => id !== dealId)
        : [...prev, dealId]
    )
  }

  function toggleSelectAll() {
    const visibleIds = filteredDeals
      .filter(row => row.deal_id !== 'new')
      .map(row => row.deal_id)

    const allSelected = visibleIds.length > 0 &&
      visibleIds.every(id => selectedRows.includes(id))

    if (allSelected) {
      setSelectedRows(prev => prev.filter(id => !visibleIds.includes(id)))
    } else {
      setSelectedRows(prev => [...new Set([...prev, ...visibleIds])])
    }
  }

  async function deleteSelectedRows() {
    if (!selectedRows.length) {
      showToast('Select at least one sponsor row', true)
      return
    }

    const confirmed = window.confirm(
      `Delete ${selectedRows.length} selected sponsor row${selectedRows.length > 1 ? 's' : ''}?`
    )
    if (!confirmed) return

    setDeleting(true)
    const { error } = await supabase
      .from('sponsorship_deals')
      .delete()
      .in('deal_id', selectedRows)
    setDeleting(false)

    if (error) {
      showToast(`Couldn't delete sponsor row: ${error.message}`, true)
      return
    }

    setDeals(prev => prev.filter(row => !selectedRows.includes(row.deal_id)))
    setSelectedRows([])
    showToast(selectedRows.length === 1 ? 'Sponsor row deleted' : 'Sponsor rows deleted')
  }

  if (loading) {
    return (
      <div className="crm-loading">
        <Loader2 size={16} className="crm-spin" /> Loading sponsors...
      </div>
    )
  }

  if (error) {
    return <div className="crm-error">Couldn't load sponsors: {error}</div>
  }

  return (
    <div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 16,
          marginBottom: 16,
          flexWrap: 'wrap'
        }}
      >
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            className="crm-input"
            type="text"
            placeholder="Search sponsors..."
            value={searchTerm}
            onChange={e => setSearchTerm(e.target.value)}
            style={{ width: 280 }}
          />

          <select
            className="crm-input"
            value={eventFilter}
            onChange={e => setEventFilter(e.target.value)}
            style={{ width: 300 }}
          >
            <option value="">All Events</option>
            {eventOptions.map(eventId => (
              <option key={eventId} value={eventId}>
                {getEventLabel(eventId)}
              </option>
            ))}
          </select>

          {(searchTerm || eventFilter) && (
            <button
              className="crm-btn-secondary"
              onClick={() => {
                setSearchTerm('')
                setEventFilter('')
              }}
            >
              Clear
            </button>
          )}
        </div>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button
            className="crm-btn-secondary"
            onClick={deleteSelectedRows}
            disabled={selectedRows.length === 0 || deleting || editingId !== null}
          >
            {deleting
              ? 'Deleting...'
              : `Delete Selected${selectedRows.length ? ` (${selectedRows.length})` : ''}`}
          </button>

          <button
            className="crm-submit-btn"
            style={{ width: 'auto', padding: '9px 16px' }}
            onClick={startAddRow}
            disabled={isAdding || editingId !== null}
          >
            + Add Sponsor
          </button>
        </div>
      </div>

      <div className="crm-table-wrap">
        <table className="crm-table" style={{ minWidth: 1100 }}>
          <thead>
            <tr>
              <th style={{ width: 40, textAlign: 'center' }}>
                <input
                  type="checkbox"
                  checked={
                    filteredDeals.filter(row => row.deal_id !== 'new').length > 0 &&
                    filteredDeals
                      .filter(row => row.deal_id !== 'new')
                      .every(row => selectedRows.includes(row.deal_id))
                  }
                  onChange={toggleSelectAll}
                />
              </th>
              <th>Event</th>
              <th>Company</th>
              <th>Contact Person</th>
              <th>Deal Stage</th>
              <th>Package</th>
              <th>Notes</th>
              <th></th>
            </tr>
          </thead>

          <tbody>
            {filteredDeals.map(row => {
              const editing = editingId === row.deal_id

              return (
                <tr key={row.deal_id} className={editing ? 'editing' : ''}>
                  <td style={{ textAlign: 'center' }}>
                    {row.deal_id !== 'new' && (
                      <input
                        type="checkbox"
                        checked={selectedRows.includes(row.deal_id)}
                        onChange={() => toggleRowSelection(row.deal_id)}
                      />
                    )}
                  </td>

                  <td style={{ minWidth: 240 }}>
                    {editing ? (
                      <select
                        className="crm-cell-select"
                        value={editForm.event_id}
                        onChange={setField('event_id')}
                      >
                        <option value="">Select event</option>
                        {eventOptions.map(eventId => (
                          <option key={eventId} value={eventId}>
                            {getEventLabel(eventId)}
                          </option>
                        ))}
                      </select>
                    ) : (
                      getEventLabel(row.event_id)
                    )}
                  </td>

                  <td style={{ minWidth: 190 }}>
                    {editing ? (
                      <CompanySearchPicker
                        value={editForm.company_id}
                        displayName={editForm.company_id ? getCompanyName(editForm.company_id) : ''}
                        onChange={(value, company) => {
                          if (company) rememberCompany(company)
                          setEditForm(prev => ({ ...prev, company_id: value }))
                        }}
                        placeholder="Search sponsor company..."
                      />
                    ) : (
                      row.company_id ? getCompanyName(row.company_id) : '—'
                    )}
                  </td>

                  <td style={{ minWidth: 190 }}>
                    {editing ? (
                      <PersonSearchPicker
                        value={editForm.contact_person_id}
                        displayName={editForm.contact_person_id ? getPersonName(editForm.contact_person_id) : ''}
                        onChange={(value, person) => {
                          if (person) rememberPerson(person)
                          setEditForm(prev => ({ ...prev, contact_person_id: value }))
                        }}
                        placeholder="Search contact person..."
                      />
                    ) : (
                      row.contact_person_id ? getPersonName(row.contact_person_id) : '—'
                    )}
                  </td>

                  <td>
                    {editing ? (
                      <input
                        className="crm-cell-input"
                        value={editForm.deal_stage}
                        onChange={setField('deal_stage')}
                        placeholder="e.g. Proposal"
                      />
                    ) : (
                      row.deal_stage || '—'
                    )}
                  </td>

                  <td>
                    {editing ? (
                      <input
                        className="crm-cell-input"
                        value={editForm.package_name}
                        onChange={setField('package_name')}
                        placeholder="Package name"
                      />
                    ) : (
                      row.package_name || '—'
                    )}
                  </td>

                  <td style={{ minWidth: 220 }}>
                    {editing ? (
                      <textarea
                        className="crm-cell-input"
                        value={editForm.notes}
                        onChange={setField('notes')}
                        rows={2}
                        style={{ resize: 'vertical' }}
                      />
                    ) : (
                      <div className="crm-notes-cell" title={row.notes || ''}>
                        {row.notes || '—'}
                      </div>
                    )}
                  </td>

                  <td>
                    {editing ? (
                      <div style={{ display: 'flex', gap: 6, whiteSpace: 'nowrap' }}>
                        <button
                          className="crm-submit-btn"
                          style={{ width: 'auto', padding: '7px 12px' }}
                          disabled={saving}
                          onClick={() => {
                            if (isAdding && row.deal_id === 'new') saveNewRow()
                            else saveRow(row)
                          }}
                        >
                          {saving ? 'Saving...' : 'Save'}
                        </button>
                        <button
                          className="crm-btn-secondary"
                          disabled={saving}
                          onClick={() => {
                            if (isAdding && row.deal_id === 'new') cancelAddRow()
                            else cancelEdit()
                          }}
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button className="crm-btn-secondary" onClick={() => startEdit(row)}>
                        Edit
                      </button>
                    )}
                  </td>
                </tr>
              )
            })}

            {filteredDeals.length === 0 && (
              <tr>
                <td colSpan={8} style={{ textAlign: 'center', padding: 30 }}>
                  {deals.length === 0
                    ? 'No sponsorship deals found.'
                    : 'No sponsorship deals match your search.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ============================================================================
// DISPLAY ORDER — Advisory Board + Speakers
// Only the ordering columns can be edited on this page.
// ABM comes directly from people where lead_purpose = 'ABM'.
// Speakers are event-specific confirmed speakers from event_participants.
// ============================================================================
function DisplayOrderPage({ showToast }) {
  const [activeTab, setActiveTab] = useState('abm')
  const [searchTerm, setSearchTerm] = useState('')

  const [abmRows, setAbmRows] = useState([])
  const [abmLoading, setAbmLoading] = useState(true)
  const [abmError, setAbmError] = useState(null)
  const [editingAbmId, setEditingAbmId] = useState(null)
  const [abmOrderDraft, setAbmOrderDraft] = useState('')
  const [savingAbm, setSavingAbm] = useState(false)

  const [events, setEvents] = useState([])
  const [selectedEventId, setSelectedEventId] = useState('')
  const [speakerRows, setSpeakerRows] = useState([])
  const [speakersLoading, setSpeakersLoading] = useState(false)
  const [speakersError, setSpeakersError] = useState(null)
  const [editingSpeakerId, setEditingSpeakerId] = useState(null)
  const [speakerOrderDraft, setSpeakerOrderDraft] = useState('')
  const [savingSpeaker, setSavingSpeaker] = useState(false)

  useEffect(() => {
    fetchAbm()
    fetchEvents()
  }, [])

  useEffect(() => {
    if (selectedEventId) fetchSpeakers(selectedEventId)
    else setSpeakerRows([])
  }, [selectedEventId])

  async function fetchAbm() {
    setAbmLoading(true)
    setAbmError(null)

    const { data, error } = await supabase
      .from('people')
      .select(`
        person_id,
        first_name,
        last_name,
        job_title,
        company_id,
        abm_order,
        companies(company_name)
      `)
      .eq('lead_purpose', 'ABM')

    if (error) {
      setAbmError(error.message)
      setAbmRows([])
      setAbmLoading(false)
      return
    }

    const rows = [...(data || [])].sort((a, b) => {
      const ao = a.abm_order == null ? Number.MAX_SAFE_INTEGER : Number(a.abm_order)
      const bo = b.abm_order == null ? Number.MAX_SAFE_INTEGER : Number(b.abm_order)
      if (ao !== bo) return ao - bo
      const an = `${a.first_name || ''} ${a.last_name || ''}`.trim()
      const bn = `${b.first_name || ''} ${b.last_name || ''}`.trim()
      return an.localeCompare(bn)
    })

    setAbmRows(rows)
    setAbmLoading(false)
  }

  async function fetchEvents() {
    const { data, error } = await supabase
      .from('events')
      .select('event_id, event_name, start_date')
      .order('start_date', { ascending: false })

    if (error) {
      showToast(`Couldn't load events: ${error.message}`, true)
      return
    }

    const rows = data || []
    setEvents(rows)
    if (rows.length && !selectedEventId) setSelectedEventId(rows[0].event_id)
  }

  async function fetchSpeakers(eventId) {
    setSpeakersLoading(true)
    setSpeakersError(null)

    const { data, error } = await supabase
      .from('event_participants')
      .select(`
        participant_id,
        person_id,
        company_id,
        event_id,
        role,
        status,
        display_order,
        people(first_name, last_name, job_title),
        companies(company_name)
      `)
      .eq('event_id', eventId)
      .eq('role', 'Speaker')
      .eq('status', 'Confirmed')

    if (error) {
      setSpeakersError(error.message)
      setSpeakerRows([])
      setSpeakersLoading(false)
      return
    }

    const rows = [...(data || [])].sort((a, b) => {
      const ao = a.display_order == null ? Number.MAX_SAFE_INTEGER : Number(a.display_order)
      const bo = b.display_order == null ? Number.MAX_SAFE_INTEGER : Number(b.display_order)
      if (ao !== bo) return ao - bo
      const an = `${a.people?.first_name || ''} ${a.people?.last_name || ''}`.trim()
      const bn = `${b.people?.first_name || ''} ${b.people?.last_name || ''}`.trim()
      return an.localeCompare(bn)
    })

    setSpeakerRows(rows)
    setSpeakersLoading(false)
  }

  function eventLabel(eventId) {
    const event = events.find(e => e.event_id === eventId)
    return event?.event_name ? `${event.event_id} - ${event.event_name}` : eventId
  }

  const filteredAbm = useMemo(() => {
    const search = searchTerm.trim().toLowerCase()
    if (!search) return abmRows

    return abmRows.filter(row => {
      const text = [
        row.first_name,
        row.last_name,
        row.job_title,
        row.companies?.company_name,
        row.abm_order,
      ].filter(v => v !== null && v !== undefined).join(' ').toLowerCase()
      return text.includes(search)
    })
  }, [abmRows, searchTerm])

  const filteredSpeakers = useMemo(() => {
    const search = searchTerm.trim().toLowerCase()
    if (!search) return speakerRows

    return speakerRows.filter(row => {
      const text = [
        row.people?.first_name,
        row.people?.last_name,
        row.people?.job_title,
        row.companies?.company_name,
        row.display_order,
      ].filter(v => v !== null && v !== undefined).join(' ').toLowerCase()
      return text.includes(search)
    })
  }, [speakerRows, searchTerm])

  function startAbmEdit(row) {
    setEditingSpeakerId(null)
    setEditingAbmId(row.person_id)
    setAbmOrderDraft(row.abm_order ?? '')
  }

  function cancelAbmEdit() {
    setEditingAbmId(null)
    setAbmOrderDraft('')
  }

  async function saveAbmOrder(row) {
    setSavingAbm(true)
    const value = abmOrderDraft === '' ? null : Number(abmOrderDraft)

    const { error } = await supabase
      .from('people')
      .update({
        abm_order: value,
        updated_at: new Date().toISOString(),
      })
      .eq('person_id', row.person_id)

    setSavingAbm(false)

    if (error) {
      showToast(`Couldn't update ABM order: ${error.message}`, true)
      return
    }

    setAbmRows(prev => prev
      .map(item => item.person_id === row.person_id ? { ...item, abm_order: value } : item)
      .sort((a, b) => {
        const ao = a.abm_order == null ? Number.MAX_SAFE_INTEGER : Number(a.abm_order)
        const bo = b.abm_order == null ? Number.MAX_SAFE_INTEGER : Number(b.abm_order)
        return ao - bo
      })
    )

    setEditingAbmId(null)
    setAbmOrderDraft('')
    showToast('Advisory Board display order updated')
  }

  function startSpeakerEdit(row) {
    setEditingAbmId(null)
    setEditingSpeakerId(row.participant_id)
    setSpeakerOrderDraft(row.display_order ?? '')
  }

  function cancelSpeakerEdit() {
    setEditingSpeakerId(null)
    setSpeakerOrderDraft('')
  }

  async function saveSpeakerOrder(row) {
    setSavingSpeaker(true)
    const value = speakerOrderDraft === '' ? null : Number(speakerOrderDraft)

    const { error } = await supabase
      .from('event_participants')
      .update({
        display_order: value,
        updated_at: new Date().toISOString(),
      })
      .eq('participant_id', row.participant_id)

    setSavingSpeaker(false)

    if (error) {
      showToast(`Couldn't update speaker order: ${error.message}`, true)
      return
    }

    setSpeakerRows(prev => prev
      .map(item => item.participant_id === row.participant_id ? { ...item, display_order: value } : item)
      .sort((a, b) => {
        const ao = a.display_order == null ? Number.MAX_SAFE_INTEGER : Number(a.display_order)
        const bo = b.display_order == null ? Number.MAX_SAFE_INTEGER : Number(b.display_order)
        return ao - bo
      })
    )

    setEditingSpeakerId(null)
    setSpeakerOrderDraft('')
    showToast('Speaker display order updated')
  }

  return (
    <div>
      <div className="crm-tabs" style={{ marginBottom: 18 }}>
        <button
          className={`crm-tab-btn${activeTab === 'abm' ? ' active' : ''}`}
          onClick={() => {
            setActiveTab('abm')
            setSearchTerm('')
            cancelSpeakerEdit()
          }}
        >
          Advisory Board
        </button>
        <button
          className={`crm-tab-btn${activeTab === 'speakers' ? ' active' : ''}`}
          onClick={() => {
            setActiveTab('speakers')
            setSearchTerm('')
            cancelAbmEdit()
          }}
        >
          Speakers
        </button>
      </div>

      <div className="crm-toolbar">
        <div className="crm-search-box" style={{ maxWidth: 360 }}>
          <Search size={16} />
          <input
            value={searchTerm}
            onChange={e => setSearchTerm(e.target.value)}
            placeholder={activeTab === 'abm' ? 'Search Advisory Board...' : 'Search speakers...'}
          />
        </div>

        {activeTab === 'speakers' && (
          <select
            className="crm-filter-select"
            value={selectedEventId}
            onChange={e => {
              setSelectedEventId(e.target.value)
              setEditingSpeakerId(null)
              setSpeakerOrderDraft('')
            }}
            style={{ minWidth: 300 }}
          >
            <option value="">Select event</option>
            {events.map(event => (
              <option key={event.event_id} value={event.event_id}>
                {eventLabel(event.event_id)}
              </option>
            ))}
          </select>
        )}

        <span className="crm-count-note">
          {activeTab === 'abm' ? `${filteredAbm.length} members` : `${filteredSpeakers.length} speakers`}
        </span>
      </div>

      {activeTab === 'abm' && (
        <>
          {abmLoading && (
            <div className="crm-loading"><Loader2 size={16} className="crm-spin" /> Loading Advisory Board...</div>
          )}

          {abmError && (
            <div className="crm-error">Couldn't load Advisory Board: {abmError}</div>
          )}

          {!abmLoading && !abmError && (
            <div className="crm-table-wrap">
              <table className="crm-table" style={{ minWidth: 760 }}>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Company</th>
                    <th>Job Title</th>
                    <th style={{ width: 140 }}>Display Order</th>
                    <th style={{ width: 170 }}>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredAbm.map(row => {
                    const editing = editingAbmId === row.person_id
                    return (
                      <tr key={row.person_id}>
                        <td>
                          <div className="crm-name-cell">
                            <div className="crm-avatar" style={avatarStyle(`${row.first_name || ''} ${row.last_name || ''}`)}>
                              {initials(row.first_name, row.last_name)}
                            </div>
                            {`${row.first_name || ''} ${row.last_name || ''}`.trim() || `Person ${row.person_id}`}
                          </div>
                        </td>
                        <td>{row.companies?.company_name || '—'}</td>
                        <td>{row.job_title || '—'}</td>
                        <td>
                          {editing ? (
                            <input
                              className="crm-cell-input"
                              type="number"
                              min="0"
                              value={abmOrderDraft}
                              onChange={e => setAbmOrderDraft(e.target.value)}
                              style={{ maxWidth: 100 }}
                            />
                          ) : (
                            row.abm_order ?? '—'
                          )}
                        </td>
                        <td>
                          {editing ? (
                            <div className="crm-row-actions">
                              <button
                                className="crm-icon-action save"
                                onClick={() => saveAbmOrder(row)}
                                disabled={savingAbm}
                                title="Save order"
                              >
                                {savingAbm ? <Loader2 size={14} className="crm-spin" /> : <Save size={14} />}
                              </button>
                              <button
                                className="crm-icon-action cancel"
                                onClick={cancelAbmEdit}
                                disabled={savingAbm}
                                title="Cancel"
                              >
                                <X size={14} />
                              </button>
                            </div>
                          ) : (
                            <button className="crm-btn-secondary" onClick={() => startAbmEdit(row)}>
                              Edit Order
                            </button>
                          )}
                        </td>
                      </tr>
                    )
                  })}

                  {filteredAbm.length === 0 && (
                    <tr className="crm-empty-row">
                      <td colSpan={5}>No Advisory Board members found.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {activeTab === 'speakers' && (
        <>
          {!selectedEventId && (
            <div className="crm-loading">Select an event to view confirmed speakers.</div>
          )}

          {selectedEventId && speakersLoading && (
            <div className="crm-loading"><Loader2 size={16} className="crm-spin" /> Loading speakers...</div>
          )}

          {selectedEventId && speakersError && (
            <div className="crm-error">Couldn't load speakers: {speakersError}</div>
          )}

          {selectedEventId && !speakersLoading && !speakersError && (
            <div className="crm-table-wrap">
              <table className="crm-table" style={{ minWidth: 760 }}>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Company</th>
                    <th>Job Title</th>
                    <th style={{ width: 140 }}>Display Order</th>
                    <th style={{ width: 170 }}>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredSpeakers.map(row => {
                    const editing = editingSpeakerId === row.participant_id
                    const firstName = row.people?.first_name || ''
                    const lastName = row.people?.last_name || ''
                    return (
                      <tr key={row.participant_id}>
                        <td>
                          <div className="crm-name-cell">
                            <div className="crm-avatar" style={avatarStyle(`${firstName} ${lastName}`)}>
                              {initials(firstName, lastName)}
                            </div>
                            {`${firstName} ${lastName}`.trim() || `Person ${row.person_id}`}
                          </div>
                        </td>
                        <td>{row.companies?.company_name || '—'}</td>
                        <td>{row.people?.job_title || '—'}</td>
                        <td>
                          {editing ? (
                            <input
                              className="crm-cell-input"
                              type="number"
                              min="0"
                              value={speakerOrderDraft}
                              onChange={e => setSpeakerOrderDraft(e.target.value)}
                              style={{ maxWidth: 100 }}
                            />
                          ) : (
                            row.display_order ?? '—'
                          )}
                        </td>
                        <td>
                          {editing ? (
                            <div className="crm-row-actions">
                              <button
                                className="crm-icon-action save"
                                onClick={() => saveSpeakerOrder(row)}
                                disabled={savingSpeaker}
                                title="Save order"
                              >
                                {savingSpeaker ? <Loader2 size={14} className="crm-spin" /> : <Save size={14} />}
                              </button>
                              <button
                                className="crm-icon-action cancel"
                                onClick={cancelSpeakerEdit}
                                disabled={savingSpeaker}
                                title="Cancel"
                              >
                                <X size={14} />
                              </button>
                            </div>
                          ) : (
                            <button className="crm-btn-secondary" onClick={() => startSpeakerEdit(row)}>
                              Edit Order
                            </button>
                          )}
                        </td>
                      </tr>
                    )
                  })}

                  {filteredSpeakers.length === 0 && (
                    <tr className="crm-empty-row">
                      <td colSpan={5}>No confirmed speakers found for this event.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  )
}

// ============================================================================
// PEOPLE — live data, search, pagination. Display-only by default:
//  - clicking a row opens the full Person detail page
//  - a pencil icon on the row opens a lightweight inline edit for that one row
//  - a prominent "Convert to lead" button switches the whole table into a
//    multi-select mode (checkboxes + sticky selection bar + confirm step),
//    mirroring the Attendees "add people" flow, with sensible bulk defaults.
//
// Industry replaces Company as the primary at-a-glance column here — company
// name still exists on the record (via company_id) but isn't the thing
// people scan this table for; industry (Insurance / Banking / Finance) is,
// and it's filterable.
// ============================================================================
function PeoplePage({
  showToast,
  onOpenPerson,
  sidebarCollapsed,
  setSidebarCollapsed,
  leadEventMap,     
  onLeadCreated,       
  onLeadRemoved,      
}) {
  const [people, setPeople] = useState([])
  const [leadPersonIds, setLeadPersonIds] = useState(new Set())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [peoplePage, setPeoplePage] = useState(1)

  const STATUS_OPTIONS = useMemo(() => {
    const set = new Set(people.map(p => p.status).filter(Boolean))
    return Array.from(set).sort()
  }, [people])

  // Keep lead purpose filters consistent with the approved CRM choices only.
  // Do not pull historical values (such as Speaker Acquisition) back from the database.
  const COMBINED_PURPOSE_OPTIONS = LEAD_PURPOSE_CHOICES

  const [columnFilters, setColumnFilters] = useState({
    name: '',
    email: '',
    email1: '',
    job_title: '',
    industry: '',
    company: '',
    country: '',
    status: '',
    phone: '',
    mobile: '',
  })

  const [selectedEventId, setSelectedEventId] = useState('')

  const setColFilter = (key) => (e) =>
    setColumnFilters(prev => ({
      ...prev,
      [key]: e.target.value,
    }))

  // Sort state for the Company/Country columns only. Clicking the active
  // arrow a second time clears the sort back to the default order.
  const [sortConfig, setSortConfig] = useState({ column: null, direction: 'asc' })
  const toggleSort = (columnKey, direction) => {
    setSortConfig(prev =>
      prev.column === columnKey && prev.direction === direction
        ? { column: null, direction: 'asc' }
        : { column: columnKey, direction }
    )
  }
  const [events, setEvents] = useState([])
  const [eventsLoading, setEventsLoading] = useState(true)
  const [linkEventId, setLinkEventId] = useState('')

  const [pastEventsByPerson, setPastEventsByPerson] = useState({})
  const [pastEventsLoading, setPastEventsLoading] = useState(true)

  const [activeEventId, setActiveEventId] = useState(null)
  const [activeEventLoading, setActiveEventLoading] = useState(true)

  const [editingId, setEditingId] = useState(null)
  const [editForm, setEditForm] = useState(null)
  const [editCompany, setEditCompany] = useState(null)

const [expandedPersonId, setExpandedPersonId] = useState(null)
const [leadPurposeDraft, setLeadPurposeDraft] = useState('')
const [savingLeadPurpose, setSavingLeadPurpose] = useState(false)

const toggleExpand = (p) => {
  if (expandedPersonId === p.person_id) {
    setExpandedPersonId(null)
  } else {
    setExpandedPersonId(p.person_id)
    setLeadPurposeDraft(p.lead_purpose || '')
  }
}

const saveLeadPurpose = async (personId) => {
  setSavingLeadPurpose(true)
  const { error } = await supabase
    .from('people')
    .update({ lead_purpose: leadPurposeDraft || null, updated_at: new Date().toISOString() })
    .eq('person_id', personId)
  setSavingLeadPurpose(false)
  if (error) { showToast(`Couldn't save: ${error.message}`, true); return }
  setPeople(prev => prev.map(p => p.person_id === personId ? { ...p, lead_purpose: leadPurposeDraft || null } : p))
  showToast('Lead purpose updated')
  setExpandedPersonId(null)
}
  
  const [saving, setSaving] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState(null) // person object | null
  const [deleting, setDeleting] = useState(false)

  const [mode, setMode] = useState('browse')
  const [selectedPersonIds, setSelectedPersonIds] = useState(new Set())
  const [converting, setConverting] = useState(false)

  const [channelDefaults, setChannelDefaults] = useState(ALL_CHANNELS_ON)
  const [channelExceptions, setChannelExceptions] = useState(new Map())

  const wasSidebarCollapsedRef = useRef(sidebarCollapsed)

  // ============================================================
  // FETCH PEOPLE
  // ============================================================

  const fetchPeople = useCallback(async () => {
    setLoading(true)
    setError(null)

    const PAGE = 1000
    let allRows = []
    let from = 0

    while (true) {
      const { data, error } = await supabase
        .from('people')
        .select('*, companies(company_name, country)')
        .order('created_at', { ascending: false })
        .order('person_id', { ascending: true })
        .range(from, from + PAGE - 1)

      if (error) {
        setError(error.message)
        setLoading(false)
        return
      }

      allRows = allRows.concat(data || [])

      if (!data || data.length < PAGE) break

      from += PAGE
    }

    setPeople(allRows)
    setLoading(false)
  }, [])

  // ============================================================
  // FETCH ALL PEOPLE WHO HAVE ANY LEAD
  //
  // IMPORTANT:
  // No event_id filter here.
  //
  // If a person exists in the leads table even once,
  // they are considered a lead and will be hidden from People.
  // ============================================================

const fetchLeadPersonIds = useCallback(async () => {
  const PAGE = 1000
  let allRows = []
  let from = 0

  while (true) {
    const { data, error } = await supabase
      .from('leads')
      .select('person_id')
      .range(from, from + PAGE - 1)

    if (error) {
      setError(error.message)
      return
    }

    allRows = allRows.concat(data || [])
    if (!data || data.length < PAGE) break
    from += PAGE
  }

  const ids = new Set(
    allRows
      .map(row => row.person_id)
      .filter(Boolean)
  )

  setLeadPersonIds(ids)
}, [])

  // ============================================================
  // FETCH EVENTS
  // ============================================================

  const fetchEvents = useCallback(async () => {
    setEventsLoading(true)

    const { data, error } = await supabase
      .from('events')
      .select('event_id, event_name, start_date')
      .order('start_date', { ascending: false })

    if (!error) {
      setEvents(data || [])
    }

    setEventsLoading(false)
  }, [])

  // ============================================================
  // FETCH PAST EVENTS
  // ============================================================

  const fetchPastEvents = useCallback(async () => {
    setPastEventsLoading(true)

    const { data, error } = await supabase
      .from('event_participants')
      .select(
        'person_id, role, status, events(event_id, event_name, start_date)'
      )
      .order('start_date', {
        ascending: false,
        foreignTable: 'events',
      })

    if (!error) {
      const map = {}

      ;(data || []).forEach(row => {
        if (!row.events) return

        if (!map[row.person_id]) {
          map[row.person_id] = []
        }

        map[row.person_id].push({
          event_id: row.events.event_id,
          event_name: row.events.event_name,
          start_date: row.events.start_date,
          role: row.role,
          status: row.status,
        })
      })

      setPastEventsByPerson(map)
    }

    setPastEventsLoading(false)
  }, [])

  // ============================================================
  // FETCH ACTIVE EVENT
  // ============================================================

  const fetchActiveEventId = useCallback(async () => {
    setActiveEventLoading(true)

    const { data, error } = await supabase
      .from('events')
      .select('event_id')
      .eq('status', 'Active')
      .order('start_date', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (!error) {
      setActiveEventId(data?.event_id || null)
    }

    setActiveEventLoading(false)
  }, [])

  // ============================================================
  // INITIAL LOAD
  // ============================================================

  useEffect(() => {
    fetchPeople()
    fetchLeadPersonIds()
    fetchEvents()
    fetchPastEvents()
    fetchActiveEventId()
  }, [
    fetchPeople,
    fetchLeadPersonIds,
    fetchEvents,
    fetchPastEvents,
    fetchActiveEventId,
  ])

  // ============================================================
  // PEOPLE FILTER
  //
  // THIS IS THE IMPORTANT PART:
  //
  // If person_id exists in leads AT ALL,
  // don't show that person in People.
  // ============================================================

  const filtered = useMemo(() => {
    const f = columnFilters

    const name = f.name.toLowerCase().trim()
    const email = f.email.toLowerCase().trim()
    const email1 = f.email1.toLowerCase().trim()
    const jt = f.job_title.toLowerCase().trim()
    const company = f.company.toLowerCase().trim()
    const country = f.country.toLowerCase().trim()
    const phone = f.phone.toLowerCase().trim()  
    const mobile = f.mobile.toLowerCase().trim() 

    const result = people.filter(p => {

     if (selectedEventId && leadEventMap.get(p.person_id)?.has(selectedEventId)) {
      return false
    }

      const companyName = p.companies?.company_name || ''

      if (
        name &&
        !`${p.first_name} ${p.last_name}`
          .toLowerCase()
          .includes(name)
      ) {
        return false
      }

      if (
        email &&
        !(p.email || '')
          .toLowerCase()
          .includes(email)
      ) {
        return false
      }

      if (
        email1 &&
         !(p.email1 || '')
          .toLowerCase()
          .includes(email1)
     ) {
        return false
     } 
      
      if (
        jt &&
        !(p.job_title || '')
          .toLowerCase()
          .includes(jt)
      ) {
        return false
      }

      if (
        f.industry &&
        p.industry !== f.industry
      ) {
        return false
      }

if (company && !companyName.toLowerCase().startsWith(company)) {
  return false
}

if (country && !(p.country || '').toLowerCase().startsWith(country)) {
  return false
}

      if (
        f.status &&
        p.status !== f.status
      ) {
        return false
      }

   return true
    })

    if (sortConfig.column) {
      const dir = sortConfig.direction === 'asc' ? 1 : -1
      const getSortValue = (p) => {
        if (sortConfig.column === 'company') return (p.companies?.company_name || '').toLowerCase()
        if (sortConfig.column === 'country') return (p.country || '').toLowerCase()
        return ''
      }
      result.sort((a, b) => {
        const av = getSortValue(a)
        const bv = getSortValue(b)
        if (av < bv) return -1 * dir
        if (av > bv) return 1 * dir
        return 0
      })
    }

    return result
  }, [
    people,
    columnFilters,
    selectedEventId,
    leadPersonIds,
    sortConfig,
  ])

  useEffect(() => {
    setPeoplePage(1)
  }, [columnFilters, selectedEventId, sortConfig])

  // ============================================================
  // EDIT PERSON
  // ============================================================

  const startEdit = (p) => {
    setEditingId(p.person_id)

    setEditForm({
      first_name: p.first_name || '',
      last_name: p.last_name || '',
      email: p.email || '',
      email1: p.email1 || '',
      job_title: p.job_title || '',
      phone: p.phone || '',
      mobile: p.mobile || '',
      notes: p.notes || '',
      country: p.country || '',
      status: p.status || '',
      industry: p.industry || '',
      linkedin_url: p.linkedin_url || '',
    })

    setEditCompany(
      p.companies
        ? {
            company_id: p.company_id,
            company_name: p.companies.company_name,
            country: p.companies.country || '',
          }
        : null
    )
  }

  const cancelEdit = () => {
    setEditingId(null)
    setEditForm(null)
    setEditCompany(null)
  }

 const saveEdit = async (personId) => {
  setSaving(true)

  const { companyId, error: companyError } = await resolveCompanyId(editCompany)
  if (companyError) {
    setSaving(false)
    showToast(`Couldn't save company: ${companyError.message}`, true)
    return
  }

  const { error } = await supabase
    .from('people')
    .update({
      ...editForm,
      email: editForm.email?.trim() || null,
      email1: editForm.email1?.trim() || null,
      company_id: companyId,
      updated_at: new Date().toISOString(),
    })
    .eq('person_id', personId)

  setSaving(false)

  if (error) {
    showToast(`Couldn't save: ${error.message}`, true)
    return
  }

  setPeople(prev =>
    prev.map(p =>
      p.person_id === personId
        ? {
            ...p,
            ...editForm,
            company_id: companyId,
            companies: editCompany
              ? { company_name: editCompany.company_name, country: editCompany.country }
              : null,
          }
        : p
    )
  )

  setEditingId(null)
  setEditForm(null)
  setEditCompany(null)
  showToast('Person updated')
}
  // ============================================================
  // DELETE PERSON
  // ============================================================

  const deletePerson = async (person) => {
    setDeleting(true)
    const { error } = await supabase
      .from('people')
      .delete()
      .eq('person_id', person.person_id)
    setDeleting(false)

    if (error) {
      showToast(`Couldn't delete: ${error.message}`, true)
      return
    }

    setPeople(prev => prev.filter(p => p.person_id !== person.person_id))
    setLeadPersonIds(prev => {
      if (!prev.has(person.person_id)) return prev
      const next = new Set(prev)
      next.delete(person.person_id)
      return next
    })
    if (editingId === person.person_id) cancelEdit()
    setDeleteTarget(null)
    showToast('Person deleted')
  }

  // ============================================================
  // START CONVERT
  // ============================================================

  const startConvert = () => {
    if (!selectedEventId) {
      showToast(
        'Pick a Event',
        true
      )
      return
    }

    wasSidebarCollapsedRef.current =
      sidebarCollapsed

    setSidebarCollapsed(true)
    setMode('select')
    setSelectedPersonIds(new Set())
    setChannelDefaults(ALL_CHANNELS_ON)
    setChannelExceptions(new Map())
    setLinkEventId('')
    cancelEdit()
  }

  const cancelConvert = () => {
    setSidebarCollapsed(
      wasSidebarCollapsedRef.current
    )

    setMode('browse')
    setSelectedPersonIds(new Set())
    setChannelExceptions(new Map())
  }

  // ============================================================
  // SELECTION
  // ============================================================

  const togglePerson = (personId) => {
    // This should normally never happen because filtered already
    // removes every person who has a lead.
    if (leadPersonIds.has(personId)) return

    setSelectedPersonIds(prev => {
      const next = new Set(prev)

      if (next.has(personId)) {
        next.delete(personId)
      } else {
        next.add(personId)
      }

      return next
    })
  }

  const removeFromSelection = (personId) => {
    togglePerson(personId)

    setChannelExceptions(prev => {
      if (!prev.has(personId)) {
        return prev
      }

      const next = new Map(prev)
      next.delete(personId)

      return next
    })
  }

  const selectAllFiltered = () => {
    setSelectedPersonIds(
      new Set(
        filtered.map(p => p.person_id)
      )
    )
  }

  const selectAllOnPage = () => {
    const pageIds = paginate(
      filtered,
      peoplePage
    ).map(p => p.person_id)

    setSelectedPersonIds(
      prev => new Set([
        ...prev,
        ...pageIds,
      ])
    )
  }

  const clearSelection = () => {
    setSelectedPersonIds(new Set())
    setChannelExceptions(new Map())
  }

  const handleLinkEventChange = (e) => {
    setLinkEventId(e.target.value)
  }

  // ============================================================
  // CHANNELS
  // ============================================================

  const toggleChannelDefault = (key) => {
    const cf = CHANNEL_FIELDS.find(
      c => c.key === key
    )

    if (!cf?.live) return

    setChannelDefaults(prev => ({
      ...prev,
      [key]: !prev[key],
    }))
  }

  const toggleChannelException = (
    personId,
    key
  ) => {
    const cf = CHANNEL_FIELDS.find(
      c => c.key === key
    )

    if (!cf?.live) return

    setChannelExceptions(prev => {
      const next = new Map(prev)

      const set = new Set(
        next.get(personId) || []
      )

      if (set.has(key)) {
        set.delete(key)
      } else {
        set.add(key)
      }

      next.set(personId, set)

      return next
    })
  }

  const effectiveChannelValue = (
    personId,
    key
  ) => {
    const isException =
      channelExceptions
        .get(personId)
        ?.has(key)

    return isException
      ? !channelDefaults[key]
      : channelDefaults[key]
  }

  // ============================================================
  // CONVERT TO LEAD
  // ============================================================

  const submitConvert = async () => {
    setConverting(true)

    const selectedPeople =
      people.filter(p =>
        selectedPersonIds.has(
          p.person_id
        )
      )

    const rows = selectedPeople.map(p => ({
      person_id: p.person_id,
      company_id: p.company_id || null,

      event_id: selectedEventId,

      lead_status: 'New',
      nurture_stage: 'Outreach',

      ...buildChannelRowFields(
        effectiveChannelValue,
        p.person_id
      ),
    }))

    const {
      data: inserted,
      error,
    } = await supabase
      .from('leads')
      .insert(rows)
      .select('lead_id, person_id')

    setConverting(false)

    if (error) {
      showToast(
        `Couldn't create leads: ${error.message}`,
        true
      )
      return
    }

    // ==========================================================
    // IMPORTANT:
    // Immediately mark these people as leads.
    //
    // This makes them disappear from People without
    // requiring a page refresh.
    // ==========================================================

setLeadPersonIds(prev => {
  const next = new Set(prev)
  rows.forEach(row => {
    next.add(row.person_id)
  })
  return next
})

rows.forEach(row => onLeadCreated?.(row.person_id, selectedEventId))

fetchPeople()
fetchLeadPersonIds()
    
const newLeadIds = (inserted || []).map(r => r.lead_id)
const count = rows.length

showToast(
  `${count} ${count === 1 ? 'lead' : 'leads'} created`,
  false,
  newLeadIds.length > 0
    ? async () => {
        const { error: undoError } = await supabase
          .from('leads')
          .delete()
          .in('lead_id', newLeadIds)

        if (undoError) {
          showToast(`Couldn't undo: ${undoError.message}`, true)
          return
        }

            // Put them back into People
            // because their lead was removed.
            setLeadPersonIds(prev => {
              const next = new Set(prev)

              rows.forEach(row => {
                next.delete(
                  row.person_id
                )
              })

              return next
            })

           rows.forEach(row => onLeadRemoved?.(row.person_id, selectedEventId))
      
           fetchPeople()
        fetchLeadPersonIds()

        showToast(`Undone — ${count} ${count === 1 ? 'lead' : 'leads'} removed`)
      }
    : null
    )

    setSidebarCollapsed(
      wasSidebarCollapsedRef.current
    )

    setMode('browse')
    setSelectedPersonIds(new Set())
    setChannelExceptions(new Map())
  }

  const selecting = mode === 'select'

  const COLUMN_COUNT =
    selecting ? 15 : 14

  // ============================================================
  // TABLE
  // ============================================================

  const table = (
    <div>
      <div className="crm-toolbar">

        {selecting ? (
          <>
            <button
              className="crm-toggle-chip"
              onClick={selectAllOnPage}
            >
              Select all on this page
            </button>

            {selectedPersonIds.size > 0 && (
              <button
                className="crm-toggle-chip"
                onClick={clearSelection}
              >
                Clear selection
              </button>
            )}

            <button
              className="crm-btn-secondary"
              onClick={cancelConvert}
            >
              Cancel
            </button>
          </>
        ) : (
          <>
           <select
              className="crm-filter-select"
              value={selectedEventId}
              onChange={e => setSelectedEventId(e.target.value)}
              disabled={eventsLoading}
             >
  <option value="">Select event…</option>
  {events.map(e => (
    <option key={e.event_id} value={e.event_id}>
      {e.event_name} ({formatDate(e.start_date)})
    </option>
  ))}
</select>

            <button
              className="crm-submit-btn"
              style={{
                width: 'auto',
                padding: '10px 18px',
              }}
              onClick={startConvert}
            >
              <UserPlus size={15} />
              Convert to lead
            </button>
          </>
        )}

        <span className="crm-count-note">
          {filtered.length} of {people.length}
        </span>
      </div>

      {loading && (
        <div className="crm-loading">
          <Loader2
            size={16}
            className="crm-spin"
          />
          Loading people…
        </div>
      )}

      {error && (
        <div className="crm-error">
          Couldn't load people: {error}
        </div>
      )}

      {!loading && !error && (
        <div className="crm-table-wrap">
          <table className="crm-table">

            <thead>
              <tr>
                {selecting && (
                  <th style={{ width: 36 }} />
                )}

                {selecting && (
                  <th style={{ width: 76 }} />
                )}

                <th>Name</th>
                <th>Email</th>
                <th>Email 1</th>
                <th>Job title</th>
                <th>Phone</th>
                <th>Mobile</th>
                <th>Notes</th>
                <th>Industry</th>
                <th>Company</th>
                <th>Country</th>
                <th>LinkedIn</th>
                <th>Status</th>
                <th>Past Events</th>

                {!selecting && <th />}
              </tr>

              <tr>
                {selecting && <th />}
                {selecting && <th />}

                <th>
                  <input
                    className="crm-cell-input"
                    value={columnFilters.name}
                    onChange={setColFilter('name')}
                    placeholder="Filter…"
                  />
                </th>

                <th>
                  <input
                    className="crm-cell-input"
                    value={columnFilters.email}
                    onChange={setColFilter('email')}
                    placeholder="Filter…"
                  />
                </th>
                <th>
               <input 
                   className="crm-cell-input" 
                   value={columnFilters.email1} 
                   onChange={setColFilter('email1')} 
                   placeholder="Filter…" 
                 />
                </th>

               <th>
                  <input
                    className="crm-cell-input"
                    value={columnFilters.job_title}
                    onChange={setColFilter('job_title')}
                    placeholder="Filter…"
                  />
                </th>
                <th><input
                      className="crm-cell-input"
                      value={columnFilters.phone}
                      onChange={setColFilter('phone')}
                      placeholder="Filter…"
                      />
                </th>
                <th><input
                      className="crm-cell-input"
                      value={columnFilters.mobile}
                      onChange={setColFilter('mobile')}
                      placeholder="Filter…"
                      />
                </th>
                <th />
               <th>
                 <select
                     className="crm-cell-select"
                     value={columnFilters.industry}
                     onChange={setColFilter('industry')}
                  >
               <option value="">All</option>
               {INDUSTRY_OPTIONS.map(i => (
              <option key={i} value={i}>{i}</option>
                 ))}
                </select>
                </th>
               
                <th>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <input
                      className="crm-cell-input"
                      value={columnFilters.company}
                      onChange={setColFilter('company')}
                      placeholder="Filter…"
                    />
                    <SortButtons columnKey="company" sortConfig={sortConfig} onSort={toggleSort} />
                  </div>
                </th>

                <th>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <input
                      className="crm-cell-input"
                      value={columnFilters.country}
                      onChange={setColFilter('country')}
                      placeholder="Filter…"
                    />
                    <SortButtons columnKey="country" sortConfig={sortConfig} onSort={toggleSort} />
                  </div>
                </th>

                <th />

                <th>
                  <select
                    className="crm-cell-select"
                    value={columnFilters.status}
                    onChange={setColFilter('status')}
                  >
                    <option value="">
                      All
                    </option>

                    {STATUS_OPTIONS.map(s => (
                      <option
                        key={s}
                        value={s}
                      >
                        {s}
                      </option>
                    ))}
                  </select>
                </th>

                <th />

                {!selecting && <th />}
              </tr>
            </thead>

            <tbody>
              {paginate(
                filtered,
                peoplePage
              ).map(p => {

                const av = avatarStyle(
                  p.first_name +
                    p.last_name
                )

                // This should normally always be false
                // because filtered already excludes leads.
                const alreadyLead =
                  leadPersonIds.has(
                    p.person_id
                  )

      const isEditing = editingId === p.person_id

const history = pastEventsByPerson[p.person_id] || []

const pastEventsCell = (
  <td>
    {pastEventsLoading ? (
      <span className="crm-muted">…</span>
    ) : history.length === 0 ? (
      <span className="crm-muted">—</span>
    ) : (
      history.map(h => h.event_id).join(', ')
    )}
  </td>
)

if (isEditing) {
  return (
    <tr key={p.person_id} className="editing">
      {selecting && <td />}
      {selecting && <td />}

      <td>
        <input
          className="crm-cell-input"
          value={editForm.first_name}
          onChange={e => setEditForm({ ...editForm, first_name: e.target.value })}
          placeholder="First name"
        />
        <input
          className="crm-cell-input"
          value={editForm.last_name}
          onChange={e => setEditForm({ ...editForm, last_name: e.target.value })}
          placeholder="Last name"
        />
      </td>

      <td>
        <input
          className="crm-cell-input"
          value={editForm.email}
          onChange={e => setEditForm({ ...editForm, email: e.target.value })}
        />
      </td>
      <td>
        <input
          className="crm-cell-input"
          value={editForm.email1}
          onChange={e => setEditForm({ ...editForm, email1: e.target.value })}
        />
      </td>

      <td>
        <input
          className="crm-cell-input"
          value={editForm.job_title}
          onChange={e => setEditForm({ ...editForm, job_title: e.target.value })}
        />
      </td>
      <td><input
            className="crm-cell-input"
            value={editForm.phone}
            onChange={e => setEditForm({ ...editForm, phone: e.target.value })}
            />
      </td>
      <td><input
            className="crm-cell-input"
            value={editForm.mobile} onChange={e => setEditForm({ ...editForm, mobile: e.target.value })}
            />
      </td>
      <td>
        <input
          className="crm-cell-input"
          value={editForm.notes}
          onChange={e => setEditForm({ ...editForm, notes: e.target.value })}
          placeholder="Notes"
        />
      </td>

      <td>
        <select
          className="crm-cell-select"
          value={editForm.industry}
          onChange={e => setEditForm({ ...editForm, industry: e.target.value })}
        >
          <option value="">—</option>
          {INDUSTRY_OPTIONS.map(i => (
            <option key={i} value={i}>{i}</option>
          ))}
        </select>
      </td>

      <td>
        <CompanyPicker
          value={editCompany}
          onChange={setEditCompany}
          showToast={showToast}
        />
      </td>

      <td>
        <input
          className="crm-cell-input"
          value={editForm.country}
          onChange={e => setEditForm({ ...editForm, country: e.target.value })}
        />
      </td>

      {/* LinkedIn — now the single, editable column. The old read-only
          <a> link that used to live here was removed: having both was
          adding an extra column that pushed everything after it (Status,
          Past Events, actions) out of alignment with the header row. */}
      <td>
        <input
          className="crm-cell-input"
          value={editForm.linkedin_url}
          onChange={e => setEditForm({ ...editForm, linkedin_url: e.target.value })}
          placeholder="linkedin.com/in/…"
        />
      </td>

      <td>
        <select
          className="crm-cell-select"
          value={editForm.status}
          onChange={e => setEditForm({ ...editForm, status: e.target.value })}
        >
          <option value="">—</option>
          {STATUS_OPTIONS.map(s => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
      </td>

      {pastEventsCell}

      <td>
        <div className="crm-row-actions">
          <button
            className="crm-icon-action save"
            onClick={() => saveEdit(p.person_id)}
            disabled={saving}
            aria-label="Save"
          >
            {saving ? <Loader2 size={14} className="crm-spin" /> : <Save size={14} />}
          </button>
          <button className="crm-icon-action cancel" onClick={cancelEdit} aria-label="Cancel">
            <XCircle size={14} />
          </button>
        </div>
      </td>
    </tr>
  )
}

return (
  <Fragment key={p.person_id}>
    <tr
      className="clickable"
     onClick={() => {
  if (selecting) {
    togglePerson(p.person_id)
  } else {
   openPersonInNewTab(p.person_id, filtered.map(x => x.person_id))
  }
}}
    >
      {selecting && (
        <td>
          <input
            type="checkbox"
            checked={selectedPersonIds.has(p.person_id)}
            onChange={() => togglePerson(p.person_id)}
            onClick={e => e.stopPropagation()}
          />
        </td>
      )}

      {selecting && (
        <td>
          <div className="crm-row-actions">
            <button
              className="crm-icon-action"
              onClick={e => {
                e.stopPropagation()
                // Opens in a NEW tab instead of navigating this one, so
                // viewing someone's profile mid-selection never discards
                // the batch you've already built up in the side panel.
                openPersonInNewTab(p.person_id, filtered.map(x => x.person_id))
              }}
              aria-label="View details"
              title="View details (opens in a new tab)"
            >
              <Eye size={14} />
            </button>

            <button
              className="crm-icon-action"
              onClick={e => { e.stopPropagation(); startEdit(p) }}
              aria-label="Edit person"
              title="Edit"
            >
              <Pencil size={14} />
            </button>

            <button
              className="crm-icon-action cancel"
              onClick={e => { e.stopPropagation(); setDeleteTarget(p) }}
              aria-label="Delete person"
              title="Delete"
            >
              <Trash2 size={14} />
            </button>
          </div>
        </td>
      )}

      <td>
        <div className="crm-name-cell">
          <div className="crm-avatar" style={{ background: av.bg, color: av.fg }}>
            {initials(p.first_name, p.last_name)}
          </div>
          <span>{p.first_name} {p.last_name}</span>
          {alreadyLead && <span className="crm-lead-tag">Lead</span>}
        </div>
      </td>

       <td>{p.email}</td>
      <td>{p.email1 || '-'}</td>
      <td>{p.job_title || '-'}</td>
      <td>{p.phone || '—'}</td>
      <td>{p.mobile || '—'}</td>
      <td className="crm-notes-cell" title={p.notes || ''}>{p.notes || '—'}</td>
      <td>{p.industry || '-'}</td>
      <td>{p.companies?.company_name || '—'}</td>
      <td>{p.country || '—'}</td>

       <td>
        {p.linkedin_url ? (
          
            <a href={externalUrl(p.linkedin_url)}
            target="_blank"
            rel="noreferrer"
            onClick={e => e.stopPropagation()}
          >
            View ↗
          </a>
        ) : (
          '—'
        )}
      </td>

      <td><Badge value={p.status} /></td>

      {pastEventsCell}

      {!selecting && (
        <td>
          <div className="crm-row-actions">
            <button
              className="crm-icon-action"
              onClick={e => {
                e.stopPropagation()
                toggleExpand(p)
              }}
              aria-label={expandedPersonId === p.person_id ? 'Collapse' : 'Edit lead purpose'}
              title="Edit lead purpose"
            >
              {expandedPersonId === p.person_id ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            </button>

            <button
              className="crm-icon-action"
              onClick={e => { e.stopPropagation(); startEdit(p) }}
              aria-label="Edit person"
              title="Edit"
            >
              <Pencil size={14} />
            </button>

            <button
              className="crm-icon-action cancel"
              onClick={e => { e.stopPropagation(); setDeleteTarget(p) }}
              aria-label="Delete person"
              title="Delete"
            >
              <Trash2 size={14} />
            </button>
          </div>
        </td>
      )}
    </tr>

    {expandedPersonId === p.person_id && (
      <tr>
        <td colSpan={COLUMN_COUNT} style={{ background: 'var(--paper)', padding: '14px 18px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <FieldLabel>Lead purpose</FieldLabel>
            <select
              className="crm-select"
              style={{ maxWidth: 260 }}
              value={leadPurposeDraft}
              onChange={e => setLeadPurposeDraft(e.target.value)}
            >
              <option value="">—</option>
              {COMBINED_PURPOSE_OPTIONS.map(opt => (
                <option key={opt} value={opt}>{opt}</option>
              ))}
            </select>
            <button
              className="crm-icon-action save"
              onClick={() => saveLeadPurpose(p.person_id)}
              disabled={savingLeadPurpose}
              aria-label="Save lead purpose"
            >
              {savingLeadPurpose ? <Loader2 size={14} className="crm-spin" /> : <Save size={14} />}
            </button>
            <button
              className="crm-icon-action cancel"
              onClick={() => setExpandedPersonId(null)}
              aria-label="Cancel"
            >
              <XCircle size={14} />
            </button>
          </div>
        </td>
      </tr>
    )}
  </Fragment>
)
})}

{filtered.length === 0 && (
                <tr className="crm-empty-row"><td colSpan={14}>No leads match these filters.</td></tr>
              )}
</tbody>
</table>

<Pagination page={peoplePage} setPage={setPeoplePage} total={filtered.length} />
</div>
)}

{deleteTarget && (
<div className="crm-modal-overlay">
  <div className="crm-modal-backdrop" onClick={() => !deleting && setDeleteTarget(null)} />
  <div className="crm-modal-card" style={{ maxWidth: 380 }}>
    <h4 className="crm-confirm-heading">
      Delete {deleteTarget.first_name} {deleteTarget.last_name}?
    </h4>
    <p className="crm-confirm-note">
      This permanently removes them from Supabase. This can't be undone.
    </p>
    <div className="crm-confirm-actions">
      <button className="crm-btn-secondary" onClick={() => setDeleteTarget(null)} disabled={deleting}>
        Cancel
      </button>
      <button
        className="crm-submit-btn"
        style={{ width: 'auto', padding: '10px 20px', background: 'var(--red)' }}
        onClick={() => deletePerson(deleteTarget)}
        disabled={deleting}
      >
        {deleting ? <Loader2 size={15} className="crm-spin" /> : <Trash2 size={15} />}
        Delete person
      </button>
    </div>
  </div>
</div>
)}
</div>
)
  // ============================================================
  // NO SELECTION
  // ============================================================

  if (
    !selecting ||
    selectedPersonIds.size === 0
  ) {
    return table
  }

  // ============================================================
  // SELECTED PEOPLE
  // ============================================================

  const selectedItems = people
    .filter(p =>
      selectedPersonIds.has(
        p.person_id
      )
    )
    .map(p => {

      const activeWarnings =
        CHANNEL_FIELDS
          .filter(
            cf =>
              cf.live &&
              effectiveChannelValue(
                p.person_id,
                cf.key
              )
          )
          .map(cf =>
            channelReadinessWarning(
              p,
              cf.key
            )
          )
          .filter(Boolean)

      const companyName =
        p.companies?.company_name ||
        ''

      return {
        id: p.person_id,
        primary: `${p.first_name} ${p.last_name}`,
        secondary:
          `${p.email}` +
          `${p.industry ? ' · ' + p.industry : ''}` +
          `${companyName ? ' · ' + companyName : ''}`,
        warning:
          activeWarnings.length > 0
            ? activeWarnings.join(' ')
            : null,
      }
    })

  return (
    <div className="crm-split-layout">

      <div className="crm-split-main">
        {table}
      </div>

      <div className="crm-split-side">
        <div className="crm-side-panel">

          <h4 className="crm-confirm-heading">
            {selectedPersonIds.size}{' '}
            selected
          </h4>

          <p className="crm-confirm-note">
            Every live channel starts on
            for everyone. Click a chip
            below to turn a channel off
            for the whole batch, or click
            a person's chip to except just
            them.
          </p>

          <div
            className="crm-channel-toggles"
            style={{
              marginBottom: 16,
            }}
          >
            {CHANNEL_FIELDS.map(cf => (
              <button
                key={cf.key}
                type="button"
                disabled={!cf.live}
                className={`crm-channel-toggle${
                  channelDefaults[
                    cf.key
                  ]
                    ? ''
                    : ' off'
                }${
                  !cf.live
                    ? ' disabled-live'
                    : ''
                }`}
                onClick={() =>
                  toggleChannelDefault(
                    cf.key
                  )
                }
                title={
                  !cf.live
                    ? 'Not wired to an active automation yet'
                    : undefined
                }
              >
                {channelDefaults[
                  cf.key
                ] ? (
                  <Check size={11} />
                ) : (
                  <X size={11} />
                )}{' '}
                {cf.label}
                {!cf.live
                  ? ' (inactive)'
                  : ''}
              </button>
            ))}
          </div>

          <div className="crm-confirm-list">

            {selectedItems.map(item => (
              <div
                key={item.id}
                className="crm-confirm-row"
                style={{
                  flexDirection:
                    'column',
                  alignItems:
                    'stretch',
                  gap: 8,
                }}
              >

                <div
                  style={{
                    display: 'flex',
                    alignItems:
                      'center',
                    justifyContent:
                      'space-between',
                  }}
                >
                  <div>
                    <div className="crm-confirm-row-name">
                      {item.primary}
                    </div>

                    <div className="crm-confirm-row-sub">
                      {item.secondary}
                    </div>
                  </div>

                  <button
                    className="crm-remove-x"
                    onClick={() =>
                      removeFromSelection(
                        item.id
                      )
                    }
                    aria-label={`Remove ${item.primary}`}
                  >
                    <X size={14} />
                  </button>
                </div>

                <div className="crm-channel-toggles">

                  {CHANNEL_FIELDS.map(
                    cf => {

                      const on =
                        effectiveChannelValue(
                          item.id,
                          cf.key
                        )

                      return (
                        <button
                          key={cf.key}
                          type="button"
                          disabled={
                            !cf.live
                          }
                          className={`crm-channel-toggle${
                            on
                              ? ''
                              : ' off'
                          }${
                            !cf.live
                              ? ' disabled-live'
                              : ''
                          }`}
                          onClick={() =>
                            toggleChannelException(
                              item.id,
                              cf.key
                            )
                          }
                          title={
                            !cf.live
                              ? 'Not wired to an active automation yet'
                              : undefined
                          }
                        >
                          {on ? (
                            <Check
                              size={10}
                            />
                          ) : (
                            <X size={10} />
                          )}{' '}
                          {cf.label}
                        </button>
                      )
                    }
                  )}

                </div>

                {item.warning && (
                  <div className="crm-warn-note">
                    <AlertTriangle
                      size={12}
                      style={{
                        flexShrink: 0,
                        marginTop: 1,
                      }}
                    />
                    {item.warning}
                  </div>
                )}

              </div>
            ))}

          </div>

          <button
            className="crm-submit-btn"
            onClick={submitConvert}
            disabled={converting}
          >
            {converting ? (
              <Loader2
                size={15}
                className="crm-spin"
              />
            ) : (
              <Check size={15} />
            )}

            Confirm & create{' '}
            {selectedPersonIds.size}
          </button>

        </div>
      </div>
    </div>
  )
}
// ============================================================================
// LEADS — live data. Company lives on the person's record now, so it stays
// dropped from this table. Each outreach channel gets its own status column
// instead of a combined summary. Clicking a row opens the full Lead detail
// page, where everything is edited.
// ============================================================================
function LeadsPage({ showToast, onOpenLead }) {
  // NEW: which event's leads we're viewing. null = show the picker.
  const [selectedEventId, setSelectedEventId] = useState(null) // event_id string | 'NONE' | null
  const [pickerEvents, setPickerEvents] = useState([])
  const [pickerEventsLoading, setPickerEventsLoading] = useState(true)

  const fetchPickerEvents = useCallback(async () => {
    setPickerEventsLoading(true)
    const { data, error } = await supabase
      .from('events')
      .select('event_id, event_name, start_date, status')
      .order('start_date', { ascending: false })
    if (!error) setPickerEvents(data || [])
    setPickerEventsLoading(false)
  }, [])

  useEffect(() => { fetchPickerEvents() }, [fetchPickerEvents])

  // Human-readable label for whichever event is currently selected, used in
  // the "Viewing: ..." toolbar line below. 'NONE' means general leads with
  // no event_id — everything else is looked up by id from pickerEvents.
  const selectedEventLabel = useMemo(() => {
    if (selectedEventId === 'NONE') return 'No event (general leads)'
    return pickerEvents.find(e => e.event_id === selectedEventId)?.event_name || selectedEventId
  }, [selectedEventId, pickerEvents])

  const [leads, setLeads] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [activeOnly, setActiveOnly] = useState(true)
  const [leadsPage, setLeadsPage] = useState(1)

  const [activeEvent, setActiveEvent] = useState(null)
  const [activeEventLoading, setActiveEventLoading] = useState(true)
  const [convertingLeadId, setConvertingLeadId] = useState(null)

  const [stageLabels, setStageLabels] = useState({})
  useEffect(() => {
    (async () => {
      const { data, error } = await supabase
        .from('systems_tables')
        .select('config2, description')
        .eq('system_name', 'Email Outreach')
      if (!error && data) {
        const map = {}
        data.forEach(r => { map[(r.config2 || '').toString().trim()] = r.description })
        setStageLabels(map)
      }
    })()
  }, [])

  const emailStageLabel = (code) => stageLabels[(code || '').toString().trim()] || code

  const fetchActiveEvent = useCallback(async () => {
    setActiveEventLoading(true)
    const { data, error } = await supabase
      .from('events')
      .select('event_id, event_name, start_date, end_date, status')
      .eq('status', 'Active')
      .order('start_date', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (error) {
      showToast(`Couldn't load active event: ${error.message}`, true)
      setActiveEvent(null)
    } else {
      setActiveEvent(data || null)
    }
    setActiveEventLoading(false)
  }, [showToast])

  useEffect(() => { fetchActiveEvent() }, [fetchActiveEvent])

  // Fetches leads for the currently selected event only. 'NONE' means
  // general leads with no event_id. Single request with an explicit high
  // .range() ceiling (not a page loop) so PostgREST's default row cap can't
  // silently truncate results once lead counts grow.
  const fetchLeads = useCallback(async () => {
    if (!selectedEventId) return
    setLoading(true)
    setError(null)
    const PAGE = 1000
    let allRows = []
    let from = 0
    while (true) {
      let query = supabase
        .from('leads')
        .select('*, people(first_name, last_name, owner_email)')
        .order('created_at', { ascending: false })
        .order('lead_id', { ascending: true })
        .range(from, from + PAGE - 1)
      query = selectedEventId === 'NONE' ? query.is('event_id', null) : query.eq('event_id', selectedEventId)
      const { data, error } = await query
      if (error) { setError(error.message); setLoading(false); return }
      allRows = allRows.concat(data || [])
      if (!data || data.length < PAGE) break
      from += PAGE
    }
    setLeads(allRows)
    setLoading(false)
  }, [selectedEventId])

  useEffect(() => { fetchLeads() }, [fetchLeads])

  const convertLeadToAttendee = async (lead) => {
    if (!activeEvent) {
      showToast('No active event found', true)
      return
    }
    setConvertingLeadId(lead.lead_id)
    const { data: existing, error: checkError } = await supabase
      .from('event_participants')
      .select('participant_id')
      .eq('event_id', activeEvent.event_id)
      .eq('person_id', lead.person_id)
      .maybeSingle()
    if (checkError) {
      setConvertingLeadId(null)
      showToast(`Couldn't check attendee: ${checkError.message}`, true)
      return
    }
    if (existing) {
      setConvertingLeadId(null)
      showToast(`This person is already an attendee for ${activeEvent.event_name}`, true)
      return
    }
    const { error: insertError } = await supabase
      .from('event_participants')
      .insert({
        event_id: activeEvent.event_id,
        person_id: lead.person_id,
        company_id: lead.company_id || null,
        role: 'Attendee',
        status: 'Invited',
      })
    setConvertingLeadId(null)
    if (insertError) { showToast(`Couldn't add attendee: ${insertError.message}`, true); return }
    showToast(`${lead.people?.first_name || 'Person'} added to ${activeEvent.event_name}`)
  }

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim()
    return leads.filter(l => {
      if (statusFilter && l.lead_status !== statusFilter) return false
      if (activeOnly && l.lead_status === 'Unsubscribed') return false
      if (!q) return true
      const personName = `${l.people?.first_name || ''} ${l.people?.last_name || ''}`
      return `${personName} ${l.lead_purpose || ''} ${l.people?.owner_email || ''}`.toLowerCase().includes(q)
    })
  }, [leads, search, statusFilter, activeOnly])

  useEffect(() => { setLeadsPage(1) }, [search, statusFilter, activeOnly, selectedEventId])

  // -------------------------------------------------------------------------
  // Step 1: event picker — shown until an event (or "no event") is chosen.
  // -------------------------------------------------------------------------
if (!selectedEventId) {
    return (
      <div>
        <p className="crm-confirm-note" style={{ marginBottom: 16 }}>
          Pick an event to see its leads.
        </p>
        {pickerEventsLoading && <div className="crm-loading"><Loader2 size={16} className="crm-spin" /> Loading events…</div>}
        {!pickerEventsLoading && pickerEvents.length === 0 && (
          <div className="crm-confirm-empty" style={{ border: '1px solid var(--line)', borderRadius: 12 }}>
            No events yet — create one first.
          </div>
        )}
        {!pickerEventsLoading && pickerEvents.length > 0 && (
          <div className="crm-event-picker-grid">
            {pickerEvents.map(e => (
              <button
                key={e.event_id}
                type="button"
                className="crm-event-picker-card"
                onClick={() => setSelectedEventId(e.event_id)}
              >
                <div className="crm-event-picker-card-top">
                  <span className="crm-event-picker-card-icon"><Calendar size={15} /></span>
                  <Badge value={e.status} />
                </div>
                <div className="crm-event-picker-card-name">{e.event_name}</div>
                <div className="crm-event-picker-card-date">
                  <Clock size={12} style={{ marginRight: 4, verticalAlign: -2 }} />
                  {formatDate(e.start_date)}
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    )
  }
  // -------------------------------------------------------------------------
  // Step 2: leads table, scoped to selectedEventId.
  // -------------------------------------------------------------------------
  return (
    <div>
      <div className="crm-toolbar">
        <button className="crm-btn-secondary" onClick={() => setSelectedEventId(null)}>
          ← Change event
        </button>
        <span className="crm-count-note" style={{ marginLeft: 0 }}>Viewing: <b style={{ color: 'var(--ink-950)' }}>{selectedEventLabel}</b></span>

        <div className="crm-search-box">
          <Search size={15} style={{ color: 'var(--ink-400)' }} />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search person, purpose, owner…" />
        </div>

        <select className="crm-filter-select" value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
          <option value="">All statuses</option>
          {LEAD_STATUS_OPTIONS.map(s => <option key={s} value={s}>{s}</option>)}
        </select>

        <button className={`crm-toggle-chip${activeOnly ? ' on' : ''}`} onClick={() => setActiveOnly(v => !v)}>
          {activeOnly ? <Check size={13} /> : null}
          Active campaigns only
        </button>

        <span className="crm-count-note">
          {activeEventLoading ? 'Loading active event…' : activeEvent ? `Active event: ${activeEvent.event_name}` : 'No active event'}
        </span>

        <span className="crm-count-note">{filtered.length} of {leads.length}</span>
      </div>

      {loading && <div className="crm-loading"><Loader2 size={16} className="crm-spin" /> Loading leads…</div>}
      {error && <div className="crm-error">Couldn't load leads: {error}</div>}

      {!loading && !error && (
        <div className="crm-table-wrap">
          <table className="crm-table">
            <thead>
             <tr>
                {['Person', 'Purpose', 'Status', 'Nurture', 'Notes', 'Owner', 'Cold calling', 'Email', 'Social', ''].map(h => (
                  <th key={h}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {paginate(filtered, leadsPage).map(l => {
                const personName = `${l.people?.first_name || ''} ${l.people?.last_name || ''}`.trim() || '—'
                const isConverting = convertingLeadId === l.lead_id
                return (
                  <tr key={l.lead_id} className="clickable" onClick={() => onOpenLead(l.lead_id)}>
                  <td style={{ fontWeight: 500, color: 'var(--ink-950)' }}>{personName}</td>
                    <td>{l.lead_purpose || '—'}</td>
                    <td><Badge value={l.lead_status} /></td>
                    <td><Badge value={l.nurture_stage} /></td>
                    <td className="crm-notes-cell" title={l.notes || ''}>{l.notes || '—'}</td>
                    <td>{l.people?.owner_email || '—'}</td>
                    <td>
                      {l.cold_calling ? (
                        <Badge value={l.cold_calling_stage || 'Not Pitched'} />
                      ) : (
                        <span style={{ color: 'var(--ink-400)' }}>Off</span>
                      )}
                    </td>
                    <td>
                      {l.email_campaign ? (
                        <Badge value={emailStageLabel(l.email_campaign_stage) || 'Queued'} />
                      ) : (
                        <span style={{ color: 'var(--ink-400)' }}>Off</span>
                      )}
                    </td>
                    <td>
                      {l.social_media ? (
                        <Badge value={l.social_media_stage || 'Queued'} />
                      ) : (
                        <span style={{ color: 'var(--ink-400)' }}>Off</span>
                      )}
                    </td>
                    <td>
                      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                        <button
                          className="crm-icon-action"
                          onClick={e => { e.stopPropagation(); onOpenLead(l.lead_id) }}
                          aria-label="View details"
                          title="View lead details"
                        >
                          <Eye size={14} />
                        </button>
                        <button
                          className="crm-icon-action"
                          onClick={e => { e.stopPropagation(); convertLeadToAttendee(l) }}
                          disabled={isConverting || activeEventLoading || !activeEvent}
                          aria-label="Convert to attendee"
                          title={activeEvent ? `Add to ${activeEvent.event_name}` : 'No active event'}
                        >
                          {isConverting ? <Loader2 size={14} className="crm-spin" /> : <UserPlus size={14} />}
                        </button>
                      </div>
                    </td>
                  </tr>
                )
              })}
              {filtered.length === 0 && (
                <tr className="crm-empty-row"><td colSpan={9}>No leads match these filters.</td></tr>
              )}
            </tbody>
          </table>
          <Pagination page={leadsPage} setPage={setLeadsPage} total={filtered.length} />
        </div>
      )}
    </div>
  )
}
// ============================================================================
// PERSON DETAIL — full page. Shows and edits every field for one person,
// lists any leads already created from them, and offers a one-click
// "Convert to lead" action that opens a fully-editable confirm modal.
// ============================================================================
function PersonDetailPage({
  personId,
  navKey,
  onNavigatePerson,
  showToast,
  onOpenLead,
  onLeadCreated,
  onLeadRemoved
}) {
const [neighbors, setNeighbors] = useState({ previousId: null, nextId: null })
  useEffect(() => {
    let cancelled = false
    const result = getPersonNavNeighbors(navKey, personId)
    if (result.previousId || result.nextId) {
      setNeighbors(result)
      return
    }
    // No navKey, or this person isn't in that saved list (e.g. opened from
    // outside the People page) — rebuild an unfiltered list from Supabase
    // as a fallback so Prev/Next still work, just without any filters.
    ;(async () => {
      const ids = await buildPersonNavListFromDB()
      if (cancelled) return
      const idx = ids.findIndex(id => String(id) === String(personId))
      if (idx === -1) { setNeighbors({ previousId: null, nextId: null }); return }
      setNeighbors({
        previousId: idx > 0 ? ids[idx - 1] : null,
        nextId: idx < ids.length - 1 ? ids[idx + 1] : null,
      })
    })()
    return () => { cancelled = true }
  }, [personId, navKey])

  const [person, setPerson] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [form, setForm] = useState(null)
  const [company, setCompany] = useState(null)
  const [saving, setSaving] = useState(false)

  const [leads, setLeads] = useState([])
  const [leadsLoading, setLeadsLoading] = useState(true)

  const [events, setEvents] = useState([])
  const [eventsLoading, setEventsLoading] = useState(true)
  const [showEvents, setShowEvents] = useState(false)

  const [showConvert, setShowConvert] = useState(false)
  const [creatingLead, setCreatingLead] = useState(false)

  const [purposeOptions, setPurposeOptions] = useState(LEAD_PURPOSE_CHOICES)
  const [statusOptions, setStatusOptions] = useState([])
  useEffect(() => {
    (async () => {
      const { data, error } = await supabase.from('people').select('status')
      if (error || !data) return
      setStatusOptions(Array.from(new Set(data.map(r => r.status).filter(Boolean))).sort())
      // Fixed approved choices only — never reintroduce historical database values.
      setPurposeOptions(LEAD_PURPOSE_CHOICES)
    })()
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    const { data, error } = await supabase
      .from('people')
      .select('*, companies(company_id, company_name, country)')
      .eq('person_id', personId)
      .single()
    if (error) setError(error.message)
    else {
      setPerson(data)
   setForm({
        first_name: data.first_name || '', last_name: data.last_name || '', email: data.email || '', email1: data.email1 || '',
        job_title: data.job_title || '', country: data.country || '', phone: data.phone || '',
        mobile: data.mobile || '', linkedin_url: data.linkedin_url || '', status: data.status || '',
        industry: data.industry || '', lead_purpose: data.lead_purpose || '', owner_email: data.owner_email || '',
        abm_order: data.abm_order ?? '',
        bio: data.bio || '',
        image: data.image || '',
        notes: data.notes || '',
      })
      setCompany(data.companies ? { company_id: data.companies.company_id, company_name: data.companies.company_name, country: data.companies.country || '' } : null)
    }
    setLoading(false)
  }, [personId])

  const loadLeads = useCallback(async () => {
    setLeadsLoading(true)
    const { data, error } = await supabase
      .from('leads')
      .select('lead_id, created_at')
      .eq('person_id', personId)
      .order('created_at', { ascending: false })
    if (!error) setLeads(data || [])
    setLeadsLoading(false)
  }, [personId])

  const loadEvents = useCallback(async () => {
    setEventsLoading(true)
    const { data, error } = await supabase
      .from('event_participants')
      .select('participant_id, role, status, events(event_id, event_name, start_date)')
      .eq('person_id', personId)
      .order('created_at', { ascending: false })
    if (!error) setEvents(data || [])
    setEventsLoading(false)
  }, [personId])

  useEffect(() => { load(); loadLeads(); loadEvents() }, [load, loadLeads, loadEvents])

  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value })
  const copyFullName = async () => {
  const fullName = `${form.first_name || ''} ${form.last_name || ''}`.trim()

  if (!fullName) return

  try {
    await navigator.clipboard.writeText(fullName)
    showToast('Full name copied')
  } catch {
    showToast("Couldn't copy name", true)
  }
}
const save = async () => {
  setSaving(true)

  const { companyId, error: companyError } = await resolveCompanyId(company)
  if (companyError) {
    setSaving(false)
    showToast(`Couldn't save company: ${companyError.message}`, true)
    return
  }

  const { error } = await supabase
    .from('people')
    .update({
      ...form,
      abm_order: form.abm_order === '' ? null : Number(form.abm_order),
      email: form.email?.trim() || null,
      email1: form.email1?.trim() || null,
      company_id: companyId,
      updated_at: new Date().toISOString(),
    })
    .eq('person_id', personId)
  setSaving(false)
  if (error) { showToast(`Couldn't save: ${error.message}`, true); return }
  showToast('Person updated')
  load()
}

  const createLead = async (convertForm) => {
    setCreatingLead(true)
    const { data, error } = await supabase
      .from('leads')
      .insert({ person_id: personId, company_id: company?.company_id || null, event_id: null, ...convertForm })
      .select()
      .single()
    setCreatingLead(false)
    if (error) { showToast(`Couldn't create lead: ${error.message}`, true); return }

    // Keep the People page's hidden-leads map in sync with this flow too.
    onLeadCreated && onLeadCreated(personId, null)

    showToast(
      'Lead created',
      false,
      async () => {
        const { error: undoError } = await supabase.from('leads').delete().eq('lead_id', data.lead_id)
        if (undoError) { showToast(`Couldn't undo: ${undoError.message}`, true); return }
        onLeadRemoved && onLeadRemoved(personId, null)
        showToast('Undone — lead removed')
        loadLeads()
      }
    )
    setShowConvert(false)
    loadLeads()
    if (data && onOpenLead) onOpenLead(data.lead_id)
  }

  if (loading) return <div className="crm-loading"><Loader2 size={16} className="crm-spin" /> Loading person…</div>
  if (error) return <div className="crm-error">Couldn't load person: {error}</div>
  if (!person || !form) return null

  const av = avatarStyle(form.first_name + form.last_name)

  return (
    <div className="crm-detail-wrap">
     <div className="crm-detail-top">
  <div className="crm-name-cell" style={{ fontSize: 15 }}>
    <div
      className="crm-avatar"
      style={{
        background: av.bg,
        color: av.fg,
        width: 40,
        height: 40,
        fontSize: 13
      }}
    >
      {initials(form.first_name, form.last_name)}
    </div>

    <div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 7,
          fontWeight: 600,
          color: 'var(--ink-950)',
          fontSize: 16
        }}
      >
        <span>
          {form.first_name} {form.last_name}
        </span>

        <button
          type="button"
          className="crm-icon-action"
          onClick={copyFullName}
          title="Copy full name"
          aria-label="Copy full name"
        >
          <Copy size={14} />
        </button>
      </div>

      <div style={{ fontSize: 12.5, color: 'var(--ink-400)' }}>
        {form.email}
      </div>
    </div>
  </div>

  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
   <button
      type="button"
      className="crm-icon-action"
      onClick={() => onNavigatePerson(neighbors.previousId)}
      disabled={!neighbors.previousId}
      title="Previous person"
      aria-label="Previous person"
      style={{
        opacity: neighbors.previousId ? 1 : 0.35,
        cursor: neighbors.previousId ? 'pointer' : 'not-allowed'
      }}
    >
      <ArrowLeft size={16} />
    </button>

    <button
      type="button"
      className="crm-icon-action"
      onClick={() => onNavigatePerson(neighbors.nextId)}
      disabled={!neighbors.nextId}
      title="Next person"
      aria-label="Next person"
      style={{
        opacity: neighbors.nextId ? 1 : 0.35,
        cursor: neighbors.nextId ? 'pointer' : 'not-allowed'
      }}
    >
      <ArrowRight size={16} />
    </button>
    <button
      className="crm-submit-btn"
      style={{ width: 'auto', padding: '10px 18px' }}
      onClick={() => setShowConvert(true)}
    >
      <UserPlus size={15} /> Convert to lead
    </button>
  </div>
</div>

      <div className="crm-form" style={{ marginTop: 18 }}>
        <div className="crm-form-row">
          <div><FieldLabel>First name</FieldLabel><input className="crm-input" value={form.first_name} onChange={set('first_name')} /></div>
          <div><FieldLabel>Last name</FieldLabel><input className="crm-input" value={form.last_name} onChange={set('last_name')} /></div>
        </div>
        <div><FieldLabel>Email</FieldLabel><input className="crm-input" value={form.email} onChange={set('email')} /></div>
        <div><FieldLabel>Email 1</FieldLabel><input className="crm-input" value={form.email1} onChange={set('email1')} /></div>
        <div className="crm-form-row">
          <div><FieldLabel>Job title</FieldLabel><input className="crm-input" value={form.job_title} onChange={set('job_title')} /></div>
          <div>
            <FieldLabel>Industry</FieldLabel>
            <select className="crm-select" value={form.industry} onChange={set('industry')}>
              <option value="">—</option>
              {INDUSTRY_OPTIONS.map(i => <option key={i} value={i}>{i}</option>)}
            </select>
          </div>
        </div>
        <div className="crm-form-row">
          <div><FieldLabel>Country</FieldLabel><input className="crm-input" value={form.country} onChange={set('country')} /></div>
          <div><FieldLabel>Company</FieldLabel><CompanyPicker value={company} onChange={setCompany} showToast={showToast} /></div>
        </div>
        <div className="crm-form-row">
          <div><FieldLabel>Phone</FieldLabel><input className="crm-input" value={form.phone} onChange={set('phone')} /></div>
          <div><FieldLabel>Mobile</FieldLabel><input className="crm-input" value={form.mobile} onChange={set('mobile')} /></div>
        </div>
           <div className="crm-form-row">
          <div>
            <FieldLabel>Lead purpose</FieldLabel>
            <select className="crm-select" value={form.lead_purpose} onChange={set('lead_purpose')}>
              <option value="">—</option>
              {purposeOptions.map(p => <option key={p} value={p}>{p}</option>)}
            </select>
          </div>
          <div>
            <FieldLabel>Owner email</FieldLabel>
            <select className="crm-select" value={form.owner_email} onChange={set('owner_email')}>
              <option value="">— Unassigned —</option>
              {OWNER_EMAIL_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
            </select>
          </div>
        </div>
       <div className="crm-form-row">
          <div><FieldLabel>LinkedIn URL</FieldLabel><input className="crm-input" value={form.linkedin_url} onChange={set('linkedin_url')} /></div>
          <div>
            <FieldLabel>Status</FieldLabel>
            <select className="crm-select" value={form.status} onChange={set('status')}>
              <option value="">—</option>
              {form.status && !statusOptions.includes(form.status) && (
                <option value={form.status}>{form.status}</option>
              )}
              {statusOptions.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
        </div>

        <div className="crm-form-row">
          <div>
            <FieldLabel>ABM Order</FieldLabel>
            <input
              type="number"
              className="crm-input"
              value={form.abm_order}
              onChange={set('abm_order')}
            />
          </div>
          <div>
            <FieldLabel>Image</FieldLabel>
            <input
              className="crm-input"
              value={form.image}
              onChange={set('image')}
              placeholder="Image URL"
            />
          </div>
        </div>

        <div>
          <FieldLabel>Bio</FieldLabel>
          <textarea
            className="crm-textarea"
            value={form.bio}
            onChange={set('bio')}
            rows={5}
          />
        </div>

        <div><FieldLabel>Notes</FieldLabel><textarea className="crm-textarea" value={form.notes} onChange={set('notes')} /></div>
        <button className="crm-submit-btn" onClick={save} disabled={saving}>
          {saving ? <Loader2 size={15} className="crm-spin" /> : <Save size={15} />} Save changes
        </button>
      </div>
      <div style={{ marginTop: 28 }}>
        <h3 className="crm-display" style={{ fontSize: 17, margin: '0 0 12px' }}>Leads from this person</h3>
        {leadsLoading && <div className="crm-loading"><Loader2 size={16} className="crm-spin" /> Loading leads…</div>}
        {!leadsLoading && leads.length === 0 && (
          <div className="crm-confirm-empty" style={{ border: '1px solid var(--line)', borderRadius: 12 }}>No leads yet — convert this person above.</div>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {!leadsLoading && leads.map(l => (
            <LeadDetailCard key={l.lead_id} leadId={l.lead_id} showToast={showToast} hidePersonChip />
          ))}
        </div>
      </div>

      <div style={{ marginTop: 20 }}>
        <button
          onClick={() => setShowEvents(v => !v)}
          style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
        >
          <h3 className="crm-display" style={{ fontSize: 17, margin: 0 }}>
            Events attending{!eventsLoading && ` (${events.length})`}
          </h3>
          {showEvents ? <ChevronUp size={16} color="var(--ink-400)" /> : <ChevronDown size={16} color="var(--ink-400)" />}
        </button>
        {showEvents && (
          <div style={{ marginTop: 12 }}>
            {eventsLoading && <div className="crm-loading"><Loader2 size={16} className="crm-spin" /> Loading events…</div>}
            {!eventsLoading && events.length === 0 && (
              <div className="crm-confirm-empty" style={{ border: '1px solid var(--line)', borderRadius: 12 }}>Not attached to any events yet.</div>
            )}
            {!eventsLoading && events.map(ev => (
              <div key={ev.participant_id} className="crm-confirm-row" style={{ border: '1px solid var(--line)', borderRadius: 10, marginBottom: 8 }}>
                <div>
                  <div className="crm-confirm-row-name">{ev.events?.event_name || 'Untitled event'}</div>
                  <div className="crm-confirm-row-sub">{formatDate(ev.events?.start_date)}</div>
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <Badge value={ev.role} />
                  <Badge value={ev.status} />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {showConvert && (
        <QuickConvertModal
          person={{ first_name: form.first_name, last_name: form.last_name, mobile: form.mobile, phone: form.phone, company_id: company?.company_id || null }}
          onClose={() => setShowConvert(false)}
          onConfirm={createLead}
          creating={creatingLead}
        />
      )}
    </div>
  )
}
// ============================================================================
// LEAD DETAIL CARD — the actual editable lead content, shared by the full
// Lead detail page and by the Person detail page (which embeds one of these
// per lead so you get a full overview without navigating away).
//
// IMPORTANT: the three channel *_stage columns (cold_calling_stage,
// email_campaign_stage, social_media_stage) are shown READ-ONLY here. They
// are owned by live automations — an AI cold-calling agent writes branching
// outcomes into cold_calling_stage, and the Make.com email scenario writes
// its own progress values into email_campaign_stage. A generic "save your
// edits" form that includes these as free-editable dropdowns can silently
// clobber automation state (e.g. reset a lead that's mid-flow back to
// "Not started", making it look eligible for re-contact, or erasing an
// outcome another automated step already branched on).
//
// What IS safely human-editable per channel is just the on/off boolean
// (whether this channel should be pursued for the lead at all) — turning a
// channel off is a legitimate "stop trying this on them" action and doesn't
// require knowing the automation's internal state vocabulary.
//
// ACTIVITY TIMELINE: pulled from public.activities, filtered to this lead_id.
// This is the audit trail the Make.com scenarios write to on every email
// sent, reply logged, unsubscribe, and bounce — surfacing it here is the
// only way to see, from inside the CRM, whether the automation is actually
// working for a given lead without querying Supabase directly.
// ============================================================================
function LeadDetailCard({ leadId, showToast, onOpenPerson, hidePersonChip }) {
  const [lead, setLead] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [form, setForm] = useState(null)
  const [saving, setSaving] = useState(false)

  const [activities, setActivities] = useState([])
  const [activitiesLoading, setActivitiesLoading] = useState(true)

  const [stageLabels, setStageLabels] = useState({})
  useEffect(() => {
    (async () => {
      const { data, error } = await supabase
        .from('systems_tables')
        .select('config2, description')
        .eq('system_name', 'Email Outreach')
      if (!error && data) {
        const map = {}
        data.forEach(r => { map[(r.config2 || '').toString().trim()] = r.description })
        setStageLabels(map)
      }
    })()
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    const { data, error } = await supabase
      .from('leads')
      .select('*, people(person_id, first_name, last_name, email, mobile, phone, owner_email), companies(company_name), events(event_name)')
      .eq('lead_id', leadId)
      .single()
    if (error) setError(error.message)
    else {
      setLead(data)
      setForm({
        lead_status: data.lead_status || '', lead_purpose: data.lead_purpose || '',
        nurture_stage: data.nurture_stage || '', owner: data.owner || '', notes: data.notes || '',
        cold_calling: !!data.cold_calling,
        email_campaign: !!data.email_campaign,
        social_media: !!data.social_media,
      })
    }
    setLoading(false)
  }, [leadId])

  const loadActivities = useCallback(async () => {
    setActivitiesLoading(true)
    const { data, error } = await supabase
      .from('activities')
      .select('*')
      .eq('lead_id', leadId)
      .order('activity_date', { ascending: false })
    if (!error) setActivities(data || [])
    setActivitiesLoading(false)
  }, [leadId])

  useEffect(() => { load(); loadActivities() }, [load, loadActivities])

  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value })
  const toggleChannel = (boolKey) => setForm(prev => ({ ...prev, [boolKey]: !prev[boolKey] }))

  const save = async () => {
    setSaving(true)
    const { error } = await supabase.from('leads').update({ ...form, updated_at: new Date().toISOString() }).eq('lead_id', leadId)
    setSaving(false)
    if (error) { showToast(`Couldn't save: ${error.message}`, true); return }
    showToast('Lead updated')
    load()
  }

  if (loading) return <div className="crm-loading"><Loader2 size={16} className="crm-spin" /> Loading lead…</div>
  if (error) return <div className="crm-error">Couldn't load lead: {error}</div>
  if (!lead || !form) return null

  const personName = `${lead.people?.first_name || ''} ${lead.people?.last_name || ''}`.trim() || '—'
  const coldCallingWarning = form.cold_calling ? channelReadinessWarning(
    { mobile: lead.people?.mobile, phone: lead.people?.phone, company_id: lead.company_id },
    'cold_calling_stage'
  ) : null

  return (
    <div style={{ border: '1px solid var(--line)', borderRadius: 16, padding: 20, background: 'var(--surface)' }}>
      <div className="crm-confirm-summary">
        {!hidePersonChip && (
          <span
            className="crm-confirm-summary-item"
            style={{ cursor: lead.people ? 'pointer' : 'default' }}
            onClick={() => lead.people && onOpenPerson && onOpenPerson(lead.people.person_id)}
          >
            Person: <b>{personName}</b>
          </span>
        )}
        <span className="crm-confirm-summary-item">Event: <b>{lead.events?.event_name || 'General lead'}</b></span>
        <span className="crm-confirm-summary-item">Company: <b>{lead.companies?.company_name || '—'}</b></span>
        <span className="crm-confirm-summary-item">Created: <b>{formatDate(lead.created_at)}</b></span>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div className="crm-form-row">
          <div>
            <FieldLabel>Status</FieldLabel>
            <select className="crm-select" value={form.lead_status} onChange={set('lead_status')}>
              <option value="">—</option>
              {LEAD_STATUS_OPTIONS.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div>
            <FieldLabel>Nurture stage</FieldLabel>
            <select className="crm-select" value={form.nurture_stage} onChange={set('nurture_stage')}>
              <option value="">—</option>
              {NURTURE_STAGE_OPTIONS.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
        </div>
        <div className="crm-form-row">
          <div>
            <FieldLabel>Purpose</FieldLabel>
            <select className="crm-select" value={form.lead_purpose} onChange={set('lead_purpose')}>
              <option value="">—</option>
              {LEAD_PURPOSE_CHOICES.map(p => <option key={p} value={p}>{p}</option>)}
            </select>
          </div>
         <div>
  <FieldLabel>Owner</FieldLabel>
  <div className="crm-input" style={{ background: 'var(--paper)', color: 'var(--ink-700)' }}>
    {lead.people?.owner_email || '—'}
  </div>
</div>
        </div>

        <div>
          <FieldLabel>Outreach channels</FieldLabel>
          <p className="crm-channel-note" style={{ marginTop: -4, marginBottom: 10 }}>
            Progress within each channel is driven by automation and shown read-only. Toggle a channel off to stop pursuing it for this lead.
          </p>
          <div className="crm-channel-grid">
            {CHANNEL_FIELDS.map(cf => {
              const boolValue = form[cf.boolKey]
              const rawStageValue = lead[cf.key]
              const stageValue = cf.key === 'email_campaign_stage'
                ? (stageLabels[(rawStageValue || '').toString().trim()] || rawStageValue)
                : rawStageValue
              return (
                <div key={cf.key} className="crm-channel-readonly">
                  <div className="crm-channel-readonly-head">
                    <span style={{ fontSize: 12.5, fontWeight: 500, color: 'var(--ink-700)' }}>{cf.label}</span>
                    <button
                      type="button"
                      disabled={!cf.live}
                      className={`crm-channel-toggle${boolValue ? '' : ' off'}${!cf.live ? ' disabled-live' : ''}`}
                      onClick={() => cf.live && toggleChannel(cf.boolKey)}
                      title={!cf.live ? 'Not wired to an active automation yet' : (boolValue ? 'Turn this channel off' : 'Turn this channel on')}
                    >
                      {boolValue ? <Check size={10} /> : <X size={10} />} {boolValue ? 'On' : 'Off'}
                    </button>
                  </div>
                  {boolValue ? <Badge value={stageValue} /> : <span style={{ color: 'var(--ink-400)', fontSize: 12.5 }}>Not being pursued</span>}
                </div>
              )
            })}
          </div>
          {coldCallingWarning && (
            <div className="crm-warn-note" style={{ marginTop: 10 }}>
              <AlertTriangle size={12} style={{ flexShrink: 0, marginTop: 1 }} />{coldCallingWarning}
            </div>
          )}
        </div>

        <div><FieldLabel>Notes</FieldLabel><textarea className="crm-textarea" value={form.notes} onChange={set('notes')} /></div>

        <button className="crm-submit-btn" onClick={save} disabled={saving}>
          {saving ? <Loader2 size={15} className="crm-spin" /> : <Save size={15} />} Save changes
        </button>
      </div>

      <div style={{ marginTop: 22, paddingTop: 18, borderTop: '1px solid var(--line)' }}>
        <h4 style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--ink-950)', margin: '0 0 12px', display: 'flex', alignItems: 'center', gap: 6 }}>
          <History size={14} /> Activity
        </h4>
        {activitiesLoading && (
          <div className="crm-loading" style={{ padding: '16px 0' }}><Loader2 size={14} className="crm-spin" /> Loading activity…</div>
        )}
        {!activitiesLoading && activities.length === 0 && (
          <div className="crm-confirm-empty" style={{ border: '1px solid var(--line)', borderRadius: 12, padding: 24 }}>
            Nothing logged yet — activity appears here once outreach starts.
          </div>
        )}
        {!activitiesLoading && activities.length > 0 && (
          <div className="crm-activity-list">
            {activities.map(a => {
              const Icon = activityIcon(a.activity_type)
              const tone = activityTone(a.activity_type)
              return (
                <div key={a.activity_id} className="crm-activity-item">
                  <div className="crm-activity-icon" style={{ background: tone.bg, color: tone.fg }}>
                    <Icon size={14} />
                  </div>
                  <div className="crm-activity-body">
                    <div className="crm-activity-top">
                      <span className="crm-activity-type">{a.activity_type || 'Activity'}</span>
                      <span className="crm-activity-date">{formatDateTime(a.activity_date)}</span>
                    </div>
                    {a.summary && <div className="crm-activity-summary">{a.summary}</div>}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
// ============================================================================
// LEAD DETAIL — full page wrapper around LeadDetailCard.
// ============================================================================
function LeadDetailPage({ leadId, showToast, onOpenPerson }) {
  return (
    <div className="crm-detail-wrap">
      <LeadDetailCard leadId={leadId} showToast={showToast} onOpenPerson={onOpenPerson} />
    </div>
  )
}

// ============================================================================
// EVENTS — live data, search + status filter, single-row edit-lock (unchanged)
// ============================================================================
function EventsPage({ showToast }) {
  const [events, setEvents] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [eventsPage, setEventsPage] = useState(1)

  const [editingId, setEditingId] = useState(null)
  const [editForm, setEditForm] = useState(null)
  const [saving, setSaving] = useState(false)

  const fetchEvents = useCallback(async () => {
    setLoading(true)
    setError(null)
    const { data, error } = await supabase.from('events').select('*').order('start_date', { ascending: true })
    if (error) setError(error.message)
    else setEvents(data || [])
    setLoading(false)
  }, [])

  useEffect(() => { fetchEvents() }, [fetchEvents])

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim()
    return events.filter(e => {
      if (statusFilter && e.status !== statusFilter) return false
      if (!q) return true
      // event_id included in search since it's the meaningful lookup key
      // used everywhere else (leads.event_id, event_participants.event_id).
      return `${e.event_id} ${e.event_name} ${e.event_type || ''} ${e.location || ''} ${e.country || ''}`.toLowerCase().includes(q)
    })
  }, [events, search, statusFilter])

  useEffect(() => { setEventsPage(1) }, [search, statusFilter])

const startEdit = (p) => {
    setEditingId(p.person_id)

    setEditForm({
      first_name: p.first_name || '',
      last_name: p.last_name || '',
      email: p.email || '',
      email1: p.email1 || '',
      job_title: p.job_title || '',
      phone: p.phone || '',
      mobile: p.mobile || '',
      notes: p.notes || '',
      country: p.country || '',
      status: p.status || '',
      industry: p.industry || '',
      linkedin_url: p.linkedin_url || '',
    })
  }
  const cancelEdit = () => { setEditingId(null); setEditForm(null) }

  const saveEdit = async (eventId) => {
    setSaving(true)
    const { error } = await supabase.from('events').update({ ...editForm, updated_at: new Date().toISOString() }).eq('event_id', eventId)
    setSaving(false)
    if (error) { showToast(`Couldn't save: ${error.message}`, true); return }
    setEvents(prev => prev.map(e => (e.event_id === eventId ? { ...e, ...editForm } : e)))
    setEditingId(null)
    setEditForm(null)
    showToast('Event updated')
  }

  return (
    <div>
      <div className="crm-toolbar">
        <div className="crm-search-box">
          <Search size={15} style={{ color: 'var(--ink-400)' }} />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search event ID, name, type, location, country…" />
        </div>
        <select className="crm-filter-select" value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
          <option value="">All statuses</option>
          {EVENT_STATUS_OPTIONS.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <span className="crm-count-note">{filtered.length} of {events.length}</span>
      </div>

      {loading && <div className="crm-loading"><Loader2 size={16} className="crm-spin" /> Loading events…</div>}
      {error && <div className="crm-error">Couldn't load events: {error}</div>}

      {!loading && !error && (
        <div className="crm-table-wrap">
          <table className="crm-table">
            <thead>
              <tr>{['Event ID', 'Event', 'Type', 'Dates', 'Location', 'Country', 'Status', ''].map(h => <th key={h}>{h}</th>)}</tr>
            </thead>
            <tbody>
              {paginate(filtered, eventsPage).map(e => {
                const isEditing = editingId === e.event_id
                return (
                  <tr key={e.event_id} className={isEditing ? 'editing' : ''}>
                    {/* event_id is always read-only, even while editing — it's
                        the FK every lead and event_participants row keys off,
                        so changing it here would silently orphan those rows. */}
                    <td style={{ fontFamily: 'monospace', fontSize: 12.5, color: 'var(--ink-700)' }}>{e.event_id}</td>
                    {isEditing ? (
                      <>
                        <td><input className="crm-cell-input" value={editForm.event_name} onChange={ev => setEditForm({ ...editForm, event_name: ev.target.value })} /></td>
                        <td><input className="crm-cell-input" value={editForm.event_type} onChange={ev => setEditForm({ ...editForm, event_type: ev.target.value })} /></td>
                        <td>
                          <div style={{ display: 'flex', gap: 6 }}>
                            <input type="date" className="crm-cell-input" value={editForm.start_date} onChange={ev => setEditForm({ ...editForm, start_date: ev.target.value })} />
                            <input type="date" className="crm-cell-input" value={editForm.end_date} onChange={ev => setEditForm({ ...editForm, end_date: ev.target.value })} />
                          </div>
                        </td>
                        <td><input className="crm-cell-input" value={editForm.location} onChange={ev => setEditForm({ ...editForm, location: ev.target.value })} /></td>
                        <td><input className="crm-cell-input" value={editForm.country} onChange={ev => setEditForm({ ...editForm, country: ev.target.value })} /></td>
                        <td>
                          <select className="crm-cell-select" value={editForm.status} onChange={ev => setEditForm({ ...editForm, status: ev.target.value })}>
                            <option value="">—</option>
                            {EVENT_STATUS_OPTIONS.map(s => <option key={s} value={s}>{s}</option>)}
                          </select>
                        </td>
                        <td>
                          <div className="crm-row-actions">
                            <button className="crm-icon-action save" onClick={() => saveEdit(e.event_id)} disabled={saving} aria-label="Save">
                              {saving ? <Loader2 size={14} className="crm-spin" /> : <Save size={14} />}
                            </button>
                            <button className="crm-icon-action cancel" onClick={cancelEdit} aria-label="Cancel"><XCircle size={14} /></button>
                          </div>
                        </td>
                      </>
                    ) : (
                      <>
                        <td style={{ fontWeight: 500, color: 'var(--ink-950)' }}>{e.event_name}</td>
                        <td>{e.event_type || '—'}</td>
                        <td style={{ fontSize: 12.5 }}><Clock size={12} style={{ marginRight: 4, verticalAlign: -2 }} />{formatDate(e.start_date)} – {formatDate(e.end_date)}</td>
                        <td>{e.location || '—'}</td>
                        <td>{e.country || '—'}</td>
                        <td><Badge value={e.status} /></td>
                        <td><button className="crm-icon-action" onClick={() => startEdit(e)} aria-label="Edit row"><Pencil size={14} /></button></td>
                      </>
                    )}
                  </tr>
                )
              })}
              {filtered.length === 0 && <tr className="crm-empty-row"><td colSpan={8}>No events match these filters.</td></tr>}
            </tbody>
          </table>
          <Pagination page={eventsPage} setPage={setEventsPage} total={filtered.length} />
        </div>
      )}
    </div>
  )
}
// ============================================================================
// ATTENDEES — pick an event, manage who's already attached to it (edit-lock,
// removable, paginated), and add more people via search/industry filter with
// multi-select.
//
// Two additions here:
//  - Candidate table shows Industry instead of Company, with a matching
//    filter, mirroring the People page.
//  - Anyone already attached to this event who ALSO has a lead tied to this
//    exact event_id gets a "Lead" tag next to their name — this is a
//    cross-reference against public.leads (event_id), not a guess, and
//    re-fetches every time the selected event changes.
// ============================================================================
function AttendeesPage({ showToast }) {
  const ATTENDEES_PER_PAGE = 150
  const PEOPLE_PER_PAGE = 50

  // ============================================================
  // EVENTS
  // ============================================================
  const [events, setEvents] = useState([])
  const [eventsLoading, setEventsLoading] = useState(true)
  const [selectedEventId, setSelectedEventId] = useState('')

  // ============================================================
  // ATTENDEES
  // ============================================================
  const [participants, setParticipants] = useState([])
  const [participantsLoading, setParticipantsLoading] = useState(false)
  const [participantsPage, setParticipantsPage] = useState(1)
  const [participantSearch, setParticipantSearch] = useState('')

  // Lead badge
  const [leadPersonIdsForEvent, setLeadPersonIdsForEvent] = useState(
    new Set()
  )

  // Previous attendance history
  const [pastEventsByPerson, setPastEventsByPerson] = useState({})
  const [pastEventsLoading, setPastEventsLoading] = useState(false)

  // ============================================================
  // EDIT / DELETE
  // ============================================================
  const [editingId, setEditingId] = useState(null)
  const [editForm, setEditForm] = useState(null)
  const [saving, setSaving] = useState(false)
  const [removingId, setRemovingId] = useState(null)

  // ============================================================
  // ADD PEOPLE MODAL
  // ============================================================
  const [showAddPeopleModal, setShowAddPeopleModal] = useState(false)

  const [candidates, setCandidates] = useState([])
  const [candidatesLoading, setCandidatesLoading] = useState(false)

  const [candidateSearch, setCandidateSearch] = useState('')
  const [candidateIndustryFilter, setCandidateIndustryFilter] = useState('')
  const [candidatePage, setCandidatePage] = useState(1)

  const [selectedPersonIds, setSelectedPersonIds] = useState(new Set())

  const [bulkRole, setBulkRole] = useState('Delegate')
  const [bulkStatus, setBulkStatus] = useState('Invited')

  const [submittingAdd, setSubmittingAdd] = useState(false)

  // ============================================================
  // LOAD EVENTS
  // ============================================================
  useEffect(() => {
    ;(async () => {
      setEventsLoading(true)

      const { data, error } = await supabase
        .from('events')
        .select('event_id, event_name, start_date')
        .order('start_date', { ascending: false })

      if (error) {
        showToast(`Couldn't load events: ${error.message}`, true)
      } else {
        setEvents(data || [])

        if (data && data.length > 0 && !selectedEventId) {
          setSelectedEventId(data[0].event_id)
        }
      }

      setEventsLoading(false)
    })()

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ============================================================
  // FETCH ATTENDEES
  // ============================================================
  const fetchParticipants = useCallback(
    async eventId => {
      if (!eventId) {
        setParticipants([])
        return []
      }

      setParticipantsLoading(true)

      const PAGE = 1000
      let allRows = []
      let from = 0

      while (true) {
        const { data, error } = await supabase
          .from('event_participants')
          .select(`
            *,
            people(
              first_name,
              last_name,
              email,
              job_title,
              country,
              phone
            ),
            companies(
              company_name
            )
          `)
          .eq('event_id', eventId)
          .order('created_at', { ascending: false })
          .order('participant_id', { ascending: true })
          .range(from, from + PAGE - 1)

        if (error) {
          showToast(
            `Couldn't load attendees: ${error.message}`,
            true
          )

          setParticipantsLoading(false)
          return []
        }

        allRows = allRows.concat(data || [])

        if (!data || data.length < PAGE) break

        from += PAGE
      }

      setParticipants(allRows)
      setParticipantsLoading(false)

      return allRows
    },
    [showToast]
  )

  // ============================================================
  // FETCH LEAD STATUS FOR CURRENT EVENT
  // ============================================================
  const fetchLeadsForEvent = useCallback(async eventId => {
    if (!eventId) {
      setLeadPersonIdsForEvent(new Set())
      return
    }

    const PAGE = 1000
    let allRows = []
    let from = 0

    while (true) {
      const { data, error } = await supabase
        .from('leads')
        .select('person_id')
        .eq('event_id', eventId)
        .range(from, from + PAGE - 1)

      if (error) return

      allRows = allRows.concat(data || [])

      if (!data || data.length < PAGE) break

      from += PAGE
    }

    setLeadPersonIdsForEvent(
      new Set(allRows.map(row => row.person_id))
    )
  }, [])

  // ============================================================
  // FETCH PAST EVENTS
  // ============================================================
  const fetchPastEvents = useCallback(
    async (eventId, personIds) => {
      if (!eventId || !personIds || personIds.length === 0) {
        setPastEventsByPerson({})
        return
      }

      setPastEventsLoading(true)

      const { data, error } = await supabase
        .from('event_participants')
        .select(`
          person_id,
          status,
          events!inner(
            event_id,
            event_name,
            start_date
          )
        `)
        .in('person_id', personIds)
        .neq('event_id', eventId)
        .order('start_date', {
          ascending: false,
          foreignTable: 'events'
        })

      setPastEventsLoading(false)

      if (error) {
        showToast(
          `Couldn't load attendance history: ${error.message}`,
          true
        )
        return
      }

      const map = {}

      ;(data || []).forEach(row => {
        if (!row.events) return

        if (!map[row.person_id]) {
          map[row.person_id] = []
        }

        map[row.person_id].push({
          event_id: row.events.event_id,
          event_name: row.events.event_name,
          start_date: row.events.start_date,
          status: row.status
        })
      })

      setPastEventsByPerson(map)
    },
    [showToast]
  )

  // ============================================================
  // EVENT CHANGED
  // ============================================================
  useEffect(() => {
    setParticipantsPage(1)
    setParticipantSearch('')
    setSelectedPersonIds(new Set())
    setShowAddPeopleModal(false)

    if (!selectedEventId) {
      setParticipants([])
      setPastEventsByPerson({})
      return
    }

    ;(async () => {
      const rows = await fetchParticipants(selectedEventId)

      fetchLeadsForEvent(selectedEventId)

      fetchPastEvents(
        selectedEventId,
        rows.map(row => row.person_id)
      )
    })()
  }, [
    selectedEventId,
    fetchParticipants,
    fetchLeadsForEvent,
    fetchPastEvents
  ])

  // ============================================================
  // ATTENDEE SEARCH
  // ============================================================
  const filteredParticipants = participants.filter(p => {
    const q = participantSearch.trim().toLowerCase()

    if (!q) return true

    const firstName =
      p.people?.first_name?.toLowerCase() || ''

    const lastName =
      p.people?.last_name?.toLowerCase() || ''

    const fullName =
      `${firstName} ${lastName}`.trim()

    const email =
      p.people?.email?.toLowerCase() || ''

    const company =
      p.companies?.company_name?.toLowerCase() || ''

    const jobTitle =
      p.people?.job_title?.toLowerCase() || ''

    const country =
      p.people?.country?.toLowerCase() || ''

    const phone =
      p.people?.phone?.toLowerCase() || ''

    const notes =
      p.notes?.toLowerCase() || ''

    return (
      firstName.includes(q) ||
      lastName.includes(q) ||
      fullName.includes(q) ||
      email.includes(q) ||
      company.includes(q) ||
      jobTitle.includes(q) ||
      country.includes(q) ||
      phone.includes(q) ||
      notes.includes(q)
    )
  })

  useEffect(() => {
    setParticipantsPage(1)
  }, [participantSearch])

  // ============================================================
  // ATTENDEE PAGINATION - 150 AT A TIME
  // ============================================================
  const participantTotalPages = Math.max(
    1,
    Math.ceil(
      filteredParticipants.length / ATTENDEES_PER_PAGE
    )
  )

  const displayedParticipants =
    filteredParticipants.slice(
      (participantsPage - 1) * ATTENDEES_PER_PAGE,
      participantsPage * ATTENDEES_PER_PAGE
    )

  // ============================================================
  // LOAD PEOPLE WHEN MODAL OPENS
  // ============================================================
  const loadCandidates = useCallback(async () => {
    if (!selectedEventId) return

    setCandidatesLoading(true)

    const existingIds = new Set(
      participants.map(p => p.person_id)
    )

    const PAGE = 1000
    let allPeople = []
    let from = 0

    while (true) {
      const { data, error } = await supabase
        .from('people')
        .select(`
          person_id,
          first_name,
          last_name,
          email,
          job_title,
          country,
          company_id,
          industry,
          companies(
            company_name
          )
        `)
        .order('first_name', { ascending: true })
        .range(from, from + PAGE - 1)

      if (error) {
        showToast(
          `Couldn't load people: ${error.message}`,
          true
        )

        setCandidatesLoading(false)
        return
      }

      allPeople = allPeople.concat(data || [])

      if (!data || data.length < PAGE) break

      from += PAGE
    }

    const availablePeople = allPeople.filter(
      person => !existingIds.has(person.person_id)
    )

    setCandidates(availablePeople)
    setCandidatesLoading(false)
  }, [selectedEventId, participants, showToast])

  // ============================================================
  // OPEN ADD PEOPLE POPUP
  // ============================================================
  const openAddPeopleModal = async () => {
    if (!selectedEventId) return

    setCandidateSearch('')
    setCandidateIndustryFilter('')
    setCandidatePage(1)
    setSelectedPersonIds(new Set())
    setBulkRole('Delegate')
    setBulkStatus('Invited')

    setShowAddPeopleModal(true)

    await loadCandidates()
  }

  const closeAddPeopleModal = () => {
    if (submittingAdd) return

    setShowAddPeopleModal(false)
    setSelectedPersonIds(new Set())
    setCandidateSearch('')
    setCandidateIndustryFilter('')
    setCandidatePage(1)
  }

  // ============================================================
  // FILTER PEOPLE
  // ============================================================
  const filteredCandidates = candidates.filter(person => {
    const q = candidateSearch.trim().toLowerCase()

    const matchesSearch =
      !q ||
      (person.first_name || '')
        .toLowerCase()
        .includes(q) ||
      (person.last_name || '')
        .toLowerCase()
        .includes(q) ||
      `${person.first_name || ''} ${person.last_name || ''}`
        .toLowerCase()
        .includes(q) ||
      (person.email || '')
        .toLowerCase()
        .includes(q) ||
      (person.companies?.company_name || '')
        .toLowerCase()
        .includes(q)

    const matchesIndustry =
      !candidateIndustryFilter ||
      person.industry === candidateIndustryFilter

    return matchesSearch && matchesIndustry
  })

  useEffect(() => {
    setCandidatePage(1)
  }, [candidateSearch, candidateIndustryFilter])

  const candidateTotalPages = Math.max(
    1,
    Math.ceil(
      filteredCandidates.length / PEOPLE_PER_PAGE
    )
  )

  const displayedCandidates =
    filteredCandidates.slice(
      (candidatePage - 1) * PEOPLE_PER_PAGE,
      candidatePage * PEOPLE_PER_PAGE
    )

  // ============================================================
  // SELECT PEOPLE
  // ============================================================
  const togglePerson = personId => {
    setSelectedPersonIds(prev => {
      const next = new Set(prev)

      if (next.has(personId)) {
        next.delete(personId)
      } else {
        next.add(personId)
      }

      return next
    })
  }

  const selectAllFiltered = () => {
    setSelectedPersonIds(
      new Set(
        filteredCandidates.map(
          person => person.person_id
        )
      )
    )
  }

  const clearSelection = () => {
    setSelectedPersonIds(new Set())
  }

  // ============================================================
  // ADD SELECTED PEOPLE TO EVENT
  // ============================================================
  const submitAdd = async () => {
    if (
      !selectedEventId ||
      selectedPersonIds.size === 0
    ) {
      return
    }

    setSubmittingAdd(true)

    const rows = candidates
      .filter(person =>
        selectedPersonIds.has(person.person_id)
      )
      .map(person => ({
        event_id: selectedEventId,
        person_id: person.person_id,
        company_id: person.company_id || null,
        role: bulkRole,
        status: bulkStatus
      }))

    const { error } = await supabase
      .from('event_participants')
      .insert(rows)

    setSubmittingAdd(false)

    if (error) {
      showToast(
        `Couldn't add attendees: ${error.message}`,
        true
      )
      return
    }

    showToast(
      `${rows.length} ${
        rows.length === 1 ? 'person' : 'people'
      } added`
    )

    setShowAddPeopleModal(false)
    setSelectedPersonIds(new Set())

    const updated =
      await fetchParticipants(selectedEventId)

    fetchLeadsForEvent(selectedEventId)

    fetchPastEvents(
      selectedEventId,
      updated.map(row => row.person_id)
    )
  }

  // ============================================================
  // EDIT
  // ============================================================
  const startEdit = p => {
    setEditingId(p.participant_id)

    setEditForm({
      email: p.people?.email || '',
      job_title: p.people?.job_title || '',
      country: p.people?.country || '',
      phone: p.people?.phone || '',
      role: p.role || '',
      status: p.status || '',
      notes: p.notes || ''
    })
  }

  const cancelEdit = () => {
    setEditingId(null)
    setEditForm(null)
  }

  const saveEdit = async participant => {
    if (!participant || !editForm) return

    setSaving(true)

    // PEOPLE TABLE
    const { error: peopleError } = await supabase
      .from('people')
      .update({
        email: editForm.email?.trim() || null,
        job_title: editForm.job_title?.trim() || null,
        country: editForm.country?.trim() || null,
        phone: editForm.phone?.trim() || null,
        updated_at: new Date().toISOString()
      })
      .eq('person_id', participant.person_id)

    if (peopleError) {
      setSaving(false)
      showToast(
        `Couldn't update person: ${peopleError.message}`,
        true
      )
      return
    }

    // EVENT_PARTICIPANTS TABLE
    const { error: participantError } = await supabase
      .from('event_participants')
      .update({
        role: editForm.role || null,
        status: editForm.status || null,
        notes: editForm.notes?.trim() || null,
        updated_at: new Date().toISOString()
      })
      .eq('participant_id', participant.participant_id)

    setSaving(false)

    if (participantError) {
      showToast(
        `Person details were updated, but attendee details couldn't be saved: ${participantError.message}`,
        true
      )

      await fetchParticipants(selectedEventId)
      return
    }

    setParticipants(prev =>
      prev.map(row =>
        row.participant_id === participant.participant_id
          ? {
              ...row,
              role: editForm.role,
              status: editForm.status,
              notes: editForm.notes,
              people: {
                ...row.people,
                email: editForm.email,
                job_title: editForm.job_title,
                country: editForm.country,
                phone: editForm.phone
              }
            }
          : row
      )
    )

    setEditingId(null)
    setEditForm(null)

    showToast('Attendee updated')
  }

  // ============================================================
  // DELETE
  // ============================================================
  const removeParticipant = async participantId => {
    setRemovingId(participantId)

    const { error } = await supabase
      .from('event_participants')
      .delete()
      .eq('participant_id', participantId)

    setRemovingId(null)

    if (error) {
      showToast(
        `Couldn't remove: ${error.message}`,
        true
      )
      return
    }

    setParticipants(prev =>
      prev.filter(
        p => p.participant_id !== participantId
      )
    )

    showToast('Removed from event')
  }

  // ============================================================
  // EXPORT CURRENT DISPLAY TO CSV
  // ============================================================
  const exportCurrentDisplayToCSV = () => {
    if (!selectedEventId || filteredParticipants.length === 0) {
      showToast('There are no attendees to export', true)
      return
    }

    const selectedEvent = events.find(
      event => event.event_id === selectedEventId
    )

    const csvValue = value => {
      const text = value == null ? '' : String(value)
      return `"${text.replace(/"/g, '""')}"`
    }

    const headers = [
      'Name',
      'Email',
      'Company',
      'Job Title',
      'Country',
      'Phone',
      'Role',
      'Status',
      'Notes',
      'Past Events'
    ]

    const rows = filteredParticipants.map(p => {
      const name =
        `${p.people?.first_name || ''} ${
          p.people?.last_name || ''
        }`.trim()

      const history =
        pastEventsByPerson[p.person_id] || []

      const pastEvents = history
        .map(
          h =>
            `${h.event_name} (${formatDate(
              h.start_date
            )}) — ${h.status || '—'}`
        )
        .join(' | ')

      return [
        name,
        p.people?.email || '',
        p.companies?.company_name || '',
        p.people?.job_title || '',
        p.people?.country || '',
        p.people?.phone || '',
        p.role || '',
        p.status || '',
        p.notes || '',
        pastEvents
      ]
    })

    const csv = [
      headers.map(csvValue).join(','),
      ...rows.map(row =>
        row.map(csvValue).join(',')
      )
    ].join('\r\n')

    const blob = new Blob(
      ['\uFEFF' + csv],
      {
        type: 'text/csv;charset=utf-8;'
      }
    )

    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')

    const safeEventName = (
      selectedEvent?.event_name ||
      selectedEventId ||
      'attendees'
    )
      .replace(/[^a-z0-9_-]+/gi, '_')
      .replace(/^_+|_+$/g, '')

    link.href = url
    link.download = `${safeEventName}_attendees.csv`

    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(url)

    showToast(
      `${filteredParticipants.length} attendee${
        filteredParticipants.length === 1
          ? ''
          : 's'
      } exported`
    )
  }

  // ============================================================
  // SIMPLE PAGINATION COMPONENT
  // ============================================================
  const PageControls = ({
    page,
    setPage,
    totalPages,
    total
  }) => {
    if (totalPages <= 1) {
      return (
        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            padding: '12px 14px',
            fontSize: 12
          }}
        >
          {total} total
        </div>
      )
    }

    return (
      <div
        style={{
          display: 'flex',
          justifyContent: 'flex-end',
          alignItems: 'center',
          gap: 8,
          padding: '12px 14px'
        }}
      >
        <span className="crm-count-note">
          Page {page} of {totalPages} · {total} total
        </span>

        <button
          className="crm-toggle-chip"
          disabled={page === 1}
          onClick={() =>
            setPage(prev =>
              Math.max(1, prev - 1)
            )
          }
        >
          Previous
        </button>

        <button
          className="crm-toggle-chip"
          disabled={page === totalPages}
          onClick={() =>
            setPage(prev =>
              Math.min(
                totalPages,
                prev + 1
              )
            )
          }
        >
          Next
        </button>
      </div>
    )
  }

  // ============================================================
  // PAGE
  // ============================================================
  return (
    <div>

      {/* EVENT SELECTION + BUTTONS */}
      <div
        className="crm-toolbar"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10
        }}
      >
        <select
          className="crm-filter-select"
          value={selectedEventId}
          onChange={e =>
            setSelectedEventId(e.target.value)
          }
          disabled={eventsLoading}
        >
          {eventsLoading && (
            <option value="">
              Loading events…
            </option>
          )}

          {!eventsLoading &&
            events.length === 0 && (
              <option value="">
                No events yet — create one first
              </option>
            )}

          {events.map(event => (
            <option
              key={event.event_id}
              value={event.event_id}
            >
              {event.event_name} (
              {formatDate(event.start_date)})
            </option>
          ))}
        </select>

        {selectedEventId && (
          <>
            <button
              className="crm-primary-button"
              onClick={openAddPeopleModal}
              style={{
                padding: '8px 14px',
                borderRadius: 8,
                border: 'none',
                cursor: 'pointer',
                fontWeight: 600
              }}
            >
              + Add more people to this event
            </button>

            <button
              type="button"
              className="crm-toggle-chip"
              onClick={exportCurrentDisplayToCSV}
              disabled={
                filteredParticipants.length === 0
              }
            >
              Export CSV
            </button>
          </>
        )}

        <span
          className="crm-count-note"
          style={{ marginLeft: 'auto' }}
        >
          {participants.length} attached to this event
        </span>
      </div>

      {/* ATTENDEE SEARCH */}
      {selectedEventId && (
        <div
          className="crm-toolbar"
          style={{
            marginTop: 12,
            marginBottom: 12
          }}
        >
          <div
            className="crm-search-box"
            style={{ maxWidth: 700 }}
          >
            <Search
              size={15}
              style={{
                color: 'var(--ink-400)'
              }}
            />

            <input
              value={participantSearch}
              onChange={e =>
                setParticipantSearch(
                  e.target.value
                )
              }
              placeholder="Search attendee by name, email, company, job title, country, phone or notes…"
            />
          </div>

          {participantSearch && (
            <span className="crm-count-note">
              {filteredParticipants.length}{' '}
              result
              {filteredParticipants.length !== 1
                ? 's'
                : ''}
            </span>
          )}
        </div>
      )}

      {/* LOADING */}
      {participantsLoading && (
        <div className="crm-loading">
          <Loader2
            size={16}
            className="crm-spin"
          />
          Loading attendees…
        </div>
      )}

      {/* ATTENDEES TABLE */}
      {!participantsLoading &&
        selectedEventId && (
          <div
            className="crm-table-wrap"
            style={{ marginBottom: 28 }}
          >
            <table
              className="crm-table"
              style={{ minWidth: 1550 }}
            >
              <thead>
                <tr>
                  {[
                    'Name',
                    'Email',
                    'Company',
                    'Job Title',
                    'Country',
                    'Phone',
                    'Role',
                    'Status',
                    'Notes',
                    'Past Events',
                    ''
                  ].map(header => (
                    <th key={header}>
                      {header}
                    </th>
                  ))}
                </tr>
              </thead>

              <tbody>
                {displayedParticipants.map(p => {
                  const isEditing =
                    editingId ===
                    p.participant_id

                  const name =
                    `${p.people?.first_name || ''} ${
                      p.people?.last_name || ''
                    }`.trim() || '—'

                  const isLeadForThisEvent =
                    leadPersonIdsForEvent.has(
                      p.person_id
                    )

                  const history =
                    pastEventsByPerson[
                      p.person_id
                    ] || []

                  return (
                    <tr
                      key={p.participant_id}
                      className={
                        isEditing
                          ? 'editing'
                          : ''
                      }
                    >
                      <td>
                        <span
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center'
                          }}
                        >
                          {name}

                          {isLeadForThisEvent && (
                            <span className="crm-lead-tag">
                              Lead
                            </span>
                          )}
                        </span>
                      </td>

                      <td>
                        {isEditing ? (
                          <input
                            type="email"
                            className="crm-cell-input"
                            value={editForm.email}
                            onChange={e =>
                              setEditForm({
                                ...editForm,
                                email:
                                  e.target.value
                              })
                            }
                          />
                        ) : (
                          p.people?.email || '—'
                        )}
                      </td>

                      <td>
                        {p.companies
                          ?.company_name ||
                          '—'}
                      </td>

                      <td>
                        {isEditing ? (
                          <input
                            className="crm-cell-input"
                            value={
                              editForm.job_title
                            }
                            onChange={e =>
                              setEditForm({
                                ...editForm,
                                job_title:
                                  e.target.value
                              })
                            }
                          />
                        ) : (
                          p.people?.job_title ||
                          '—'
                        )}
                      </td>

                      <td>
                        {isEditing ? (
                          <input
                            className="crm-cell-input"
                            value={
                              editForm.country
                            }
                            onChange={e =>
                              setEditForm({
                                ...editForm,
                                country:
                                  e.target.value
                              })
                            }
                          />
                        ) : (
                          p.people?.country || '—'
                        )}
                      </td>

                      <td>
                        {isEditing ? (
                          <input
                            className="crm-cell-input"
                            value={editForm.phone}
                            onChange={e =>
                              setEditForm({
                                ...editForm,
                                phone:
                                  e.target.value
                              })
                            }
                          />
                        ) : (
                          p.people?.phone || '—'
                        )}
                      </td>

                      <td>
                        {isEditing ? (
                          <select
                            className="crm-cell-select"
                            value={editForm.role}
                            onChange={e =>
                              setEditForm({
                                ...editForm,
                                role:
                                  e.target.value
                              })
                            }
                          >
                            {PARTICIPANT_ROLE_OPTIONS.map(
                              role => (
                                <option
                                  key={role}
                                  value={role}
                                >
                                  {role}
                                </option>
                              )
                            )}
                          </select>
                        ) : (
                          <Badge value={p.role} />
                        )}
                      </td>

                      <td>
                        {isEditing ? (
                          <select
                            className="crm-cell-select"
                            value={
                              editForm.status
                            }
                            onChange={e =>
                              setEditForm({
                                ...editForm,
                                status:
                                  e.target.value
                              })
                            }
                          >
                            {PARTICIPANT_STATUS_OPTIONS.map(
                              status => (
                                <option
                                  key={status}
                                  value={status}
                                >
                                  {status}
                                </option>
                              )
                            )}
                          </select>
                        ) : (
                          <Badge value={p.status} />
                        )}
                      </td>

                      <td
                        style={{
                          minWidth: 220,
                          maxWidth: 320
                        }}
                      >
                        {isEditing ? (
                          <textarea
                            className="crm-cell-input"
                            value={
                              editForm.notes
                            }
                            rows={2}
                            onChange={e =>
                              setEditForm({
                                ...editForm,
                                notes:
                                  e.target.value
                              })
                            }
                            style={{
                              resize: 'vertical',
                              minWidth: 210
                            }}
                          />
                        ) : (
                          <span
                            className="crm-notes-cell"
                            title={p.notes || ''}
                            style={{
                              display: 'block',
                              maxWidth: 300
                            }}
                          >
                            {p.notes || '—'}
                          </span>
                        )}
                      </td>

                      <td>
                        {pastEventsLoading ? (
                          <span className="crm-muted">
                            …
                          </span>
                        ) : history.length ===
                          0 ? (
                          <span className="crm-muted">
                            —
                          </span>
                        ) : (
                          <span
                            className="crm-history-tag"
                            title={history
                              .map(
                                h =>
                                  `${h.event_name} (${formatDate(
                                    h.start_date
                                  )}) — ${
                                    h.status ||
                                    '—'
                                  }`
                              )
                              .join('\n')}
                          >
                            {history.length}{' '}
                            past event
                            {history.length > 1
                              ? 's'
                              : ''}
                          </span>
                        )}
                      </td>

                      <td>
                        <div className="crm-row-actions">
                          {isEditing ? (
                            <>
                              <button
                                className="crm-icon-action save"
                                onClick={() =>
                                  saveEdit(p)
                                }
                                disabled={saving}
                                aria-label="Save"
                              >
                                {saving ? (
                                  <Loader2
                                    size={14}
                                    className="crm-spin"
                                  />
                                ) : (
                                  <Save
                                    size={14}
                                  />
                                )}
                              </button>

                              <button
                                className="crm-icon-action cancel"
                                onClick={
                                  cancelEdit
                                }
                                disabled={saving}
                                aria-label="Cancel"
                              >
                                <XCircle
                                  size={14}
                                />
                              </button>
                            </>
                          ) : (
                            <>
                              <button
                                className="crm-icon-action"
                                onClick={() =>
                                  startEdit(p)
                                }
                                aria-label="Edit row"
                              >
                                <Pencil
                                  size={14}
                                />
                              </button>

                              <button
                                className="crm-icon-action cancel"
                                onClick={() =>
                                  removeParticipant(
                                    p.participant_id
                                  )
                                }
                                disabled={
                                  removingId ===
                                  p.participant_id
                                }
                                aria-label="Remove"
                              >
                                {removingId ===
                                p.participant_id ? (
                                  <Loader2
                                    size={14}
                                    className="crm-spin"
                                  />
                                ) : (
                                  <Trash2
                                    size={14}
                                  />
                                )}
                              </button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  )
                })}

                {filteredParticipants.length ===
                  0 && (
                  <tr className="crm-empty-row">
                    <td colSpan={11}>
                      {participantSearch
                        ? 'No attendees match your search.'
                        : "No one's attached to this event yet."}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>

            <PageControls
              page={participantsPage}
              setPage={
                setParticipantsPage
              }
              totalPages={
                participantTotalPages
              }
              total={
                filteredParticipants.length
              }
            />
          </div>
        )}

      {/* ADD PEOPLE MODAL */}
      {showAddPeopleModal &&
        selectedEventId && (
          <div
            style={{
              position: 'fixed',
              inset: 0,
              background:
                'rgba(0, 0, 0, 0.45)',
              zIndex: 9999,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: 30
            }}
            onMouseDown={e => {
              if (
                e.target ===
                e.currentTarget
              ) {
                closeAddPeopleModal()
              }
            }}
          >
            <div
              style={{
                width:
                  'min(1400px, 95vw)',
                height:
                  'min(850px, 90vh)',
                background:
                  'var(--surface, #fff)',
                borderRadius: 14,
                boxShadow:
                  '0 20px 60px rgba(0,0,0,.25)',
                display: 'flex',
                flexDirection: 'column',
                overflow: 'hidden'
              }}
            >
              <div
                style={{
                  padding:
                    '18px 22px',
                  borderBottom:
                    '1px solid rgba(0,0,0,.1)',
                  display: 'flex',
                  alignItems:
                    'center',
                  justifyContent:
                    'space-between',
                  gap: 16
                }}
              >
                <div>
                  <h2
                    className="crm-display"
                    style={{
                      margin: 0,
                      fontSize: 20
                    }}
                  >
                    Add people to event
                  </h2>

                  <div className="crm-count-note">
                    Choose people from
                    your People database.
                    People already attending
                    this event are excluded.
                  </div>
                </div>

                <button
                  className="crm-icon-action"
                  onClick={
                    closeAddPeopleModal
                  }
                  aria-label="Close"
                >
                  <XCircle size={20} />
                </button>
              </div>

              <div
                className="crm-toolbar"
                style={{
                  padding:
                    '14px 22px',
                  borderBottom:
                    '1px solid rgba(0,0,0,.08)'
                }}
              >
                <div
                  className="crm-search-box"
                  style={{
                    flex: 1,
                    minWidth: 250
                  }}
                >
                  <Search
                    size={15}
                    style={{
                      color:
                        'var(--ink-400)'
                    }}
                  />

                  <input
                    value={
                      candidateSearch
                    }
                    onChange={e =>
                      setCandidateSearch(
                        e.target.value
                      )
                    }
                    placeholder="Search by name, email or company…"
                  />
                </div>

                <select
                  className="crm-filter-select"
                  value={
                    candidateIndustryFilter
                  }
                  onChange={e =>
                    setCandidateIndustryFilter(
                      e.target.value
                    )
                  }
                >
                  <option value="">
                    All industries
                  </option>

                  {INDUSTRY_OPTIONS.map(
                    industry => (
                      <option
                        key={industry}
                        value={industry}
                      >
                        {industry}
                      </option>
                    )
                  )}
                </select>

                <select
                  className="crm-filter-select"
                  value={bulkRole}
                  onChange={e =>
                    setBulkRole(
                      e.target.value
                    )
                  }
                >
                  {PARTICIPANT_ROLE_OPTIONS.map(
                    role => (
                      <option
                        key={role}
                        value={role}
                      >
                        {role}
                      </option>
                    )
                  )}
                </select>

                <select
                  className="crm-filter-select"
                  value={bulkStatus}
                  onChange={e =>
                    setBulkStatus(
                      e.target.value
                    )
                  }
                >
                  {PARTICIPANT_STATUS_OPTIONS.map(
                    status => (
                      <option
                        key={status}
                        value={status}
                      >
                        {status}
                      </option>
                    )
                  )}
                </select>
              </div>

              <div
                style={{
                  padding:
                    '10px 22px',
                  display: 'flex',
                  alignItems:
                    'center',
                  gap: 10,
                  borderBottom:
                    '1px solid rgba(0,0,0,.08)'
                }}
              >
                <button
                  className="crm-toggle-chip"
                  onClick={
                    selectAllFiltered
                  }
                >
                  Select all filtered (
                  {
                    filteredCandidates.length
                  }
                  )
                </button>

                {selectedPersonIds.size >
                  0 && (
                  <button
                    className="crm-toggle-chip"
                    onClick={
                      clearSelection
                    }
                  >
                    Clear selection
                  </button>
                )}

                <span className="crm-count-note">
                  {
                    selectedPersonIds.size
                  }{' '}
                  selected
                </span>
              </div>

              <div
                style={{
                  flex: 1,
                  overflow: 'auto',
                  padding: '0 22px'
                }}
              >
                {candidatesLoading ? (
                  <div className="crm-loading">
                    <Loader2
                      size={16}
                      className="crm-spin"
                    />
                    Loading people…
                  </div>
                ) : (
                  <div
                    className="crm-table-wrap"
                    style={{
                      marginTop: 16
                    }}
                  >
                    <table className="crm-table">
                      <thead>
                        <tr>
                          {[
                            '',
                            'Name',
                            'Email',
                            'Company',
                            'Job title',
                            'Industry',
                            'Country'
                          ].map(header => (
                            <th key={header}>
                              {header}
                            </th>
                          ))}
                        </tr>
                      </thead>

                      <tbody>
                        {displayedCandidates.map(
                          person => (
                            <tr
                              key={
                                person.person_id
                              }
                              onClick={() =>
                                togglePerson(
                                  person.person_id
                                )
                              }
                              style={{
                                cursor:
                                  'pointer'
                              }}
                            >
                              <td>
                                <input
                                  type="checkbox"
                                  checked={selectedPersonIds.has(
                                    person.person_id
                                  )}
                                  onChange={() =>
                                    togglePerson(
                                      person.person_id
                                    )
                                  }
                                  onClick={e =>
                                    e.stopPropagation()
                                  }
                                />
                              </td>

                              <td>
                                {person.first_name}{' '}
                                {person.last_name}
                              </td>

                              <td>
                                {person.email ||
                                  '—'}
                              </td>

                              <td>
                                {person
                                  .companies
                                  ?.company_name ||
                                  '—'}
                              </td>

                              <td>
                                {person.job_title ||
                                  '—'}
                              </td>

                              <td>
                                {person.industry ||
                                  '—'}
                              </td>

                              <td>
                                {person.country ||
                                  '—'}
                              </td>
                            </tr>
                          )
                        )}

                        {filteredCandidates.length ===
                          0 && (
                          <tr className="crm-empty-row">
                            <td colSpan={7}>
                              No people match
                              the current
                              filters, or they
                              are already
                              attending this
                              event.
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>

                    <PageControls
                      page={
                        candidatePage
                      }
                      setPage={
                        setCandidatePage
                      }
                      totalPages={
                        candidateTotalPages
                      }
                      total={
                        filteredCandidates.length
                      }
                    />
                  </div>
                )}
              </div>

              <div
                style={{
                  padding:
                    '14px 22px',
                  borderTop:
                    '1px solid rgba(0,0,0,.1)',
                  display: 'flex',
                  justifyContent:
                    'space-between',
                  alignItems:
                    'center',
                  gap: 12
                }}
              >
                <span className="crm-count-note">
                  {
                    selectedPersonIds.size
                  }{' '}
                  person
                  {selectedPersonIds.size !==
                  1
                    ? 's'
                    : ''}{' '}
                  selected
                </span>

                <div
                  style={{
                    display: 'flex',
                    gap: 10
                  }}
                >
                  <button
                    className="crm-toggle-chip"
                    onClick={
                      closeAddPeopleModal
                    }
                    disabled={
                      submittingAdd
                    }
                  >
                    Cancel
                  </button>

                  <button
                    className="crm-primary-button"
                    onClick={submitAdd}
                    disabled={
                      selectedPersonIds.size ===
                        0 ||
                      submittingAdd
                    }
                    style={{
                      padding:
                        '9px 16px',
                      borderRadius: 8,
                      border: 'none',
                      fontWeight: 600,
                      cursor:
                        selectedPersonIds.size ===
                        0
                          ? 'not-allowed'
                          : 'pointer',
                      opacity:
                        selectedPersonIds.size ===
                        0
                          ? 0.5
                          : 1
                    }}
                  >
                    {submittingAdd ? (
                      <>
                        <Loader2
                          size={14}
                          className="crm-spin"
                        />{' '}
                        Adding…
                      </>
                    ) : (
                      `Add ${
                        selectedPersonIds.size ||
                        ''
                      } to event`
                    )}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
    </div>
  )
}

function PersonForm({ showToast }) {
  const [form, setForm] = useState({
    first_name: '',
    last_name: '',
    email: '',
    email1: '',
    job_title: '',
    industry: '',
    country: '',
    phone: '',
    mobile: '',
    linkedin_url: '',
    lead_purpose: 'Not Categorized Yet'
  })
  const [company, setCompany] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value })

const submit = async (e) => {
  e.preventDefault()
  if (!form.first_name) return
  setSubmitting(true)

  const { companyId, error: companyError } = await resolveCompanyId(company)
  if (companyError) {
    setSubmitting(false)
    showToast(`Couldn't save company: ${companyError.message}`, true)
    return
  }

  const { error } = await supabase.from('people').insert({
    ...form,
    email: form.email?.trim() || null,
    email1: form.email1?.trim() || null,
    lead_purpose: form.lead_purpose || 'Not Categorized Yet',
    company_id: companyId,
  })
  setSubmitting(false)
  if (error) { showToast(`Couldn't add person: ${error.message}`, true); return }
  setForm({
    first_name: '',
    last_name: '',
    email: '',
    email1: '',
    job_title: '',
    industry: '',
    country: '',
    phone: '',
    mobile: '',
    linkedin_url: '',
    lead_purpose: 'Not Categorized Yet'
  })
  setCompany(null)
  showToast('Person added')
}

  return (
    <form onSubmit={submit} className="crm-form">
      <div className="crm-form-row">
        <div><FieldLabel>First name</FieldLabel><input required value={form.first_name} onChange={set('first_name')} className="crm-input" /></div>
        <div><FieldLabel>Last name</FieldLabel><input value={form.last_name} onChange={set('last_name')} className="crm-input" /></div>
      </div>
      <div className="crm-form-row">
        <div><FieldLabel>Email</FieldLabel><input type="email" value={form.email} onChange={set('email')} className="crm-input" /></div>
        <div><FieldLabel>Email 1</FieldLabel><input type="email" value={form.email1} onChange={set('email1')} className="crm-input" /></div>
      </div>
      <div className="crm-form-row">
        <div><FieldLabel>Job title</FieldLabel><input value={form.job_title} onChange={set('job_title')} className="crm-input" /></div>
        <div>
          <FieldLabel>Industry</FieldLabel>
          <select value={form.industry} onChange={set('industry')} className="crm-select">
            <option value="">—</option>
            {INDUSTRY_OPTIONS.map(i => <option key={i} value={i}>{i}</option>)}
          </select>
        </div>
      </div>
      <div className="crm-form-row">
        <div><FieldLabel>Country</FieldLabel><input value={form.country} onChange={set('country')} className="crm-input" /></div>
        <div><FieldLabel>Company</FieldLabel><CompanyPicker value={company} onChange={setCompany} showToast={showToast} /></div>
      </div>
      <div className="crm-form-row">
        <div><FieldLabel>Phone</FieldLabel><input value={form.phone} onChange={set('phone')} className="crm-input" /></div>
        <div><FieldLabel>Mobile</FieldLabel><input value={form.mobile} onChange={set('mobile')} className="crm-input" /></div>
      </div>
      <div><FieldLabel>LinkedIn URL</FieldLabel><input value={form.linkedin_url} onChange={set('linkedin_url')} className="crm-input" /></div>
      <div>
        <FieldLabel>Lead purpose</FieldLabel>
        <select value={form.lead_purpose} onChange={set('lead_purpose')} className="crm-select">
          <option value="Delegate Acquisition">Delegate Acquisition</option>
          <option value="Sponsor Acquisition">Sponsor Acquisition</option>
          <option value="ABM">ABM</option>
          <option value="Not Categorized Yet">Not Categorized Yet</option>
        </select>
      </div>
      <button type="submit" className="crm-submit-btn" disabled={submitting}>
        {submitting ? <Loader2 size={15} className="crm-spin" /> : <UserPlus size={15} />} Add person
      </button>
    </form>
  )
}

function EventForm({ showToast }) {
  const [form, setForm] = useState({ event_id: '', event_name: '', event_type: '', location: '', country: '', status: 'Planned', start_date: '', end_date: '', add_info: '' })
  const [submitting, setSubmitting] = useState(false)
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value })

  const submit = async (e) => {
    e.preventDefault()
    if (!form.event_id || !form.event_name) return
    setSubmitting(true)
    const { error } = await supabase.from('events').insert(form)
    setSubmitting(false)
    if (error) { showToast(`Couldn't add event: ${error.message}`, true); return }
    setForm({ event_id: '', event_name: '', event_type: '', location: '', country: '', status: 'Planned', start_date: '', end_date: '', add_info: '' })
    showToast('Event added')
  }

  return (
    <form onSubmit={submit} className="crm-form">
      <div><FieldLabel>Event ID</FieldLabel><input required value={form.event_id} onChange={set('event_id')} className="crm-input" placeholder="Unique short code, e.g. SXSW26" /></div>
      <div><FieldLabel>Event name</FieldLabel><input required value={form.event_name} onChange={set('event_name')} className="crm-input" /></div>
      <div className="crm-form-row">
        <div><FieldLabel>Type</FieldLabel><input value={form.event_type} onChange={set('event_type')} className="crm-input" /></div>
        <div>
          <FieldLabel>Status</FieldLabel>
          <select value={form.status} onChange={set('status')} className="crm-select">
            {EVENT_STATUS_OPTIONS.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
      </div>
      <div className="crm-form-row">
        <div><FieldLabel>Start date</FieldLabel><input type="date" value={form.start_date} onChange={set('start_date')} className="crm-input" /></div>
        <div><FieldLabel>End date</FieldLabel><input type="date" value={form.end_date} onChange={set('end_date')} className="crm-input" /></div>
      </div>
      <div className="crm-form-row">
        <div><FieldLabel>Location</FieldLabel><input value={form.location} onChange={set('location')} className="crm-input" /></div>
        <div><FieldLabel>Country</FieldLabel><input value={form.country} onChange={set('country')} className="crm-input" /></div>
      </div>
      <div><FieldLabel>Notes</FieldLabel><textarea value={form.add_info} onChange={set('add_info')} className="crm-textarea" /></div>
      <button type="submit" className="crm-submit-btn" disabled={submitting}>
        {submitting ? <Loader2 size={15} className="crm-spin" /> : <Calendar size={15} />} Add event
      </button>
    </form>
  )
}

// ============================================================================
// CREATE — tabbed entry point wrapping PersonForm and EventForm. This was
// referenced from App's activePage switch but never actually defined, which
// is why the Create nav item rendered a blank page.
// ============================================================================
function CreatePage({ showToast }) {
  const [tab, setTab] = useState('person')

  return (
    <div className="crm-create-wrap">
      <div className="crm-tabs">
        <button
          type="button"
          className={`crm-tab-btn${tab === 'person' ? ' active' : ''}`}
          onClick={() => setTab('person')}
        >
          <UserPlus size={14} style={{ marginRight: 6, verticalAlign: -2 }} />
          Person
        </button>
        <button
          type="button"
          className={`crm-tab-btn${tab === 'event' ? ' active' : ''}`}
          onClick={() => setTab('event')}
        >
          <Calendar size={14} style={{ marginRight: 6, verticalAlign: -2 }} />
          Event
        </button>
      </div>

      {tab === 'person' ? <PersonForm showToast={showToast} /> : <EventForm showToast={showToast} />}
    </div>
  )
}
