'use client'

import { useState, useRef } from 'react'
import Link from 'next/link'
import type { Project } from './page'
import ProjectFormModal from './ProjectFormModal'

type ModalState =
  | null
  | { mode: 'create' }
  | { mode: 'edit'; project: Project }

interface Props {
  initialProjects: Project[]
}

export default function ProjectsClient({ initialProjects }: Props) {
  const [projects, setProjects] = useState<Project[]>(initialProjects)
  const [modalState, setModalState] = useState<ModalState>(null)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const triggerRef = useRef<Element | null>(null)

  function openModal(state: ModalState) {
    triggerRef.current = document.activeElement
    setModalState(state)
  }

  function closeModal() {
    setModalState(null)
    // Restore focus to the element that triggered the modal after React re-renders.
    setTimeout(() => (triggerRef.current as HTMLElement | null)?.focus(), 0)
  }

  function handleSaved(saved: Project) {
    setProjects((prev) => {
      const idx = prev.findIndex((p) => p.id === saved.id)
      if (idx === -1) return [...prev, saved]
      const next = [...prev]
      next[idx] = { ...next[idx], ...saved }
      return next
    })
    closeModal()
  }

  function handleDeleted(id: string) {
    setProjects((prev) => prev.filter((p) => p.id !== id))
    closeModal()
  }

  async function copyWidgetKey(widgetKey: string, id: string) {
    try {
      await navigator.clipboard.writeText(widgetKey)
      setCopiedId(id)
      setTimeout(() => setCopiedId(null), 1500)
    } catch {
      // clipboard unavailable — silently ignore
    }
  }

  return (
    <div className="p-8">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Projects</h1>
        <button
          onClick={() => openModal({ mode: 'create' })}
          className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium rounded-lg transition-colors"
        >
          New project
        </button>
      </div>

      {projects.length === 0 ? (
        <div className="bg-white rounded-xl shadow-md p-12 text-center">
          <p className="text-gray-500 mb-4">No projects yet.</p>
          <button
            onClick={() => openModal({ mode: 'create' })}
            className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium rounded-lg transition-colors"
          >
            Create your first project
          </button>
        </div>
      ) : (
        <div className="bg-white rounded-xl shadow-md overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 bg-gray-50">
                <th scope="col" className="text-left px-5 py-3 font-medium text-gray-600">Name</th>
                <th scope="col" className="text-left px-5 py-3 font-medium text-gray-600">Slug</th>
                <th scope="col" className="text-left px-5 py-3 font-medium text-gray-600">Widget key</th>
                <th scope="col" className="text-right px-5 py-3 font-medium text-gray-600">Changelog</th>
                <th scope="col" className="text-right px-5 py-3 font-medium text-gray-600">Roadmap</th>
                <th scope="col" className="px-5 py-3" />
              </tr>
            </thead>
            <tbody>
              {projects.map((project) => (
                <tr key={project.id} className="border-b border-gray-50 last:border-0 hover:bg-gray-50/50 transition-colors">
                  <td className="px-5 py-4 font-medium text-gray-900">{project.name}</td>
                  <td className="px-5 py-4 font-mono text-gray-500">{project.slug}</td>
                  <td className="px-5 py-4">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-gray-400 text-xs">
                        {project.widgetKey.slice(0, 12)}…
                      </span>
                      <button
                        onClick={() => copyWidgetKey(project.widgetKey, project.id)}
                        className="text-xs text-indigo-600 hover:text-indigo-800 transition-colors"
                        aria-label={copiedId === project.id ? 'Widget key copied' : 'Copy widget key'}
                      >
                        {copiedId === project.id ? 'Copied!' : 'Copy'}
                      </button>
                    </div>
                  </td>
                  <td className="px-5 py-4 text-right text-gray-600 tabular-nums">
                    {project._count.changelogEntries}
                  </td>
                  <td className="px-5 py-4 text-right text-gray-600 tabular-nums">
                    {project._count.roadmapItems}
                  </td>
                  <td className="px-5 py-4 text-right">
                    <div className="flex items-center justify-end gap-4">
                      <Link
                        href={`/dashboard/projects/${project.id}/changelog`}
                        className="text-sm text-indigo-600 hover:text-indigo-800 font-medium transition-colors"
                      >
                        Changelog
                      </Link>
                      <Link
                        href={`/dashboard/projects/${project.id}/roadmap`}
                        className="text-sm text-indigo-600 hover:text-indigo-800 font-medium transition-colors"
                      >
                        Roadmap
                      </Link>
                      <button
                        onClick={() => openModal({ mode: 'edit', project })}
                        className="text-sm text-indigo-600 hover:text-indigo-800 font-medium transition-colors"
                      >
                        Edit
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {modalState && (
        <ProjectFormModal
          mode={modalState.mode}
          project={modalState.mode === 'edit' ? modalState.project : undefined}
          onClose={closeModal}
          onSaved={handleSaved}
          onDeleted={modalState.mode === 'edit' ? handleDeleted : undefined}
        />
      )}
    </div>
  )
}
