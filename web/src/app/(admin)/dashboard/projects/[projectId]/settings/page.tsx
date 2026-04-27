import type { Metadata } from 'next'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import WidgetSettingsClient from './WidgetSettingsClient'
import { parseWidgetSettings } from '@/lib/widgetSettings'

export const metadata: Metadata = { title: 'Widget Settings — LaunchLog' }

const BACKEND = process.env.BACKEND_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001'
const jwtShape = /^[\w-]+\.[\w-]+\.[\w-]+$/

function sanitizeToken(token: string): string {
  return token.replace(/[\r\n]/g, '')
}

interface Props {
  params: { projectId: string }
}

export default async function WidgetSettingsPage({ params }: Props) {
  const { projectId } = params

  const cookieStore = cookies()
  const accessToken = cookieStore.get('access_token')?.value
  if (!accessToken || !jwtShape.test(accessToken)) redirect('/login')

  const refreshToken = cookieStore.get('refresh_token')?.value
  const validRefreshToken = refreshToken && jwtShape.test(refreshToken) ? refreshToken : null
  const safeAccess = sanitizeToken(accessToken)
  const cookieHeader = validRefreshToken
    ? `access_token=${safeAccess}; refresh_token=${sanitizeToken(validRefreshToken)}`
    : `access_token=${safeAccess}`

  const projectRes = await fetch(`${BACKEND}/api/v1/projects/${projectId}`, {
    headers: { Cookie: cookieHeader },
    cache: 'no-store',
    signal: AbortSignal.timeout(5_000),
  })

  if (projectRes.status === 401) redirect('/login')
  if (projectRes.status === 403 || projectRes.status === 404) redirect('/dashboard/projects')
  if (!projectRes.ok) throw new Error(`Backend error: ${projectRes.status}`)

  const projectData = await projectRes.json() as Record<string, unknown>
  if (typeof projectData.id !== 'string' || typeof projectData.name !== 'string') {
    throw new Error('Unexpected project response shape')
  }

  const initialSettings = parseWidgetSettings(projectData.widgetSettings)

  return (
    <WidgetSettingsClient
      projectId={projectId}
      projectName={projectData.name as string}
      initialSettings={initialSettings}
    />
  )
}
