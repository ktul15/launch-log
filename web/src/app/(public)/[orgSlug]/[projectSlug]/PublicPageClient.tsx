'use client'

import { useState, useRef, useEffect } from 'react'
import Link from 'next/link'
import RichTextViewer from '@/components/RichTextViewer'
import FeaturesTab from './FeaturesTab'
import { apiFetch } from '@/lib/api'
import type { TipTapDoc } from '@/types/changelog'
import type { PublicChangelogEntry, PublicFeature, PublicRoadmapItem } from '@/types/public'

export type Tab = 'changelog' | 'roadmap' | 'features'

const TAB_LABELS: Record<Tab, string> = {
  changelog: 'Changelog',
  roadmap: 'Roadmap',
  features: 'Features',
}

// Single source of truth for roadmap column config — status, label, and visual styles co-located.
const ROADMAP_COLUMNS: {
  status: PublicRoadmapItem['status']
  label: string
  headerStyle: string
  cardBorder: string
}[] = [
  {
    status: 'planned',
    label: 'Planned',
    headerStyle: 'bg-blue-50 border border-blue-200 text-blue-800',
    cardBorder: 'border-l-blue-400',
  },
  {
    status: 'in_progress',
    label: 'In Progress',
    headerStyle: 'bg-amber-50 border border-amber-200 text-amber-800',
    cardBorder: 'border-l-amber-400',
  },
  {
    status: 'shipped',
    label: 'Shipped',
    headerStyle: 'bg-green-50 border border-green-200 text-green-800',
    cardBorder: 'border-l-green-400',
  },
]

const KNOWN_ROADMAP_STATUSES = new Set(ROADMAP_COLUMNS.map((c) => c.status))

const TABS: Tab[] = ['changelog', 'roadmap', 'features']

function formatDate(iso: string): string {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
}

interface Props {
  changelog: PublicChangelogEntry[]
  roadmap: PublicRoadmapItem[]
  features: PublicFeature[]
  activeTab: Tab
  projectKey: string
}

export default function PublicPageClient({ changelog, roadmap, features, activeTab, projectKey }: Props) {
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [contentCache, setContentCache] = useState<Record<string, TipTapDoc>>({})
  // fix 21: per-entry loading set prevents one entry's fetch clobbering another's loading state
  const [loadingIds, setLoadingIds] = useState<Set<string>>(new Set())
  const [errorId, setErrorId] = useState<string | null>(null)
  // fix 22: per-entry AbortController so re-expanding an entry cancels any stale in-flight fetch
  const abortRefs = useRef(new Map<string, AbortController>())

  // Only render items whose status matches a known column — guards against future backend enum additions.
  const knownRoadmapItems = roadmap.filter((i) => KNOWN_ROADMAP_STATUSES.has(i.status))

  // issue-9-fix: abort all pending fetches on unmount to prevent setState on unmounted tree
  useEffect(() => {
    const refs = abortRefs.current
    return () => { refs.forEach((c) => c.abort()); refs.clear() }
  }, [])

  async function handleExpand(entryId: string) {
    if (expandedId === entryId) {
      setExpandedId(null)
      // issue-8-fix: abort any in-flight fetch when user collapses the entry
      abortRefs.current.get(entryId)?.abort()
      abortRefs.current.delete(entryId)
      return
    }
    setExpandedId(entryId)
    setErrorId(null)
    if (contentCache[entryId]) return

    // fix 22: cancel any prior in-flight fetch for this entry before starting a new one
    abortRefs.current.get(entryId)?.abort()
    const controller = new AbortController()
    abortRefs.current.set(entryId, controller)

    setLoadingIds((prev) => { const s = new Set(prev); s.add(entryId); return s })
    try {
      const res = await apiFetch(`/api/v1/public/${projectKey}/changelog/${entryId}`, {
        signal: controller.signal,
      })
      if (res.ok) {
        const data = await res.json()
        // issue-10-fix: ensure content is an object before passing to RichTextViewer
        if (data.content !== null && typeof data.content === 'object') {
          setContentCache((c) => ({ ...c, [entryId]: data.content }))
        }
      } else {
        setErrorId(entryId)
      }
    } catch (err) {
      // AbortError means we intentionally cancelled — don't surface as an error
      if (err instanceof Error && err.name !== 'AbortError') {
        setErrorId(entryId)
      }
    } finally {
      abortRefs.current.delete(entryId)
      setLoadingIds((prev) => { const s = new Set(prev); s.delete(entryId); return s })
    }
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <nav aria-label="Project sections" className="mb-8 flex gap-1 border-b border-gray-200">
        {TABS.map((t) => (
          <Link
            key={t}
            href={`?tab=${t}`}
            aria-current={activeTab === t ? 'page' : undefined}
            className={`px-4 py-2 text-sm font-medium transition-colors ${
              activeTab === t
                ? 'border-b-2 border-blue-600 text-blue-600'
                : 'text-gray-500 hover:text-gray-800'
            }`}
          >
            {TAB_LABELS[t]}
          </Link>
        ))}
      </nav>

      {activeTab === 'changelog' && (
        <div className="space-y-6">
          {changelog.length === 0 && (
            <p className="text-sm text-gray-500">No changelog entries yet.</p>
          )}
          {changelog.map((entry) => (
            <div key={entry.id} className="border-b border-gray-100 pb-6">
              <button
                className="w-full text-left"
                onClick={() => handleExpand(entry.id)}
                aria-expanded={expandedId === entry.id}
                aria-controls={`changelog-content-${entry.id}`}
                aria-label={entry.title}
              >
                <div className="mb-1 flex items-center gap-2">
                  {entry.version && (
                    <span className="rounded bg-gray-100 px-2 py-0.5 text-xs font-mono text-gray-600">
                      {entry.version}
                    </span>
                  )}
                  {entry.publishedAt && (() => {
                    const formatted = formatDate(entry.publishedAt)
                    return formatted ? (
                      <span className="text-xs text-gray-400">{formatted}</span>
                    ) : null
                  })()}
                  <span className="ml-auto text-xs text-gray-400" aria-hidden="true">
                    {expandedId === entry.id ? '▾' : '▸'}
                  </span>
                </div>
                <h3 className="text-base font-semibold text-gray-900">{entry.title}</h3>
              </button>
              <div id={`changelog-content-${entry.id}`}>
                {expandedId === entry.id && (
                  <div className="mt-4">
                    {loadingIds.has(entry.id) ? (
                      <div className="min-h-[40px] animate-pulse rounded bg-gray-50" />
                    ) : errorId === entry.id ? (
                      <p className="text-xs text-red-500">Failed to load content. Try again.</p>
                    ) : contentCache[entry.id] ? (
                      <RichTextViewer content={contentCache[entry.id]} />
                    ) : null}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {activeTab === 'roadmap' && (
        <div className="grid grid-cols-1 gap-6 sm:grid-cols-3">
          {ROADMAP_COLUMNS.map(({ status, label, headerStyle, cardBorder }) => {
            const items = knownRoadmapItems.filter((i) => i.status === status)
            return (
              <section key={status} aria-label={label}>
                <div className={`mb-3 flex items-center justify-between rounded-md px-3 py-1.5 ${headerStyle}`}>
                  <h3 className="text-xs font-semibold uppercase tracking-wide">{label}</h3>
                  <span
                    className="rounded-full bg-white/60 px-1.5 py-0.5 text-xs font-medium"
                    aria-label={`${items.length} items`}
                  >
                    {items.length}
                  </span>
                </div>
                <div className="space-y-2">
                  {items.length === 0 && (
                    <p className="py-2 text-center text-xs text-gray-400">Nothing here yet.</p>
                  )}
                  {items.map((item) => (
                    <div key={item.id} className={`rounded-lg border border-gray-200 border-l-4 p-3 ${cardBorder}`}>
                      <p className="text-sm font-medium text-gray-900">{item.title}</p>
                      {item.description && (
                        <p className="mt-1 text-xs text-gray-500">{item.description}</p>
                      )}
                    </div>
                  ))}
                </div>
              </section>
            )
          })}
        </div>
      )}

      {activeTab === 'features' && (
        <FeaturesTab initialFeatures={features} projectKey={projectKey} />
      )}
    </div>
  )
}
