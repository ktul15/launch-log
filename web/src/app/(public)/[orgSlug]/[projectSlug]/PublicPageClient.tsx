import Link from 'next/link'
import type { PublicChangelogEntry, PublicFeature, PublicRoadmapItem } from '@/types/public'

export type Tab = 'changelog' | 'roadmap' | 'features'

const TAB_LABELS: Record<Tab, string> = {
  changelog: 'Changelog',
  roadmap: 'Roadmap',
  features: 'Features',
}

const STATUS_LABELS: Record<string, string> = {
  open: 'Open',
  planned: 'Planned',
  in_progress: 'In Progress',
  shipped: 'Shipped',
  closed: 'Closed',
}

const ROADMAP_COLUMNS: { status: PublicRoadmapItem['status']; label: string }[] = [
  { status: 'planned', label: STATUS_LABELS.planned },
  { status: 'in_progress', label: STATUS_LABELS.in_progress },
  { status: 'shipped', label: STATUS_LABELS.shipped },
]

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
}

export default function PublicPageClient({ changelog, roadmap, features, activeTab }: Props) {
  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <nav role="tablist" aria-label="Project sections" className="mb-8 flex gap-1 border-b border-gray-200">
        {TABS.map((t) => (
          <Link
            key={t}
            href={`?tab=${t}`}
            role="tab"
            aria-selected={activeTab === t}
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
              </div>
              <h3 className="text-base font-semibold text-gray-900">{entry.title}</h3>
            </div>
          ))}
        </div>
      )}

      {activeTab === 'roadmap' && (
        <div className="grid grid-cols-1 gap-6 sm:grid-cols-3">
          {ROADMAP_COLUMNS.map(({ status, label }) => {
            const items = roadmap.filter((i) => i.status === status)
            return (
              <div key={status}>
                <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-500">
                  {label}
                </h3>
                {items.length === 0 && (
                  <p className="text-xs text-gray-400">Nothing here yet.</p>
                )}
                <div className="space-y-2">
                  {items.map((item) => (
                    <div key={item.id} className="rounded-lg border border-gray-200 p-3">
                      <p className="text-sm font-medium text-gray-900">{item.title}</p>
                      {item.description && (
                        <p className="mt-1 text-xs text-gray-500">{item.description}</p>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {activeTab === 'features' && (
        <div className="space-y-3">
          {features.length === 0 && (
            <p className="text-sm text-gray-500">No feature requests yet.</p>
          )}
          {features.map((f) => (
            <div key={f.id} className="flex items-start gap-4 rounded-lg border border-gray-200 p-4">
              <div className="flex min-w-[3rem] flex-col items-center rounded-md bg-gray-50 px-3 py-2">
                <span className="text-lg font-bold text-gray-900">{f.voteCount}</span>
                <span className="text-xs text-gray-400">votes</span>
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="text-sm font-semibold text-gray-900">{f.title}</h3>
                {f.description && (
                  <p className="mt-1 text-xs text-gray-500 line-clamp-2">{f.description}</p>
                )}
                <span className="mt-2 inline-block rounded-full bg-blue-50 px-2 py-0.5 text-xs text-blue-700">
                  {STATUS_LABELS[f.status] ?? f.status}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
