'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

const PROJECT_NAV = [
  { label: 'Changelog', path: 'changelog' },
  { label: 'Roadmap', path: 'roadmap' },
  { label: 'Features', path: 'features' },
  { label: 'Settings', path: 'settings' },
]

export default function ProjectNav({ projectId }: { projectId: string }) {
  const pathname = usePathname()

  return (
    <nav className="flex-1 px-2 space-y-0.5">
      {PROJECT_NAV.map(({ label, path }) => {
        const href = `/dashboard/projects/${projectId}/${path}`
        const active = pathname === href || pathname.startsWith(`${href}/`)
        return (
          <Link
            key={path}
            href={href}
            aria-current={active ? 'page' : undefined}
            className={`flex items-center px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
              active
                ? 'bg-indigo-50 text-indigo-700'
                : 'text-gray-700 hover:bg-indigo-50 hover:text-indigo-700'
            }`}
          >
            {label}
          </Link>
        )
      })}
    </nav>
  )
}
