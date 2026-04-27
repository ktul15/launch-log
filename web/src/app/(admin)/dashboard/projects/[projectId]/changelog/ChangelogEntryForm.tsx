'use client'

import { useState, useRef } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { apiFetch } from '@/lib/api'
import RichTextEditor from '@/components/RichTextEditor'
import type { ChangelogEntry, TipTapDoc } from '@/types/changelog'

const EMPTY_DOC: TipTapDoc = { type: 'doc', content: [] }

interface NewProps {
  mode: 'new'
  projectId: string
}

interface EditProps {
  mode: 'edit'
  projectId: string
  entry: ChangelogEntry
}

type Props = NewProps | EditProps

function mapApiError(status: number, serverMessage: string): string {
  if (status === 401) return 'Session expired. Please log in again.'
  if (status === 403) return 'You do not have permission to perform this action.'
  if (status >= 500) return 'Server error. Please try again later.'
  return serverMessage || 'Something went wrong.'
}

export default function ChangelogEntryForm(props: Props) {
  const { mode, projectId } = props
  const entry = mode === 'edit' ? props.entry : undefined
  const router = useRouter()
  const submittingRef = useRef(false)

  const [title, setTitle] = useState(entry?.title ?? '')
  const [version, setVersion] = useState(entry?.version ?? '')
  const [content, setContent] = useState<TipTapDoc>(entry?.content ?? EMPTY_DOC)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()

    if (submittingRef.current) return

    if (!content.content || content.content.length === 0) {
      setError('Content is required.')
      return
    }

    submittingRef.current = true
    setLoading(true)
    setError(null)

    try {
      let res: Response

      if (mode === 'new') {
        const body: Record<string, unknown> = { title, content }
        if (version.trim()) body.version = version.trim()
        res = await apiFetch(`/api/v1/projects/${projectId}/changelog`, {
          method: 'POST',
          body: JSON.stringify(body),
        })
      } else {
        const body: Record<string, unknown> = {}
        if (title !== entry!.title) body.title = title
        if (version.trim() !== (entry!.version ?? '')) body.version = version.trim() || null
        body.content = content

        res = await apiFetch(`/api/v1/projects/${projectId}/changelog/${entry!.id}`, {
          method: 'PATCH',
          body: JSON.stringify(body),
        })
      }

      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        setError(mapApiError(res.status, data.message ?? ''))
        return
      }

      router.push(`/dashboard/projects/${projectId}/changelog`)
    } catch {
      setError('Something went wrong. Please try again.')
    } finally {
      setLoading(false)
      submittingRef.current = false
    }
  }

  return (
    <div className="p-8 max-w-3xl">
      <div className="mb-2">
        <Link
          href={`/dashboard/projects/${projectId}/changelog`}
          className="text-sm text-indigo-600 hover:text-indigo-800 transition-colors"
        >
          ← Changelog
        </Link>
      </div>

      <h1 className="text-2xl font-bold text-gray-900 mb-6">
        {mode === 'new' ? 'New entry' : 'Edit entry'}
      </h1>

      {error && (
        <div className="mb-4 px-4 py-3 bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg">
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-5">
        <div>
          <label htmlFor="title" className="block text-sm font-medium text-gray-700 mb-1">
            Title <span className="text-red-500">*</span>
          </label>
          <input
            id="title"
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            required
            maxLength={200}
            placeholder="What changed?"
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
          />
        </div>

        <div>
          <label htmlFor="version" className="block text-sm font-medium text-gray-700 mb-1">
            Version <span className="text-gray-400 font-normal">(optional)</span>
          </label>
          <input
            id="version"
            type="text"
            value={version}
            onChange={(e) => setVersion(e.target.value)}
            maxLength={50}
            placeholder="e.g. v1.2.0"
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Content <span className="text-red-500">*</span>
          </label>
          <RichTextEditor content={content} onChange={setContent} projectId={projectId} />
        </div>

        <div className="flex items-center gap-3 pt-2">
          <button
            type="submit"
            disabled={loading}
            className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50"
          >
            {loading ? 'Saving…' : 'Save draft'}
          </button>
          <Link
            href={`/dashboard/projects/${projectId}/changelog`}
            className="px-4 py-2 text-sm text-gray-600 hover:text-gray-900 transition-colors"
          >
            Cancel
          </Link>
        </div>
      </form>
    </div>
  )
}
