'use client'

import { useState, useMemo } from 'react'
import Link from 'next/link'
import { apiFetch } from '@/lib/api'
import type { FeatureRequest, FeatureStatus } from '@/types/feature'

interface Props {
  projectId: string
  projectName: string
  initialFeatures: FeatureRequest[]
}

const FEATURE_STATUSES: FeatureStatus[] = ['open', 'planned', 'in_progress', 'shipped', 'closed']

const STATUS_BADGE: Record<FeatureStatus, string> = {
  open: 'bg-blue-50 text-blue-700',
  planned: 'bg-indigo-50 text-indigo-700',
  in_progress: 'bg-amber-50 text-amber-700',
  shipped: 'bg-green-50 text-green-700',
  closed: 'bg-gray-100 text-gray-500',
}

const STATUS_LABEL: Record<FeatureStatus, string> = {
  open: 'Open',
  planned: 'Planned',
  in_progress: 'In Progress',
  shipped: 'Shipped',
  closed: 'Closed',
}

type SortKey = 'votes' | 'date'
type SortDir = 'asc' | 'desc'

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
}

function SortIcon({ col, sortKey, sortDir }: { col: SortKey; sortKey: SortKey; sortDir: SortDir }) {
  if (sortKey !== col) return <span className="ml-1 text-gray-300">↕</span>
  return <span className="ml-1 text-indigo-500">{sortDir === 'desc' ? '↓' : '↑'}</span>
}

export default function FeaturesClient({ projectId, projectName, initialFeatures }: Props) {
  const [features, setFeatures] = useState<FeatureRequest[]>(initialFeatures)
  const [sortKey, setSortKey] = useState<SortKey>('date')
  const [sortDir, setSortDir] = useState<SortDir>('desc')
  const [statusFilter, setStatusFilter] = useState<FeatureStatus | 'all'>('all')
  const [loadingIds, setLoadingIds] = useState<Set<string>>(new Set())
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  function addLoading(id: string) {
    setLoadingIds((prev) => new Set(prev).add(id))
  }

  function removeLoading(id: string) {
    setLoadingIds((prev) => { const n = new Set(prev); n.delete(id); return n })
  }

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDir('desc')
    }
  }

  async function handleStatusChange(featureId: string, newStatus: FeatureStatus, featureTitle: string) {
    addLoading(featureId)
    setError(null)
    try {
      const res = await apiFetch(`/api/v1/projects/${projectId}/features/${featureId}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: newStatus }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        setError((body as { message?: string }).message ?? `Failed to update status for "${featureTitle}".`)
        return
      }
      const updated: FeatureRequest = await res.json()
      setFeatures((prev) => prev.map((f) => (f.id === featureId ? updated : f)))
    } catch {
      setError(`Network error. Status not updated for "${featureTitle}".`)
    } finally {
      removeLoading(featureId)
    }
  }

  async function handleDelete(featureId: string) {
    if (loadingIds.has(featureId)) return
    addLoading(featureId)
    setError(null)
    try {
      const res = await apiFetch(`/api/v1/projects/${projectId}/features/${featureId}`, {
        method: 'DELETE',
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        setError((body as { message?: string }).message ?? 'Failed to delete feature request.')
        setConfirmDeleteId(null)
        return
      }
      setFeatures((prev) => prev.filter((f) => f.id !== featureId))
      setConfirmDeleteId(null)
    } catch {
      setError('Something went wrong. Please try again.')
      setConfirmDeleteId(null)
    } finally {
      removeLoading(featureId)
    }
  }

  const displayed = useMemo(() => {
    let list = statusFilter === 'all' ? features : features.filter((f) => f.status === statusFilter)
    list = [...list].sort((a, b) => {
      if (sortKey === 'votes') {
        return sortDir === 'desc' ? b.voteCount - a.voteCount : a.voteCount - b.voteCount
      }
      const diff = Date.parse(a.createdAt) - Date.parse(b.createdAt)
      return sortDir === 'desc' ? -diff : diff
    })
    return list
  }, [features, sortKey, sortDir, statusFilter])

  return (
    <div className="p-8">
      <div className="mb-2">
        <Link
          href="/dashboard/projects"
          className="text-sm text-indigo-600 hover:text-indigo-800 transition-colors"
        >
          ← Projects
        </Link>
      </div>

      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Feature Requests</h1>
          <p className="text-sm text-gray-500 mt-0.5">{projectName}</p>
        </div>
        <div className="flex items-center gap-3">
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as FeatureStatus | 'all')}
            aria-label="Filter by status"
            className="text-sm px-3 py-2 rounded-lg border border-gray-200 bg-white text-gray-700 focus:outline-none focus:border-indigo-300"
          >
            <option value="all">All statuses</option>
            {FEATURE_STATUSES.map((s) => (
              <option key={s} value={s}>{STATUS_LABEL[s]}</option>
            ))}
          </select>
        </div>
      </div>

      {error && (
        <div className="mb-4 px-4 py-3 bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg flex items-center justify-between">
          <span>{error}</span>
          <button
            onClick={() => setError(null)}
            aria-label="Dismiss error"
            className="ml-3 text-red-400 hover:text-red-600 transition-colors"
          >
            ✕
          </button>
        </div>
      )}

      {displayed.length === 0 ? (
        <div className="bg-white rounded-xl shadow-md p-12 text-center">
          <p className="text-gray-500">
            {statusFilter === 'all' ? 'No feature requests yet.' : `No ${STATUS_LABEL[statusFilter as FeatureStatus]} requests.`}
          </p>
        </div>
      ) : (
        <div className="bg-white rounded-xl shadow-md overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 bg-gray-50">
                <th scope="col" className="text-left px-5 py-3 font-medium text-gray-600">Title</th>
                <th scope="col" className="text-left px-5 py-3 font-medium text-gray-600">
                  <button
                    onClick={() => toggleSort('votes')}
                    className="flex items-center hover:text-indigo-600 transition-colors"
                  >
                    Votes<SortIcon col="votes" sortKey={sortKey} sortDir={sortDir} />
                  </button>
                </th>
                <th scope="col" className="text-left px-5 py-3 font-medium text-gray-600">Status</th>
                <th scope="col" className="text-left px-5 py-3 font-medium text-gray-600">Submitter</th>
                <th scope="col" className="text-left px-5 py-3 font-medium text-gray-600">
                  <button
                    onClick={() => toggleSort('date')}
                    className="flex items-center hover:text-indigo-600 transition-colors"
                  >
                    Date<SortIcon col="date" sortKey={sortKey} sortDir={sortDir} />
                  </button>
                </th>
                <th scope="col" className="px-5 py-3" aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {displayed.map((feature) => {
                const isLoading = loadingIds.has(feature.id)
                const isConfirming = confirmDeleteId === feature.id
                return (
                  <tr
                    key={feature.id}
                    className="border-b border-gray-50 last:border-0 hover:bg-gray-50/50 transition-colors"
                  >
                    <td className="px-5 py-4 font-medium text-gray-900 max-w-xs">
                      <div className="truncate" title={feature.title}>{feature.title}</div>
                      {feature.description && (
                        <div className="text-xs text-gray-400 truncate mt-0.5" title={feature.description}>
                          {feature.description}
                        </div>
                      )}
                    </td>
                    <td className="px-5 py-4 text-gray-700 font-medium tabular-nums">
                      {feature.voteCount}
                    </td>
                    <td className="px-5 py-4">
                      <select
                        value={feature.status}
                        onChange={(e) => {
                          const s = e.target.value as FeatureStatus
                          if (FEATURE_STATUSES.includes(s)) handleStatusChange(feature.id, s, feature.title)
                        }}
                        disabled={isLoading}
                        aria-label={`Status for ${feature.title}`}
                        className={`text-xs px-2 py-1 rounded-full border-0 font-medium cursor-pointer disabled:opacity-50 focus:outline-none focus:ring-1 focus:ring-indigo-300 ${STATUS_BADGE[feature.status]}`}
                      >
                        {FEATURE_STATUSES.map((s) => (
                          <option key={s} value={s}>{STATUS_LABEL[s]}</option>
                        ))}
                      </select>
                    </td>
                    <td className="px-5 py-4 text-gray-500 max-w-[12rem]">
                      {feature.submitterEmail
                        ? <span className="truncate block" title={feature.submitterEmail}>{feature.submitterEmail}</span>
                        : <span className="text-gray-300">—</span>}
                    </td>
                    <td className="px-5 py-4 text-gray-500 whitespace-nowrap">
                      {formatDate(feature.createdAt)}
                    </td>
                    <td className="px-5 py-4">
                      <div className="flex items-center justify-end gap-3">
                        {isConfirming ? (
                          <>
                            <button
                              onClick={() => handleDelete(feature.id)}
                              disabled={isLoading}
                              className="text-sm text-red-600 hover:text-red-800 font-medium transition-colors disabled:opacity-50"
                            >
                              {isLoading ? 'Deleting…' : 'Confirm'}
                            </button>
                            <button
                              onClick={() => setConfirmDeleteId(null)}
                              className="text-sm text-gray-500 hover:text-gray-700 transition-colors"
                            >
                              Cancel
                            </button>
                          </>
                        ) : (
                          <button
                            onClick={() => setConfirmDeleteId(feature.id)}
                            disabled={isLoading}
                            className="text-sm text-red-600 hover:text-red-800 font-medium transition-colors disabled:opacity-50"
                          >
                            Delete
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
