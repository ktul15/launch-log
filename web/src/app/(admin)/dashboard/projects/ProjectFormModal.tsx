'use client'

import { useRef, useEffect, useState } from 'react'
import { apiFetch } from '@/lib/api'
import { toClientSlug } from '@/lib/slug'
import type { Project } from './page'

interface Props {
  mode: 'create' | 'edit'
  project?: Project
  onClose: () => void
  onSaved: (project: Project) => void
  onDeleted?: (id: string) => void
}

export default function ProjectFormModal({ mode, project, onClose, onSaved, onDeleted }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null)

  const [name, setName] = useState(project?.name ?? '')
  const [slug, setSlug] = useState(project?.slug ?? '')
  const [description, setDescription] = useState(project?.description ?? '')
  const [slugEdited, setSlugEdited] = useState(mode === 'edit')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [deleteConfirm, setDeleteConfirm] = useState(false)

  useEffect(() => {
    dialogRef.current?.showModal()
  }, [])

  function handleNameChange(value: string) {
    setName(value)
    if (!slugEdited) setSlug(toClientSlug(value))
  }

  function handleSlugChange(value: string) {
    setSlug(value)
    setSlugEdited(true)
  }

  function closeDialog() {
    dialogRef.current?.close()
    onClose()
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)

    if (mode === 'edit' && project) {
      const delta: Record<string, string | null> = {}
      if (name !== project.name) delta.name = name
      if (slug !== project.slug) delta.slug = slug
      const existingDesc = project.description ?? ''
      if (description !== existingDesc) delta.description = description || null

      if (Object.keys(delta).length === 0) {
        closeDialog()
        return
      }

      setLoading(true)
      try {
        const res = await apiFetch(`/api/v1/projects/${project.id}`, {
          method: 'PATCH',
          body: JSON.stringify(delta),
        })
        if (res.ok) {
          const updated = await res.json()
          onSaved({ ...project, ...updated })
          closeDialog()
        } else {
          const body = await res.json().catch(() => ({}))
          setError(mapError(res.status, body.message))
        }
      } catch {
        setError('Unable to connect. Please try again.')
      } finally {
        setLoading(false)
      }
      return
    }

    // create mode
    setLoading(true)
    try {
      const res = await apiFetch('/api/v1/projects', {
        method: 'POST',
        body: JSON.stringify({ name, slug: slug || undefined }),
      })
      if (res.ok) {
        const created = await res.json()
        // Inject default _count — POST response does not include it.
        onSaved({ ...created, _count: created._count ?? { changelogEntries: 0, roadmapItems: 0 } })
        closeDialog()
      } else {
        const body = await res.json().catch(() => ({}))
        setError(mapError(res.status, body.message))
      }
    } catch {
      setError('Unable to connect. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  async function handleDelete() {
    if (!project || !onDeleted) return
    if (!deleteConfirm) {
      setDeleteConfirm(true)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const res = await apiFetch(`/api/v1/projects/${project.id}`, { method: 'DELETE' })
      if (res.status === 204) {
        onDeleted(project.id)
        closeDialog()
      } else {
        const body = await res.json().catch(() => ({}))
        setError(body.message ?? 'Failed to delete project.')
      }
    } catch {
      setError('Unable to connect. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <dialog
      ref={dialogRef}
      onCancel={onClose}
      className="w-full max-w-md rounded-xl shadow-2xl p-0 backdrop:bg-black/50 backdrop:backdrop-blur-sm"
    >
      <form onSubmit={handleSubmit} className="p-6 space-y-5">
        <h2 className="text-lg font-semibold text-gray-900">
          {mode === 'create' ? 'New project' : 'Edit project'}
        </h2>

        {error && (
          <p role="alert" className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
            {error}
          </p>
        )}

        <div className="space-y-1">
          <label htmlFor="proj-name" className="block text-sm font-medium text-gray-700">
            Name
          </label>
          <input
            id="proj-name"
            type="text"
            value={name}
            onChange={(e) => handleNameChange(e.target.value)}
            required
            minLength={2}
            maxLength={200}
            placeholder="My Awesome Project"
            className="w-full border border-gray-300 rounded-lg px-4 py-2 text-sm focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none"
          />
        </div>

        <div className="space-y-1">
          <label htmlFor="proj-slug" className="block text-sm font-medium text-gray-700">
            Slug
          </label>
          <input
            id="proj-slug"
            type="text"
            value={slug}
            onChange={(e) => handleSlugChange(e.target.value)}
            required
            minLength={2}
            maxLength={100}
            placeholder="my-awesome-project"
            className="w-full border border-gray-300 rounded-lg px-4 py-2 text-sm font-mono focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none"
          />
        </div>

        {mode === 'edit' && (
          <div className="space-y-1">
            <label htmlFor="proj-desc" className="block text-sm font-medium text-gray-700">
              Description <span className="text-gray-400 font-normal">(optional)</span>
            </label>
            <textarea
              id="proj-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={500}
              rows={3}
              placeholder="What is this project about?"
              className="w-full border border-gray-300 rounded-lg px-4 py-2 text-sm focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none resize-none"
            />
          </div>
        )}

        <div className="flex items-center justify-between pt-2">
          {mode === 'edit' && onDeleted ? (
            <div className="flex items-center gap-2">
              {deleteConfirm ? (
                <>
                  <button
                    type="button"
                    onClick={handleDelete}
                    disabled={loading}
                    className="px-4 py-2 rounded-lg text-sm font-medium bg-red-600 hover:bg-red-700 text-white transition-colors disabled:opacity-50"
                  >
                    Confirm delete
                  </button>
                  <button
                    type="button"
                    onClick={() => setDeleteConfirm(false)}
                    disabled={loading}
                    className="px-3 py-2 rounded-lg text-sm font-medium text-gray-600 hover:bg-gray-100 transition-colors disabled:opacity-50"
                  >
                    Keep
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={handleDelete}
                  disabled={loading}
                  className="px-4 py-2 rounded-lg text-sm font-medium text-red-600 hover:bg-red-50 border border-red-200 transition-colors disabled:opacity-50"
                >
                  Delete
                </button>
              )}
            </div>
          ) : (
            <span />
          )}

          <div className="flex gap-2">
            <button
              type="button"
              onClick={closeDialog}
              disabled={loading}
              className="px-4 py-2 rounded-lg text-sm font-medium text-gray-700 hover:bg-gray-100 transition-colors disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading || !name.trim() || !slug.trim()}
              className="px-4 py-2 rounded-lg text-sm font-medium bg-indigo-600 hover:bg-indigo-700 text-white transition-colors disabled:opacity-50"
            >
              {loading ? 'Saving…' : mode === 'create' ? 'Create' : 'Save'}
            </button>
          </div>
        </div>
      </form>
    </dialog>
  )
}

function mapError(status: number, message?: string): string {
  if (status === 409) return 'A project with this slug already exists.'
  if (status === 403) {
    if (message?.includes('limit')) return 'Project limit reached for your plan.'
    return 'You do not have permission to perform this action.'
  }
  if (status === 422 && message) return message
  return 'Something went wrong. Please try again.'
}
