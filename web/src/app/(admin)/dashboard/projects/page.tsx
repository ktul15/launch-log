import type { Metadata } from 'next'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import ProjectsClient from './ProjectsClient'

export const metadata: Metadata = { title: 'Projects — LaunchLog' }

export interface Project {
  id: string
  name: string
  slug: string
  description: string | null
  widgetKey: string
  createdAt: string
  _count: { changelogEntries: number; roadmapItems: number }
}

const BACKEND = process.env.BACKEND_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001'
const jwtShape = /^[\w-]+\.[\w-]+\.[\w-]+$/
// Strip anything outside the base64url alphabet before embedding in a Cookie header value
// to prevent semicolon-based header injection (e.g. "a.b.c; injected-header: val").
function sanitizeToken(token: string): string {
  return token.replace(/[^A-Za-z0-9\-_.]/g, '')
}

export default async function ProjectsPage() {
  const cookieStore = cookies()
  const accessToken = cookieStore.get('access_token')?.value
  if (!accessToken || !jwtShape.test(accessToken)) redirect('/login')

  const refreshToken = cookieStore.get('refresh_token')?.value
  const validRefreshToken = refreshToken && jwtShape.test(refreshToken) ? refreshToken : null
  const safeAccess = sanitizeToken(accessToken)
  const cookieHeader = validRefreshToken
    ? `access_token=${safeAccess}; refresh_token=${sanitizeToken(validRefreshToken)}`
    : `access_token=${safeAccess}`

  let projects: Project[] = []
  let backendError: Error | null = null

  try {
    const res = await fetch(`${BACKEND}/api/v1/projects`, {
      headers: { Cookie: cookieHeader },
      cache: 'no-store',
      signal: AbortSignal.timeout(5_000),
    })
    if (res.status === 401) redirect('/login')
    if (!res.ok) {
      backendError = new Error(`Backend error: ${res.status}`)
    } else {
      projects = await res.json()
    }
  } catch (err) {
    if ((err as { digest?: string }).digest?.startsWith('NEXT_REDIRECT')) throw err
    // Network errors (timeout, ECONNREFUSED) → surface to error boundary, not silent /login redirect.
    throw err
  }

  if (backendError) throw backendError

  return <ProjectsClient initialProjects={projects} />
}
