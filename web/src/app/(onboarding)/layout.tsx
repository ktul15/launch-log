import type { ReactNode } from 'react'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'

// Require at least 8 chars per segment to reject obvious garbage (a.b.c, _._._ etc.)
// while accepting real JWTs (header and payload are typically 36+ chars each).
// This is a structural sanity check, not signature verification — the backend validates auth.
const jwtShape = /^[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}$/

export default function OnboardingLayout({ children }: { children: ReactNode }) {
  const token = cookies().get('access_token')?.value
  if (!token || !jwtShape.test(token)) redirect('/login')
  return <>{children}</>
}
