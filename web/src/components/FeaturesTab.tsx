'use client'

import { useState, useRef, useEffect } from 'react'
import { apiFetch } from '@/lib/api'
import type { PublicFeature } from '@/types/public'

const STATUS_LABELS: Record<string, string> = {
  open: 'Open',
  planned: 'Planned',
  in_progress: 'In Progress',
  shipped: 'Shipped',
  closed: 'Closed',
}

const STATUS_STYLES: Record<string, string> = {
  open: 'bg-blue-50 text-blue-700',
  planned: 'bg-purple-50 text-purple-700',
  in_progress: 'bg-amber-50 text-amber-700',
  shipped: 'bg-green-50 text-green-700',
  closed: 'bg-gray-100 text-gray-500',
}

const PAGE_SIZE = 10
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// AbortSignal.timeout was added in Node 17.3 / Chrome 103 — guard for older envs (e.g. jsdom in tests)
function timeoutSignal(ms: number): AbortSignal | undefined {
  return typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(ms) : undefined
}

type VoteState = 'idle' | 'entering' | 'loading' | 'sent' | 'already_voted' | 'error'

interface VoteStatus {
  state: VoteState
  message?: string
}

interface SubmitForm {
  title: string
  description: string
  email: string
}

type SubmitState = 'idle' | 'loading' | 'success' | 'error'

interface Props {
  initialFeatures: PublicFeature[]
  projectKey: string
}

export default function FeaturesTab({ initialFeatures, projectKey }: Props) {
  const [features, setFeatures] = useState<PublicFeature[]>(initialFeatures)
  const [page, setPage] = useState(0)

  const [voteStates, setVoteStates] = useState<Record<string, VoteStatus>>({})
  const [voteEmails, setVoteEmails] = useState<Record<string, string>>({})

  const [showModal, setShowModal] = useState(false)
  const [submitForm, setSubmitForm] = useState<SubmitForm>({ title: '', description: '', email: '' })
  const [submitState, setSubmitState] = useState<SubmitState>('idle')
  const [submitError, setSubmitError] = useState('')

  // fix 2: prevents double-submit race on rapid Enter presses
  const submittingRef = useRef(false)
  // fix 3: cancel stale auto-close timer when modal reopens during countdown
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // fix 9: return focus to trigger button after modal closes
  const submitBtnRef = useRef<HTMLButtonElement>(null)
  // fix 15: hold submitted title across the form reset that precedes success render
  const successTitleRef = useRef('')

  // fix 17: reject non-UUID project keys before building any fetch URLs
  const isValidKey = UUID_RE.test(projectKey)

  // issue-3-fix: per-feature in-flight set — synchronous guard that React state batching can't race
  const votingInFlightRef = useRef(new Set<string>())

  // fix 9: focus first input on open; return focus to trigger button on close
  // hasOpenedRef prevents focus-steal on initial mount (effect fires once with showModal=false)
  const hasOpenedRef = useRef(false)
  useEffect(() => {
    if (showModal) {
      hasOpenedRef.current = true
      requestAnimationFrame(() => {
        document.getElementById('submit-title')?.focus()
      })
    } else if (hasOpenedRef.current) {
      submitBtnRef.current?.focus()
    }
  }, [showModal])

  // issue-2-fix: clear auto-close timer on unmount to prevent setState on unmounted tree
  useEffect(() => {
    return () => {
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current)
    }
  }, [])

  // fix 10: Escape closes modal; cleanup prevents stale listener after unmount
  useEffect(() => {
    if (!showModal) return
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') closeModal()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [showModal])

  const totalPages = Math.ceil(features.length / PAGE_SIZE)
  const paginated = features.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)

  // fix 19: state field required — prevents accidental silent reset to 'idle'
  function setVote(id: string, update: { state: VoteState } & Omit<Partial<VoteStatus>, 'state'>) {
    setVoteStates((prev) => ({ ...prev, [id]: { ...prev[id], ...update } }))
  }

  function setVoteEmail(id: string, val: string) {
    setVoteEmails((prev) => ({ ...prev, [id]: val }))
  }

  function handleVoteClick(featureId: string) {
    const current = voteStates[featureId]?.state ?? 'idle'
    if (current === 'sent' || current === 'already_voted' || current === 'loading') return
    const isCollapsing = current === 'entering'
    if (isCollapsing) {
      setVoteEmail(featureId, '') // fix 14: clear stale input on collapse
    }
    setVote(featureId, { state: isCollapsing ? 'idle' : 'entering' })
  }

  async function submitVote(featureId: string) {
    // issue-3-fix: synchronous ref check — not subject to React state batching delays
    if (votingInFlightRef.current.has(featureId)) return
    votingInFlightRef.current.add(featureId)

    if (!isValidKey) {
      setVote(featureId, { state: 'error', message: 'Invalid project key.' })
      return
    }

    const email = (voteEmails[featureId] ?? '').trim()
    if (!email) return

    // fix 4: validate email format client-side before hitting the API
    if (!EMAIL_RE.test(email)) {
      setVote(featureId, { state: 'error', message: 'Please enter a valid email address.' })
      return
    }

    setVote(featureId, { state: 'loading' })
    try {
      const res = await apiFetch(`/api/v1/public/${encodeURIComponent(projectKey)}/features/${encodeURIComponent(featureId)}/vote`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
        signal: timeoutSignal(10_000),
      })
      if (res.ok) {
        setVote(featureId, { state: 'sent' })
        // fix 13: increment count optimistically — avoids requiring a full page reload
        setFeatures((prev) =>
          prev.map((f) => (f.id === featureId ? { ...f, voteCount: f.voteCount + 1 } : f))
        )
        return
      }
      const data = await res.json().catch(() => ({})) as Record<string, unknown>
      if (res.status === 409) {
        setVote(featureId, { state: 'already_voted', message: String(data.message ?? 'Already voted.') })
        return
      }
      if (res.status === 429) {
        setVote(featureId, { state: 'error', message: 'Too many attempts. Try again later.' })
        return
      }
      setVote(featureId, { state: 'error', message: String(data.message ?? 'Something went wrong.') })
    } catch {
      setVote(featureId, { state: 'error', message: 'Network error. Try again.' })
    } finally {
      votingInFlightRef.current.delete(featureId)
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (submittingRef.current) return // fix 2: synchronous in-flight guard

    // fix 5: reject whitespace-only title before the API call
    if (!submitForm.title.trim()) {
      setSubmitError('Title is required.')
      setSubmitState('error')
      return
    }

    if (!isValidKey) { // fix 17
      setSubmitError('Invalid project configuration.')
      setSubmitState('error')
      return
    }

    submittingRef.current = true
    setSubmitState('loading')
    setSubmitError('')
    successTitleRef.current = submitForm.title.trim() // fix 15: capture before reset

    try {
      const res = await apiFetch(`/api/v1/public/${encodeURIComponent(projectKey)}/features`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: submitForm.title.trim(),
          description: submitForm.description.trim() || null,
          email: submitForm.email.trim(),
        }),
        signal: timeoutSignal(10_000), // fix 16
      })
      if (res.status === 201) {
        const raw: unknown = await res.json()
        // fix 20 + issue-6-fix: shape check — fall to error if response is malformed
        // so the user knows to reload rather than seeing a false success
        const isValidShape =
          typeof raw === 'object' &&
          raw !== null &&
          typeof (raw as Record<string, unknown>).id === 'string' &&
          typeof (raw as Record<string, unknown>).title === 'string' &&
          typeof (raw as Record<string, unknown>).voteCount === 'number'

        if (!isValidShape) {
          setSubmitError('Server returned an unexpected response. Please reload and try again.')
          setSubmitState('error')
          return
        }

        setFeatures((prev) => [raw as PublicFeature, ...prev])
        setPage(0)
        setSubmitState('success')
        setSubmitForm({ title: '', description: '', email: '' })
        // fix 3: cancel any prior timer so reopening the modal mid-countdown is safe
        if (closeTimerRef.current) clearTimeout(closeTimerRef.current)
        closeTimerRef.current = setTimeout(() => {
          setShowModal(false)
          setSubmitState('idle')
          closeTimerRef.current = null
        }, 1500)
        return
      }
      const data = await res.json().catch(() => ({})) as Record<string, unknown>
      // fix 18: data.message is server-controlled; safe because React JSX text escapes HTML
      setSubmitError(String(data.message ?? 'Something went wrong.'))
      setSubmitState('error')
    } catch {
      setSubmitError('Network error. Try again.')
      setSubmitState('error')
    } finally {
      submittingRef.current = false
    }
  }

  function openModal() {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current)
      closeTimerRef.current = null
    }
    setSubmitState('idle')
    setSubmitError('')
    setShowModal(true)
  }

  // issue-5-fix: centralise close so timer is always cancelled, regardless of close path
  function closeModal() {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current)
      closeTimerRef.current = null
    }
    setShowModal(false)
  }

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <p className="text-sm text-gray-500">
          {features.length === 0
            ? 'No requests yet.'
            : `${features.length} request${features.length === 1 ? '' : 's'}`}
        </p>
        {/* fix 12: aria-haspopup signals this opens a dialog */}
        <button
          ref={submitBtnRef}
          onClick={openModal}
          aria-haspopup="dialog"
          className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
        >
          + Submit Request
        </button>
      </div>

      <div className="space-y-3">
        {paginated.length === 0 && (
          <p className="text-sm text-gray-500">No feature requests yet.</p>
        )}
        {paginated.map((f) => {
          const vs = voteStates[f.id] ?? { state: 'idle' as VoteState }
          const canVote = f.status !== 'closed' && f.status !== 'shipped'
          const isEntering = vs.state === 'entering'
          const isLoading = vs.state === 'loading'
          const isSent = vs.state === 'sent'
          const isAlreadyVoted = vs.state === 'already_voted'
          const isVoteError = vs.state === 'error'
          const showEmailRow = isEntering || isLoading

          return (
            <div key={f.id} className="rounded-lg border border-gray-200 p-4">
              <div className="flex items-start gap-3">
                <div className="flex flex-col items-center">
                  <button
                    onClick={() => canVote && handleVoteClick(f.id)}
                    disabled={!canVote || isSent || isAlreadyVoted || isLoading}
                    aria-label={`Vote for ${f.title}`}
                    className={`flex min-w-[3rem] flex-col items-center rounded-md px-3 py-2 text-sm font-semibold transition-colors
                      ${isSent ? 'bg-green-50 text-green-700 cursor-default' :
                        isAlreadyVoted ? 'bg-gray-100 text-gray-400 cursor-default' :
                        !canVote ? 'bg-gray-50 text-gray-300 cursor-default' :
                        isEntering || isLoading ? 'bg-blue-50 text-blue-700 ring-1 ring-blue-300' :
                        'bg-gray-50 text-gray-600 hover:bg-blue-50 hover:text-blue-700'}`}
                  >
                    <span className="text-base leading-none" aria-hidden="true">
                      {isSent ? '✓' : '▲'}
                    </span>
                    <span className="mt-0.5 text-xs">{f.voteCount}</span>
                  </button>
                </div>

                <div className="flex-1 min-w-0">
                  <h3 className="break-words text-sm font-semibold text-gray-900">{f.title}</h3>
                  {f.description && (
                    <p className="mt-1 text-xs text-gray-500 line-clamp-2">{f.description}</p>
                  )}
                  <span
                    className={`mt-2 inline-block rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[f.status] ?? 'bg-gray-100 text-gray-500'}`}
                  >
                    {STATUS_LABELS[f.status] ?? f.status}
                  </span>
                </div>
              </div>

              {/* fix 7: email row stays mounted during loading for keyboard/a11y continuity */}
              {showEmailRow && (
                <div className="mt-3 flex flex-wrap gap-2 pl-[3.75rem]">
                  <input
                    type="email"
                    required
                    placeholder="your@email.com"
                    value={voteEmails[f.id] ?? ''}
                    onChange={(e) => setVoteEmail(f.id, e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && submitVote(f.id)}
                    disabled={isLoading}
                    autoFocus
                    className="min-w-[6rem] flex-1 rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-60"
                    aria-label="Email to verify vote"
                  />
                  {/* fix 8: focus-visible ring */}
                  <button
                    onClick={() => submitVote(f.id)}
                    disabled={isLoading}
                    aria-busy={isLoading}
                    className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-60"
                  >
                    {isLoading ? (
                      <>
                        <span aria-hidden="true">⏳</span>
                        <span className="sr-only">Sending…</span>
                      </>
                    ) : (
                      'Vote'
                    )}
                  </button>
                  <button
                    onClick={() => {
                      setVoteEmail(f.id, '') // fix 14
                      setVote(f.id, { state: 'idle' })
                    }}
                    className="rounded-md px-2 py-1.5 text-sm text-gray-400 hover:text-gray-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-400"
                    aria-label="Cancel"
                  >
                    ✕
                  </button>
                </div>
              )}

              {/* fix 7: aria-live region announces vote state to screen readers */}
              <div aria-live="polite" aria-atomic="true" className="pl-[3.75rem]">
                {isSent && (
                  <p className="mt-2 text-xs text-green-600">Check your email to confirm your vote.</p>
                )}
                {(isAlreadyVoted || isVoteError) && (
                  <p className="mt-2 text-xs text-red-500">{vs.message}</p>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {/* fix 11: arrow chars wrapped in aria-hidden */}
      {totalPages > 1 && (
        <div className="mt-6 flex items-center justify-between">
          <button
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            disabled={page === 0}
            aria-label="Previous page"
            className="rounded-md border border-gray-200 px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50 disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
          >
            <span aria-hidden="true">←</span> Previous
          </button>
          <span className="text-xs text-gray-400">
            Page {page + 1} of {totalPages}
          </span>
          <button
            onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
            disabled={page >= totalPages - 1}
            aria-label="Next page"
            className="rounded-md border border-gray-200 px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50 disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
          >
            Next <span aria-hidden="true">→</span>
          </button>
        </div>
      )}

      {showModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="submit-modal-title"
          onClick={(e) => { if (e.target === e.currentTarget) closeModal() }}
        >
          <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl">
            <div className="mb-4 flex items-center justify-between">
              <h2 id="submit-modal-title" className="text-base font-semibold text-gray-900">
                Submit a Feature Request
              </h2>
              <button
                onClick={closeModal}
                className="text-gray-400 hover:text-gray-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-400"
                aria-label="Close"
              >
                ✕
              </button>
            </div>

            {submitState === 'success' ? (
              /* fix 15: show submitted title in success message */
              <p className="py-4 text-center text-sm text-green-600">
                ✓ &ldquo;{successTitleRef.current}&rdquo; submitted! Check your email to verify.
              </p>
            ) : (
              <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                  <label htmlFor="submit-title" className="mb-1 block text-xs font-medium text-gray-700">
                    Title <span aria-hidden="true">*</span>
                  </label>
                  <input
                    id="submit-title"
                    type="text"
                    required
                    maxLength={200}
                    value={submitForm.title}
                    onChange={(e) => setSubmitForm((f) => ({ ...f, title: e.target.value }))}
                    className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                    placeholder="What feature do you need?"
                  />
                </div>

                <div>
                  <label htmlFor="submit-description" className="mb-1 block text-xs font-medium text-gray-700">
                    Description
                  </label>
                  <textarea
                    id="submit-description"
                    maxLength={1000}
                    value={submitForm.description}
                    onChange={(e) => setSubmitForm((f) => ({ ...f, description: e.target.value }))}
                    rows={3}
                    className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                    placeholder="Describe the use case (optional)"
                  />
                </div>

                <div>
                  <label htmlFor="submit-email" className="mb-1 block text-xs font-medium text-gray-700">
                    Email <span aria-hidden="true">*</span>
                  </label>
                  {/* fix 6: maxLength=254 per RFC 5321 */}
                  <input
                    id="submit-email"
                    type="email"
                    required
                    maxLength={254}
                    value={submitForm.email}
                    onChange={(e) => setSubmitForm((f) => ({ ...f, email: e.target.value }))}
                    className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                    placeholder="your@email.com"
                  />
                  <p className="mt-1 text-xs text-gray-400">Used to verify your request.</p>
                </div>

                {submitState === 'error' && (
                  <p className="text-xs text-red-500" role="alert">{submitError}</p>
                )}

                <div className="flex justify-end gap-2 pt-1">
                  <button
                    type="button"
                    onClick={closeModal}
                    className="rounded-md border border-gray-200 px-4 py-2 text-sm text-gray-600 hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-400"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={submitState === 'loading'}
                    aria-busy={submitState === 'loading'}
                    className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-60"
                  >
                    {submitState === 'loading' ? 'Submitting…' : 'Submit'}
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
