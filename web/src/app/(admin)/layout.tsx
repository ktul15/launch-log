import type { ReactNode } from 'react'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'

const BACKEND = process.env.BACKEND_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001'
// JWT must have three base64url segments — validate before interpolating into Cookie header.
const jwtShape = /^[\w-]+\.[\w-]+\.[\w-]+$/

export default async function AdminLayout({ children }: { children: ReactNode }) {
  const cookieStore = cookies()
  const accessToken = cookieStore.get('access_token')?.value
  if (!accessToken || !jwtShape.test(accessToken)) redirect('/login')

  // Only forward refresh_token if it also passes the shape check to prevent header injection.
  const refreshToken = cookieStore.get('refresh_token')?.value
  const validRefreshToken = refreshToken && jwtShape.test(refreshToken) ? refreshToken : null
  const cookieHeader = validRefreshToken
    ? `access_token=${accessToken}; refresh_token=${validRefreshToken}`
    : `access_token=${accessToken}`

  let projectCount = 0
  // Captured outside the try so it can be re-thrown after the catch block.
  // Throwing inside catch would be re-caught, silently redirecting to /login instead of
  // surfacing to the error boundary.
  let backendError: Error | null = null

  try {
    const res = await fetch(`${BACKEND}/api/v1/org`, {
      headers: { Cookie: cookieHeader },
      cache: 'no-store',
      signal: AbortSignal.timeout(5_000),
    })
    if (res.status === 401) redirect('/login')
    if (!res.ok) {
      backendError = new Error(`Backend error: ${res.status}`)
    } else {
      const org = await res.json()
      projectCount = org.projectCount ?? 0
    }
  } catch (err) {
    if ((err as { digest?: string }).digest?.startsWith('NEXT_REDIRECT')) throw err
    // Network errors (timeout, connection refused) → redirect to login.
    redirect('/login')
  }

  // Re-throw backend (non-401) errors outside catch so they reach the error boundary.
  if (backendError) throw backendError

  if (projectCount === 0) redirect('/onboarding')

  return <>{children}</>
}
