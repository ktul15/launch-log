import type { Metadata } from 'next'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import ChangelogClient from './ChangelogClient'
import type { ChangelogEntry } from '@/types/changelog'

export const metadata: Metadata = { title: 'Changelog — LaunchLog' }

interface ProjectDetail {
  id: string
  name: string
  slug: string
}

const BACKEND = process.env.BACKEND_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001'
const jwtShape = /^[\w-]+\.[\w-]+\.[\w-]+$/

function sanitizeToken(token: string): string {
  return token.replace(/[\r\n]/g, '')
}

interface Props {
  params: { projectId: string }
}

export default async function ChangelogPage({ params }: Props) {
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

  let project: ProjectDetail | null = null
  let entries: ChangelogEntry[] = []

  const [projectRes, entriesRes] = await Promise.all([
    fetch(`${BACKEND}/api/v1/projects/${projectId}`, {
      headers: { Cookie: cookieHeader },
      cache: 'no-store',
      signal: AbortSignal.timeout(5_000),
    }),
    fetch(`${BACKEND}/api/v1/projects/${projectId}/changelog`, {
      headers: { Cookie: cookieHeader },
      cache: 'no-store',
      signal: AbortSignal.timeout(5_000),
    }),
  ])

  if (projectRes.status === 401 || entriesRes.status === 401) redirect('/login')
  if (projectRes.status === 404) redirect('/dashboard/projects')
  if (entriesRes.status === 404) redirect('/dashboard/projects')
  if (!projectRes.ok) throw new Error(`Backend error: ${projectRes.status}`)
  if (!entriesRes.ok) throw new Error(`Backend error: ${entriesRes.status}`)

  const projectData = await projectRes.json() as Partial<ProjectDetail>
  if (!projectData.id || !projectData.name) throw new Error('Unexpected project response shape')

  project = projectData as ProjectDetail
  entries = await entriesRes.json()

  return <ChangelogClient projectId={projectId} projectName={project.name} initialEntries={entries} />
}
