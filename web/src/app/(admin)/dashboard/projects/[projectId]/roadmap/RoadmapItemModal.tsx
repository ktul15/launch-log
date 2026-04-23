'use client'

import { useState, useEffect, useRef } from 'react'
import { apiFetch } from '@/lib/api'
import type { RoadmapItem, RoadmapStatus } from '@/types/roadmap'

type BaseProps = {
  projectId: string
  onSave: (item: RoadmapItem) => void
  onClose: () => void
}

type CreateProps = BaseProps & { mode: 'create'; initialStatus?: RoadmapStatus; item?: never }
type EditProps = BaseProps & { mode: 'edit'; item: RoadmapItem; initialStatus?: never }
type Props = CreateProps | EditProps

const TITLE_ID = 'roadmap-modal-title'
const DESC_ID = 'roadmap-modal-desc'
const STATUS_ID = 'roadmap-modal-status'

export default function RoadmapItemModal({ projectId, mode, initialStatus = 'planned', item, onSave, onClose }: Props) {
  const [title, setTitle] = useState(item?.title ?? '')
  const [description, setDescription] = useState(item?.description ?? '')
  const [status, setStatus] = useState<RoadmapStatus>(item?.status ?? initialStatus)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const titleRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    titleRef.current?.focus()
  }, [])

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  function trapFocus(e: React.KeyboardEvent) {
    if (e.key !== 'Tab') return
    const focusable = Array.from(
      e.currentTarget.querySelectorAll<HTMLElement>('input, textarea, select, button:not([disabled])'),
    )
    if (!focusable.length) return
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (e.shiftKey) {
      if (document.activeElement === first) { e.preventDefault(); last.focus() }
    } else {
      if (document.activeElement === last) { e.preventDefault(); first.focus() }
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setLoading(true)
    try {
      const body: Record<string, unknown> = {
        title,
        status,
        description: description.trim() || null,
      }

      const res = mode === 'create'
        ? await apiFetch(`/api/v1/projects/${projectId}/roadmap`, {
            method: 'POST',
            body: JSON.stringify(body),
          })
        : await apiFetch(`/api/v1/projects/${projectId}/roadmap/${item.id}`, {
            method: 'PATCH',
            body: JSON.stringify(body),
          })

      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        setError((data as { message?: string }).message ?? 'Failed to save item.')
        return
      }

      const saved = await res.json() as RoadmapItem
      onSave(saved)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="roadmap-modal-heading"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-xl shadow-xl w-full max-w-md mx-4 p-6"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={trapFocus}
      >
        <h2 id="roadmap-modal-heading" className="text-lg font-semibold text-gray-900 mb-4">
          {mode === 'create' ? 'New roadmap item' : 'Edit roadmap item'}
        </h2>

        {error && (
          <p className="mb-4 text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</p>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor={TITLE_ID} className="block text-sm font-medium text-gray-700 mb-1">Title</label>
            <input
              id={TITLE_ID}
              ref={titleRef}
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={200}
              required
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
              placeholder="What are you building?"
            />
          </div>

          <div>
            <label htmlFor={DESC_ID} className="block text-sm font-medium text-gray-700 mb-1">Description</label>
            <textarea
              id={DESC_ID}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={1000}
              rows={3}
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-none"
              placeholder="Optional details…"
            />
          </div>

          <div>
            <label htmlFor={STATUS_ID} className="block text-sm font-medium text-gray-700 mb-1">Status</label>
            <select
              id={STATUS_ID}
              value={status}
              onChange={(e) => setStatus(e.target.value as RoadmapStatus)}
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            >
              <option value="planned">Planned</option>
              <option value="in_progress">In Progress</option>
              <option value="shipped">Shipped</option>
            </select>
          </div>

          <div className="flex justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm text-gray-600 hover:text-gray-800 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading || !title.trim()}
              className="px-4 py-2 text-sm font-medium bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50 transition-colors"
            >
              {loading ? 'Saving…' : mode === 'create' ? 'Create' : 'Save'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
