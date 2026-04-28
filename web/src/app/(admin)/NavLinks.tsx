'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

const links = [
  { label: 'Projects', href: '/dashboard/projects' },
  { label: 'Billing',  href: '/dashboard/billing'  },
]

export default function NavLinks() {
  const pathname = usePathname()

  return (
    <>
      {links.map(({ label, href }) => {
        const active = pathname.startsWith(href)
        return (
          <Link
            key={href}
            href={href}
            className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
              active
                ? 'bg-indigo-50 text-indigo-700'
                : 'text-gray-700 hover:bg-indigo-50 hover:text-indigo-700'
            }`}
          >
            {label}
          </Link>
        )
      })}
    </>
  )
}
