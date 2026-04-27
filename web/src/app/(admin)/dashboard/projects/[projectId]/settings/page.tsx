import type { Metadata } from 'next'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import WidgetSettingsClient from './WidgetSettingsClient'
import { parseWidgetSettings } from '@/lib/widgetSettings'

export const metadata: Metadata = { title: 'Widget Settings — LaunchLog' }

// Issue 1: BACKEND_URL is server-only; no NEXT_PUBLIC fallback to avoid leaking internal URL
const BACKEND = process.env.BACKEND_URL ?? 'http://localhost:3001'
const jwtShape = /^[\w-]+\.[\w-]+\.[\w-]+$/
const WIDGET_KEY_RE = /^[a-zA-Z0-9_-]{8,64}$/
const PROJECT_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/

// Issue 2+3: validate allowed chars, then caller validates shape — sanitize before validate
function sanitizeToken(token: string): string | null {
  const stripped = token.replace(/[\r\n]/g, '')
  // JWT chars: base64url alphabet (A-Za-z0-9-_) + segment-separator dots
  if (!/^[A-Za-z0-9\-_.]+$/.test(stripped)) return null
  return stripped
}

interface Props {
  params: { projectId: string }
}

export default async function WidgetSettingsPage({ params }: Props) {
  const { projectId } = params

  // Issue 4: reject path-traversal or oversized IDs before using in a URL
  if (!PROJECT_ID_RE.test(projectId)) redirect('/dashboard/projects')

  const cookieStore = cookies()

  // Issue 3: sanitize first, then validate shape
  const rawAccess = cookieStore.get('access_token')?.value
  const safeAccess = rawAccess ? sanitizeToken(rawAccess) : null
  if (!safeAccess || !jwtShape.test(safeAccess)) redirect('/login')

  const rawRefresh = cookieStore.get('refresh_token')?.value
  const safeRefresh = rawRefresh ? sanitizeToken(rawRefresh) : null
  const validRefreshToken = safeRefresh && jwtShape.test(safeRefresh) ? safeRefresh : null

  const cookieHeader = validRefreshToken
    ? `access_token=${safeAccess}; refresh_token=${validRefreshToken}`
    : `access_token=${safeAccess}`

  const projectRes = await fetch(`${BACKEND}/api/v1/projects/${projectId}`, {
    headers: { Cookie: cookieHeader },
    cache: 'no-store',
    signal: AbortSignal.timeout(5_000),
  })

  if (projectRes.status === 401) redirect('/login')
  if (projectRes.status === 403 || projectRes.status === 404) redirect('/dashboard/projects')
  // Issue 5: throw here is caught by the error.tsx boundary in this directory
  if (!projectRes.ok) throw new Error(`Backend error: ${projectRes.status}`)

  const projectData = await projectRes.json() as Record<string, unknown>
  // Issue 6: validate widgetKey against its stated contract, not just typeof
  if (
    typeof projectData.id !== 'string' ||
    typeof projectData.name !== 'string' ||
    typeof projectData.widgetKey !== 'string' ||
    !WIDGET_KEY_RE.test(projectData.widgetKey)
  ) {
    throw new Error('Unexpected project response shape')
  }

  const initialSettings = parseWidgetSettings(projectData.widgetSettings)

  return (
    <WidgetSettingsClient
      projectId={projectId}
      projectName={projectData.name as string}
      widgetKey={projectData.widgetKey}
      initialSettings={initialSettings}
    />
  )
}
