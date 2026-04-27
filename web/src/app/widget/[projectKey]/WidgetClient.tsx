'use client'

import { useState, useRef, useEffect } from 'react'
import RichTextViewer from '@/components/RichTextViewer'
import FeaturesTab from '@/components/FeaturesTab'
import SubscribeForm from '@/components/SubscribeForm'
import { apiFetch } from '@/lib/api'
import type { TipTapDoc } from '@/types/changelog'
import type { WidgetProject, PublicChangelogEntry, PublicFeature, PublicRoadmapItem } from '@/types/public'

type Tab = 'changelog' | 'roadmap' | 'features'

const TAB_LABELS: Record<Tab, string> = {
  changelog: 'Changelog',
  roadmap: 'Roadmap',
  features: 'Features',
}

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
const ALL_TABS: Tab[] = ['changelog', 'roadmap', 'features']

function formatDate(iso: string): string {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
}

interface Props {
  project: WidgetProject
  changelog: PublicChangelogEntry[]
  roadmap: PublicRoadmapItem[]
  features: PublicFeature[]
  projectKey: string
}

// Sentinel stored in contentCache when an entry loaded successfully but has no content.
const EMPTY_CONTENT = '__empty__' as const
type ContentCacheValue = TipTapDoc | typeof EMPTY_CONTENT

export default function WidgetClient({ project, changelog, roadmap, features, projectKey }: Props) {
  const ws = project.widgetSettings
  const TAB_ENABLED: Record<Tab, boolean> = {
    changelog: ws.showChangelog,
    roadmap: ws.showRoadmap,
    features: ws.showFeatures,
  }
  const TABS = ALL_TABS.filter((t) => TAB_ENABLED[t])

  const [activeTab, setActiveTab] = useState<Tab>(TABS[0] ?? 'changelog')
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [contentCache, setContentCache] = useState<Record<string, ContentCacheValue>>({})
  const [loadingIds, setLoadingIds] = useState<Set<string>>(new Set())
  // Per-entry error set — mirrors loadingIds pattern so concurrent expands don't clobber each other.
  const [errorIds, setErrorIds] = useState<Set<string>>(new Set())
  const abortRefs = useRef(new Map<string, AbortController>())

  const knownRoadmapItems = roadmap.filter((i) => KNOWN_ROADMAP_STATUSES.has(i.status))

  useEffect(() => {
    const refs = abortRefs.current
    return () => { refs.forEach((c) => c.abort()); refs.clear() }
  }, [])

  async function handleExpand(entryId: string) {
    if (expandedId === entryId) {
      setExpandedId(null)
      abortRefs.current.get(entryId)?.abort()
      abortRefs.current.delete(entryId)
      return
    }
    setExpandedId(entryId)
    setErrorIds((prev) => { const s = new Set(prev); s.delete(entryId); return s })
    if (contentCache[entryId]) return

    abortRefs.current.get(entryId)?.abort()
    const controller = new AbortController()
    abortRefs.current.set(entryId, controller)

    setLoadingIds((prev) => { const s = new Set(prev); s.add(entryId); return s })
    try {
      const res = await apiFetch(
        `/api/v1/public/${encodeURIComponent(projectKey)}/changelog/${encodeURIComponent(entryId)}`,
        { signal: controller.signal },
      )
      if (res.ok) {
        const data = await res.json()
        setContentCache((c) => ({
          ...c,
          // Store EMPTY_CONTENT sentinel when content is null so the cache entry exists
          // and we don't re-fetch, and can show an explicit "no content" message.
          [entryId]: data.content !== null && typeof data.content === 'object'
            ? data.content
            : EMPTY_CONTENT,
        }))
      } else {
        setErrorIds((prev) => { const s = new Set(prev); s.add(entryId); return s })
      }
    } catch (err) {
      if (err instanceof Error && err.name !== 'AbortError') {
        setErrorIds((prev) => { const s = new Set(prev); s.add(entryId); return s })
      }
    } finally {
      abortRefs.current.delete(entryId)
      setLoadingIds((prev) => { const s = new Set(prev); s.delete(entryId); return s })
    }
  }

  const panelId = (tab: Tab) => `widget-panel-${tab}`

  return (
    <div className="flex min-h-screen flex-col text-sm" style={{ backgroundColor: ws.backgroundColor }}>
      {/* Compact header */}
      <header className="border-b border-gray-200 px-3 py-3">
        <p className="text-xs font-medium uppercase tracking-wide text-gray-400">{project.orgName}</p>
        <h1 className="mt-0.5 text-base font-bold text-gray-900">{project.name}</h1>
        {project.description && (
          <p className="mt-0.5 text-xs text-gray-500">{project.description}</p>
        )}
      </header>

      {/* Tab nav — role="tablist" pattern for correct screen reader announcement */}
      <nav aria-label="Project sections">
        <div
          role="tablist"
          aria-label="Project sections"
          className="flex gap-1 overflow-x-auto border-b border-gray-200 px-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {TABS.map((t) => (
            <button
              key={t}
              role="tab"
              id={`widget-tab-${t}`}
              aria-selected={activeTab === t}
              aria-controls={panelId(t)}
              onClick={() => setActiveTab(t)}
              className={`flex-shrink-0 whitespace-nowrap px-3 py-2 text-xs font-medium transition-colors ${
                activeTab === t ? '' : 'text-gray-500 hover:text-gray-800'
              }`}
              style={
                activeTab === t
                  ? {
                      borderBottomWidth: 2,
                      borderBottomStyle: 'solid',
                      borderBottomColor: ws.primaryColor,
                      color: ws.primaryColor,
                    }
                  : undefined
              }
            >
              {TAB_LABELS[t]}
            </button>
          ))}
        </div>
      </nav>

      {/* Tab panels — only rendered for enabled tabs to avoid orphaned aria-labelledby refs */}
      <div className="flex-1 overflow-y-auto px-3 py-4">
        {TABS.length === 0 && (
          <p className="text-xs text-gray-400">No content available.</p>
        )}

        {ws.showChangelog && (
          <div
            role="tabpanel"
            id={panelId('changelog')}
            aria-labelledby="widget-tab-changelog"
            hidden={activeTab !== 'changelog'}
          >
            <div className="space-y-4">
              {changelog.length === 0 && (
                <p className="text-xs text-gray-500">No changelog entries yet.</p>
              )}
              {changelog.map((entry) => {
                const isExpanded = expandedId === entry.id
                const isLoading = loadingIds.has(entry.id)
                const isError = errorIds.has(entry.id)
                const cached = contentCache[entry.id]

                return (
                  <div key={entry.id} className="border-b border-gray-100 pb-4">
                    <button
                      className="w-full text-left"
                      onClick={() => handleExpand(entry.id)}
                      aria-expanded={isExpanded}
                      aria-controls={`changelog-content-${entry.id}`}
                    >
                      <div className="mb-1 flex flex-wrap items-center gap-1.5">
                        {entry.version && (
                          <span className="rounded bg-gray-100 px-1.5 py-0.5 text-xs font-mono text-gray-600">
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
                          {isExpanded ? '▾' : '▸'}
                        </span>
                      </div>
                      <h3 className="text-sm font-semibold text-gray-900">{entry.title}</h3>
                    </button>
                    <div
                      id={`changelog-content-${entry.id}`}
                      role="region"
                      aria-live="polite"
                      aria-busy={isLoading}
                    >
                      {isExpanded && (
                        <div className="mt-3">
                          {isLoading ? (
                            <>
                              <div className="min-h-[32px] animate-pulse rounded bg-gray-50" />
                              <span className="sr-only">Loading content…</span>
                            </>
                          ) : isError ? (
                            <p className="text-xs text-red-500">Failed to load. Try again.</p>
                          ) : cached === EMPTY_CONTENT ? (
                            <p className="text-xs text-gray-400">No content yet.</p>
                          ) : cached ? (
                            <RichTextViewer content={cached} />
                          ) : null}
                        </div>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {ws.showRoadmap && (
          <div
            role="tabpanel"
            id={panelId('roadmap')}
            aria-labelledby="widget-tab-roadmap"
            hidden={activeTab !== 'roadmap'}
          >
            <div className="space-y-4">
              {ROADMAP_COLUMNS.map(({ status, label, headerStyle, cardBorder }) => {
                const items = knownRoadmapItems.filter((i) => i.status === status)
                return (
                  <section key={status} aria-label={label}>
                    <div className={`mb-2 flex items-center justify-between rounded-md px-3 py-1.5 ${headerStyle}`}>
                      <h3 className="text-xs font-semibold uppercase tracking-wide">{label}</h3>
                      <span
                        className="rounded-full bg-white/60 px-1.5 py-0.5 text-xs font-medium"
                        aria-label={`${items.length} items`}
                      >
                        {items.length}
                      </span>
                    </div>
                    <div className="space-y-1.5">
                      {items.length === 0 && (
                        <p className="py-1 text-center text-xs text-gray-400">Nothing here yet.</p>
                      )}
                      {items.map((item) => (
                        <div key={item.id} className={`rounded-lg border border-gray-200 border-l-4 p-2.5 ${cardBorder}`}>
                          <p className="text-xs font-medium text-gray-900">{item.title}</p>
                          {item.description && (
                            <p className="mt-0.5 text-xs text-gray-500">{item.description}</p>
                          )}
                        </div>
                      ))}
                    </div>
                  </section>
                )
              })}
            </div>
          </div>
        )}

        {ws.showFeatures && (
          <div
            role="tabpanel"
            id={panelId('features')}
            aria-labelledby="widget-tab-features"
            hidden={activeTab !== 'features'}
          >
            <FeaturesTab initialFeatures={features} projectKey={projectKey} />
          </div>
        )}

        <div className="mt-8 border-t border-gray-200 pt-6">
          <SubscribeForm projectKey={projectKey} />
        </div>
      </div>

      {/* Free-tier footer */}
      {project.plan === 'free' && (
        <footer className="border-t border-gray-100 px-3 py-2 text-center">
          <a
            href="https://launchlog.app"
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-gray-400 hover:text-gray-600"
          >
            Powered by LaunchLog
          </a>
        </footer>
      )}
    </div>
  )
}
