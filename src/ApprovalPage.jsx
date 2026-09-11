import { useState, useEffect, useCallback, useMemo } from 'react'
import { supabase } from './lib/supabase'
import { Search, Loader2, Check, X, Clock } from 'lucide-react'

// This page reads/writes public.approval — rows are inserted by the
// "Email Track Reply" Make.com scenario (status defaults to 'pending').
// Approving here sets status='approved', which a separate Make scenario
// watches for to actually send the email. Rejecting just marks the row so
// it's excluded from that send scenario.

const PAGE_SIZE = 10

function paginate(items, page) {
  const start = (page - 1) * PAGE_SIZE
  return items.slice(start, start + PAGE_SIZE)
}

// ai_answer is stored as HTML (<br> line breaks) so it can be sent directly
// as an HTML email. The textarea shows/edits plain text for a normal typing
// experience, converting back to <br> only when saving.
function htmlToText(html) {
  return (html || '').replace(/<br\s*\/?>/gi, '\n')
}
function textToHtml(text) {
  return (text || '').replace(/\n/g, '<br>')
}

function StatusPill({ status }) {
  const tone = {
    pending: { bg: 'var(--amber-soft)', fg: 'var(--amber)' },
    approved: { bg: 'var(--accent-soft)', fg: 'var(--accent-ink)' },
    rejected: { bg: 'var(--red-soft)', fg: 'var(--red)' },
  }[status] || { bg: 'var(--line)', fg: 'var(--ink-700)' }
  return <span className="crm-badge" style={{ background: tone.bg, color: tone.fg }}>{status}</span>
}

function formatDateTime(d) {
  if (!d) return '—'
  return new Date(d).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })
}

export default function ApprovalPage({ showToast }) {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [tab, setTab] = useState('pending')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [drafts, setDrafts] = useState({}) // { [approvalId]: editedText }
  const [busyId, setBusyId] = useState(null)

  const fetchRows = useCallback(async () => {
    setLoading(true)
    setError(null)
    // people(...) and events(...) rely on the FK constraints
    // (approval_person_id_fkey / approval_event_id_fkey) being present in
    // Supabase's schema cache. If this embed ever errors out, drop the
    // "people(...)" / "events(...)" parts below and fall back to showing
    // raw person_id / event_id.
    const { data, error } = await supabase
      .from('approval')
      .select('*, people(first_name, last_name, email), events(event_name)')
      .order('created_at', { ascending: false })
    if (error) setError(error.message)
    else setRows(data || [])
    setLoading(false)
  }, [])

  useEffect(() => { fetchRows() }, [fetchRows])

  const counts = useMemo(() => {
    const c = { pending: 0, approved: 0, rejected: 0 }
    rows.forEach(r => { if (c[r.status] !== undefined) c[r.status]++ })
    return c
  }, [rows])

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim()
    return rows.filter(r => {
      if (tab !== 'all' && r.status !== tab) return false
      if (!q) return true
      const person = r.people ? `${r.people.first_name || ''} ${r.people.last_name || ''} ${r.people.email || ''}` : ''
      return `${person} ${r.lead_purpose || ''} ${r.event_id || ''} ${r.events?.event_name || ''}`.toLowerCase().includes(q)
    })
  }, [rows, tab, search])

  useEffect(() => { setPage(1) }, [tab, search])

  const decide = async (row, nextStatus) => {
    setBusyId(row.id)
    const edited = drafts[row.id]
    const payload = { status: nextStatus }
    // Only send ai_answer back if the reviewer actually changed it.
    // The textarea holds plain text; convert back to <br> HTML for storage/sending.
    if (nextStatus === 'approved' && edited !== undefined) {
      const editedHtml = textToHtml(edited)
      if (editedHtml !== row.ai_answer) payload.ai_answer = editedHtml
    }
    const { error } = await supabase.from('approval').update(payload).eq('id', row.id)
    setBusyId(null)
    if (error) { showToast?.(`Couldn't update: ${error.message}`, true); return }
    setRows(prev => prev.map(r => (r.id === row.id ? { ...r, ...payload } : r)))
    showToast?.(nextStatus === 'approved' ? 'Reply approved' : 'Reply rejected')
  }

  return (
    <div>
      <div className="crm-toolbar">
        <div className="crm-search-box">
          <Search size={15} style={{ color: 'var(--ink-400)' }} />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search by name, email, event, purpose…" />
        </div>
        <select className="crm-filter-select" value={tab} onChange={e => setTab(e.target.value)}>
          <option value="pending">Pending ({counts.pending})</option>
          <option value="approved">Approved ({counts.approved})</option>
          <option value="rejected">Rejected ({counts.rejected})</option>
          <option value="all">All ({rows.length})</option>
        </select>
        <span className="crm-count-note">{filtered.length} of {rows.length}</span>
      </div>

      {loading && <div className="crm-loading"><Loader2 size={16} className="crm-spin" /> Loading drafts…</div>}
      {error && <div className="crm-error">Couldn't load approvals: {error}</div>}

      {!loading && !error && (
        <>
          {filtered.length === 0 && <div className="crm-loading">Nothing here.</div>}

          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {paginate(filtered, page).map(row => {
              const person = row.people
              const name = person ? `${person.first_name || ''} ${person.last_name || ''}`.trim() : `Person #${row.person_id}`
              const isBusy = busyId === row.id
              const text = drafts[row.id] !== undefined ? drafts[row.id] : htmlToText(row.ai_answer)

              return (
                <div key={row.id} style={{ border: '1px solid var(--line)', borderRadius: 12, padding: 16, background: 'var(--surface)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginBottom: 10 }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 600, color: 'var(--ink-950)' }}>{name || '—'}</div>
                      <div style={{ fontSize: 12.5, color: 'var(--ink-400)' }}>
                        {person?.email || '—'} · {row.events?.event_name || row.event_id} · {row.lead_purpose || '—'}
                      </div>
                      <div style={{ fontSize: 11.5, color: 'var(--ink-400)', marginTop: 2 }}>
                        <Clock size={11} style={{ marginRight: 4, verticalAlign: -2 }} />
                        {formatDateTime(row.created_at)}
                      </div>
                    </div>
                    <StatusPill status={row.status} />
                  </div>

                  <textarea
                    className="crm-textarea"
                    style={{ minHeight: 110 }}
                    value={text}
                    disabled={row.status !== 'pending'}
                    onChange={e => setDrafts(prev => ({ ...prev, [row.id]: e.target.value }))}
                  />

                  {row.status === 'pending' && (
                    <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                      <button
                        className="crm-submit-btn"
                        style={{ background: 'var(--accent-ink)', width: 'auto', padding: '9px 16px' }}
                        onClick={() => decide(row, 'approved')}
                        disabled={isBusy}
                      >
                        {isBusy ? <Loader2 size={14} className="crm-spin" /> : <Check size={14} />} Approve &amp; send
                      </button>
                      <button
                        className="crm-submit-btn"
                        style={{ background: 'var(--red)', width: 'auto', padding: '9px 16px' }}
                        onClick={() => decide(row, 'rejected')}
                        disabled={isBusy}
                      >
                        {isBusy ? <Loader2 size={14} className="crm-spin" /> : <X size={14} />} Reject
                      </button>
                    </div>
                  )}
                </div>
              )
            })}
          </div>

          <div className="crm-pagination" style={{ marginTop: 16 }}>
            <span>Page {page} of {Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))} · {filtered.length} total</span>
            <button className="crm-page-btn" onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page <= 1}>Prev</button>
            <button
              className="crm-page-btn"
              onClick={() => setPage(p => Math.min(Math.max(1, Math.ceil(filtered.length / PAGE_SIZE)), p + 1))}
              disabled={page >= Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))}
            >
              Next
            </button>
          </div>
        </>
      )}
    </div>
  )
}
