import type { ReactNode } from 'react'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'

export default function AdminLayout({ children }: { children: ReactNode }) {
  const token = cookies().get('access_token')
  if (!token) redirect('/login')
  return <>{children}</>
}
