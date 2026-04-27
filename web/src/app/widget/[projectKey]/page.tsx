import { cache } from 'react'
import { notFound } from 'next/navigation'
import type { Metadata } from 'next'
import WidgetClient from './WidgetClient'
import type {
  WidgetProject,
  PublicChangelogEntry,
  PublicFeature,
  PublicRoadmapItem,
} from '@/types/public'

const BACKEND = process.env.BACKEND_URL ?? 'http://localhost:3001'
const REVALIDATE_SECONDS = 60

function fetchOpts() {
  return { next: { revalidate: REVALIDATE_SECONDS }, signal: AbortSignal.timeout(5_000) }
}

interface Props {
  params: { projectKey: string }
}

// React.cache deduplicates the /info fetch between generateMetadata and the page component.
const fetchInfo = cache(async (projectKey: string): Promise<WidgetProject | null> => {
  let res: Response
  try {
    res = await fetch(
      `${BACKEND}/api/v1/public/${encodeURIComponent(projectKey)}/info`,
      fetchOpts(),
    )
  } catch (err) {
    console.error('[widget page] info fetch failed:', err instanceof Error ? err.message : String(err))
    throw err
  }
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`Backend error fetching project info: ${res.status}`)
  const raw = await res.json() as Partial<WidgetProject>
  if (!raw.name || !raw.orgName || !raw.plan) throw new Error('Unexpected info response shape')
  return raw as WidgetProject
})

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  try {
    const project = await fetchInfo(params.projectKey)
    if (!project) return { robots: { index: false } }
    return {
      title: `${project.name} — ${project.orgName}`,
      robots: { index: false },
    }
  } catch {
    return { robots: { index: false } }
  }
}

// Fetch a secondary endpoint with individual fallback to empty array on any failure.
// A single endpoint being down should not blank the entire widget.
async function fetchList<T>(url: string): Promise<T[]> {
  try {
    const res = await fetch(url, fetchOpts())
    if (!res.ok) return []
    const data: unknown = await res.json()
    return Array.isArray(data) ? (data as T[]) : []
  } catch {
    return []
  }
}

export default async function WidgetPage({ params }: Props) {
  const { projectKey } = params

  // Fetch info first — it alone determines whether the project exists (notFound).
  const project = await fetchInfo(projectKey)
  if (!project) notFound()

  const base = `${BACKEND}/api/v1/public/${encodeURIComponent(projectKey)}`

  // Secondary fetches are independent; fall back to [] on individual failures so the
  // widget degrades gracefully (e.g. changelog still shows if features endpoint is down).
  const [changelogRaw, roadmapRaw, featuresRaw] = await Promise.all([
    fetchList<PublicChangelogEntry>(`${base}/changelog`),
    fetchList<PublicRoadmapItem>(`${base}/roadmap`),
    fetchList<PublicFeature>(`${base}/features`),
  ])

  const changelog = changelogRaw.filter((e): e is PublicChangelogEntry => {
    if (typeof e !== 'object' || e === null) return false
    const x = e as Record<string, unknown>
    return typeof x.id === 'string' && typeof x.title === 'string'
  })

  const roadmap = roadmapRaw.filter((e): e is PublicRoadmapItem => {
    if (typeof e !== 'object' || e === null) return false
    const x = e as Record<string, unknown>
    return typeof x.id === 'string' && typeof x.title === 'string' && typeof x.status === 'string'
  })

  const features = featuresRaw.filter((e): e is PublicFeature => {
    if (typeof e !== 'object' || e === null) return false
    const x = e as Record<string, unknown>
    return typeof x.id === 'string' && typeof x.title === 'string' && typeof x.voteCount === 'number'
  })

  return (
    <WidgetClient
      project={project}
      changelog={changelog}
      roadmap={roadmap}
      features={features}
      projectKey={projectKey}
    />
  )
}
