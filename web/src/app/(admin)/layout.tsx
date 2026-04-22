import type { ReactNode } from 'react'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'

export default function AdminLayout({ children }: { children: ReactNode }) {
  if (!cookies().has('access_token')) redirect('/login')
  return <>{children}</>
}
