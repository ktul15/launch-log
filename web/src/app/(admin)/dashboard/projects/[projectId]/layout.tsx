import type { ReactNode } from 'react'
import Link from 'next/link'
import ProjectNav from './ProjectNav'

interface Props {
  children: ReactNode
  params: { projectId: string }
}

export default function ProjectLayout({ children, params }: Props) {
  const { projectId } = params
  return (
    <div className="flex min-h-full">
      <aside className="w-44 shrink-0 border-r border-gray-200 bg-white flex flex-col pt-4">
        <Link
          href="/dashboard/projects"
          className="mx-3 mb-4 text-xs text-indigo-600 hover:text-indigo-800 transition-colors"
        >
          ← All projects
        </Link>
        <ProjectNav projectId={projectId} />
      </aside>
      <div className="flex-1 overflow-auto">{children}</div>
    </div>
  )
}
