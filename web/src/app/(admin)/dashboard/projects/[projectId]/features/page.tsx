import type { Metadata } from 'next'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import FeaturesClient from './FeaturesClient'
import { isFeatureStatus } from '@/types/feature'
import type { FeatureRequest } from '@/types/feature'

export const metadata: Metadata = { title: 'Feature Requests — LaunchLog' }

interface ProjectDetail {
  id: string
  name: string
  slug: string
}

const BACKEND = process.env.BACKEND_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001'
const jwtShape = /^[\w-]+\.[\w-]+\.[\w-]+$/

function sanitizeToken(token: string): string {
  return token.replace(/[^A-Za-z0-9\-_.]/g, '')
}

interface Props {
  params: { projectId: string }
}

export default async function FeaturesPage({ params }: Props) {
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
  let features: FeatureRequest[] = []

  const [projectRes, featuresRes] = await Promise.all([
    fetch(`${BACKEND}/api/v1/projects/${projectId}`, {
      headers: { Cookie: cookieHeader },
      cache: 'no-store',
      signal: AbortSignal.timeout(5_000),
    }),
    fetch(`${BACKEND}/api/v1/projects/${projectId}/features`, {
      headers: { Cookie: cookieHeader },
      cache: 'no-store',
      signal: AbortSignal.timeout(5_000),
    }),
  ])

  if (projectRes.status === 401 || featuresRes.status === 401) redirect('/login')
  if (projectRes.status === 403 || featuresRes.status === 403) redirect('/dashboard/projects')
  if (projectRes.status === 404) redirect('/dashboard/projects')
  if (featuresRes.status === 404) redirect('/dashboard/projects')
  if (!projectRes.ok) throw new Error(`Backend error: ${projectRes.status}`)
  if (!featuresRes.ok) throw new Error(`Backend error: ${featuresRes.status}`)

  const projectData = await projectRes.json() as Partial<ProjectDetail>
  if (!projectData.id || !projectData.name || !projectData.slug) throw new Error('Unexpected project response shape')

  project = projectData as ProjectDetail
  const rawFeatures = await featuresRes.json()
  features = Array.isArray(rawFeatures)
    ? (rawFeatures as unknown[]).filter((item): item is FeatureRequest => {
        if (typeof item !== 'object' || item === null) return false
        const f = item as Record<string, unknown>
        return (
          typeof f.id === 'string' &&
          typeof f.title === 'string' &&
          isFeatureStatus(f.status) &&
          typeof f.voteCount === 'number' &&
          typeof f.createdAt === 'string'
        )
      })
    : []

  return <FeaturesClient projectId={projectId} projectName={project.name} initialFeatures={features} />
}
