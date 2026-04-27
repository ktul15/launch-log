'use client'

import { useState } from 'react'
import Link from 'next/link'
import { apiFetch } from '@/lib/api'
import type { ChangelogEntry } from '@/types/changelog'

export type { ChangelogEntry }

interface Props {
  projectId: string
  projectName: string
  initialEntries: ChangelogEntry[]
}

const STATUS_BADGE: Record<string, string> = {
  draft: 'bg-gray-100 text-gray-600',
  published: 'bg-green-100 text-green-700',
  archived: 'bg-amber-100 text-amber-700',
}

function statusBadgeClass(status: string): string {
  return STATUS_BADGE[status] ?? 'bg-gray-100 text-gray-600'
}

function formatDate(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
}

export default function ChangelogClient({ projectId, projectName, initialEntries }: Props) {
  const [entries, setEntries] = useState<ChangelogEntry[]>(initialEntries)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [loadingIds, setLoadingIds] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)

  function startLoading(id: string) {
    setLoadingIds((prev) => new Set(prev).add(id))
  }

  function stopLoading(id: string) {
    setLoadingIds((prev) => {
      const next = new Set(prev)
      next.delete(id)
      return next
    })
  }

  async function handlePublish(entryId: string) {
    startLoading(entryId)
    setConfirmDeleteId(null)
    setError(null)
    try {
      const res = await apiFetch(`/api/v1/projects/${projectId}/changelog/${entryId}/publish`, {
        method: 'POST',
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        setError(body.message ?? 'Failed to publish entry.')
        return
      }
      const updated: ChangelogEntry = await res.json()
      setEntries((prev) => prev.map((e) => (e.id === entryId ? { ...e, ...updated } : e)))
    } catch {
      setError('Something went wrong. Please try again.')
    } finally {
      stopLoading(entryId)
    }
  }

  async function handleUnpublish(entryId: string) {
    startLoading(entryId)
    setConfirmDeleteId(null)
    setError(null)
    try {
      const res = await apiFetch(`/api/v1/projects/${projectId}/changelog/${entryId}/unpublish`, {
        method: 'POST',
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        setError(body.message ?? 'Failed to unpublish entry.')
        return
      }
      const updated: ChangelogEntry = await res.json()
      setEntries((prev) => prev.map((e) => (e.id === entryId ? { ...e, ...updated } : e)))
    } catch {
      setError('Something went wrong. Please try again.')
    } finally {
      stopLoading(entryId)
    }
  }

  async function handleDelete(entryId: string) {
    if (confirmDeleteId !== entryId) {
      setConfirmDeleteId(entryId)
      return
    }
    startLoading(entryId)
    setError(null)
    try {
      const res = await apiFetch(`/api/v1/projects/${projectId}/changelog/${entryId}`, {
        method: 'DELETE',
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        setError(body.message ?? 'Failed to delete entry.')
        setConfirmDeleteId(null)
        return
      }
      setEntries((prev) => prev.filter((e) => e.id !== entryId))
      setConfirmDeleteId(null)
    } catch {
      setError('Something went wrong. Please try again.')
      setConfirmDeleteId(null)
    } finally {
      stopLoading(entryId)
    }
  }

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
          <h1 className="text-2xl font-bold text-gray-900">Changelog</h1>
          <p className="text-sm text-gray-500 mt-0.5">{projectName}</p>
        </div>
        <Link
          href={`/dashboard/projects/${projectId}/changelog/new`}
          className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium rounded-lg transition-colors"
        >
          New entry
        </Link>
      </div>

      {error && (
        <div className="mb-4 px-4 py-3 bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg">
          {error}
        </div>
      )}

      {entries.length === 0 ? (
        <div className="bg-white rounded-xl shadow-md p-12 text-center">
          <p className="text-gray-500">No changelog entries yet.</p>
        </div>
      ) : (
        <div className="bg-white rounded-xl shadow-md overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 bg-gray-50">
                <th scope="col" className="text-left px-5 py-3 font-medium text-gray-600">Title</th>
                <th scope="col" className="text-left px-5 py-3 font-medium text-gray-600">Version</th>
                <th scope="col" className="text-left px-5 py-3 font-medium text-gray-600">Status</th>
                <th scope="col" className="text-left px-5 py-3 font-medium text-gray-600">Published</th>
                <th scope="col" className="px-5 py-3" aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => {
                const isLoading = loadingIds.has(entry.id)
                const isConfirming = confirmDeleteId === entry.id
                const isArchived = entry.status === 'archived'
                return (
                  <tr key={entry.id} className="border-b border-gray-50 last:border-0 hover:bg-gray-50/50 transition-colors">
                    <td className="px-5 py-4 font-medium text-gray-900 max-w-xs truncate">
                      {entry.title}
                    </td>
                    <td className="px-5 py-4">
                      {entry.version
                        ? <span className="inline-flex max-w-[10rem] truncate px-2 py-0.5 rounded-full text-xs font-medium font-mono bg-indigo-50 text-indigo-700" title={entry.version}>{entry.version}</span>
                        : <span className="text-gray-400">—</span>}
                    </td>
                    <td className="px-5 py-4">
                      <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${statusBadgeClass(entry.status)}`}>
                        {entry.status}
                      </span>
                    </td>
                    <td className="px-5 py-4 text-gray-500">
                      {formatDate(entry.publishedAt)}
                    </td>
                    <td className="px-5 py-4">
                      <div className="flex items-center justify-end gap-3">
                        {entry.status === 'draft' && (
                          <button
                            onClick={() => handlePublish(entry.id)}
                            disabled={isLoading}
                            className="text-sm text-green-700 hover:text-green-900 font-medium transition-colors disabled:opacity-50"
                          >
                            {isLoading ? 'Publishing…' : 'Publish'}
                          </button>
                        )}
                        {entry.status === 'published' && (
                          <button
                            onClick={() => handleUnpublish(entry.id)}
                            disabled={isLoading}
                            className="text-sm text-amber-700 hover:text-amber-900 font-medium transition-colors disabled:opacity-50"
                          >
                            {isLoading ? 'Unpublishing…' : 'Unpublish'}
                          </button>
                        )}
                        {isArchived ? (
                          <span
                            className="text-sm text-gray-400 font-medium cursor-not-allowed"
                            title="Archived entries cannot be edited"
                          >
                            Edit
                          </span>
                        ) : (
                          <Link
                            href={`/dashboard/projects/${projectId}/changelog/${entry.id}/edit`}
                            className="text-sm text-indigo-600 hover:text-indigo-800 font-medium transition-colors"
                          >
                            Edit
                          </Link>
                        )}
                        {isConfirming ? (
                          <span className="flex items-center gap-2">
                            <button
                              onClick={() => handleDelete(entry.id)}
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
                          </span>
                        ) : (
                          <button
                            onClick={() => handleDelete(entry.id)}
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
