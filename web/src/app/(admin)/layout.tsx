import type { ReactNode } from 'react'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'

const BACKEND = process.env.BACKEND_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001'
// JWT must have three base64url segments — validate before interpolating into Cookie header.
const jwtShape = /^[\w-]+\.[\w-]+\.[\w-]+$/
// Strip anything outside the base64url alphabet before embedding in a Cookie header value
// to prevent semicolon-based header injection (e.g. "a.b.c; injected-header: val").
function sanitizeToken(token: string): string {
  return token.replace(/[\r\n]/g, '')
}

export default async function AdminLayout({ children }: { children: ReactNode }) {
  const cookieStore = cookies()
  const accessToken = cookieStore.get('access_token')?.value
  if (!accessToken || !jwtShape.test(accessToken)) redirect('/login')

  // Only forward refresh_token if it also passes the shape check to prevent header injection.
  const refreshToken = cookieStore.get('refresh_token')?.value
  const validRefreshToken = refreshToken && jwtShape.test(refreshToken) ? refreshToken : null
  const safeAccess = sanitizeToken(accessToken)
  const cookieHeader = validRefreshToken
    ? `access_token=${safeAccess}; refresh_token=${sanitizeToken(validRefreshToken)}`
    : `access_token=${safeAccess}`

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
    // Network errors (timeout, ECONNREFUSED) → surface to error boundary, not silent /login redirect.
    throw err
  }

  // Re-throw backend (non-401) errors outside catch so they reach the error boundary.
  if (backendError) throw backendError

  if (projectCount === 0) redirect('/onboarding')

  return (
    <div className="flex min-h-screen bg-gray-50">
      <aside className="w-56 bg-white border-r border-gray-200 flex flex-col">
        <div className="h-14 flex items-center px-5 border-b border-gray-200">
          <span className="font-bold text-indigo-600 text-lg tracking-tight">LaunchLog</span>
        </div>
        <nav className="flex-1 px-3 py-4 space-y-1">
          <a
            href="/dashboard/projects"
            className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium text-gray-700 hover:bg-indigo-50 hover:text-indigo-700 transition-colors"
          >
            Projects
          </a>
        </nav>
      </aside>
      <main className="flex-1 overflow-auto">{children}</main>
    </div>
  )
}
