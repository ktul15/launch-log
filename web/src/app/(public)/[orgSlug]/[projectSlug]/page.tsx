import { cache } from 'react'
import { notFound } from 'next/navigation'
import type { Metadata } from 'next'
import PublicPageClient, { type Tab } from './PublicPageClient'
import type {
  PublicProject,
  PublicChangelogEntry,
  PublicFeature,
  PublicRoadmapItem,
} from '@/types/public'

// BACKEND_URL is the server-to-server address (never exposed to the client bundle).
// NEXT_PUBLIC_API_URL is intentionally excluded here — falling back to it would route
// SSR fetches over the public internet if BACKEND_URL is misconfigured.
const BACKEND = process.env.BACKEND_URL ?? 'http://localhost:3001'

// 60s revalidation: public page data changes infrequently (changelogs are published manually).
// This lets the Next.js fetch cache absorb the vast majority of page loads without hitting
// the backend on every request, while staying reasonably fresh.
const REVALIDATE_SECONDS = 60

// AbortSignal.timeout must be called per-request, not as a module-level constant.
// A module-level signal would expire 5s after server startup and abort all subsequent fetches.
function fetchOpts() {
  return { next: { revalidate: REVALIDATE_SECONDS }, signal: AbortSignal.timeout(5_000) }
}

interface Props {
  params: { orgSlug: string; projectSlug: string }
  searchParams: { tab?: string }
}

// React.cache deduplicates across generateMetadata + the page component within one render.
const resolveProject = cache(async (orgSlug: string, projectSlug: string): Promise<PublicProject | null> => {
  let res: Response
  try {
    res = await fetch(
      `${BACKEND}/api/v1/public/resolve/${encodeURIComponent(orgSlug)}/${encodeURIComponent(projectSlug)}`,
      fetchOpts(),
    )
  } catch (err) {
    console.error('[public page] resolve fetch failed:', err instanceof Error ? err.message : String(err))
    throw err
  }
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`Backend error resolving project: ${res.status}`)
  const data = await res.json() as Partial<PublicProject>
  if (!data.name || !data.widgetKey || !data.orgName) throw new Error('Unexpected resolve response shape')
  return data as PublicProject
})

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { orgSlug, projectSlug } = params
  try {
    const project = await resolveProject(orgSlug, projectSlug)
    if (!project) return { title: 'Not Found — LaunchLog' }
    return {
      title: `${project.name} — ${project.orgName}`,
      description: project.description ?? `Changelog, roadmap, and feature requests for ${project.name}.`,
    }
  } catch (err) {
    console.error('[public page] generateMetadata failed:', err instanceof Error ? err.message : String(err))
    return { title: 'LaunchLog' }
  }
}

function parseTab(raw: string | undefined): Tab {
  if (raw === 'roadmap' || raw === 'features') return raw
  return 'changelog'
}

export default async function PublicProjectPage({ params, searchParams }: Props) {
  const { orgSlug, projectSlug } = params
  const activeTab = parseTab(searchParams.tab)

  const project = await resolveProject(orgSlug, projectSlug)
  if (!project) notFound()

  const base = `${BACKEND}/api/v1/public/${project.widgetKey}`

  let changelogRes: Response, roadmapRes: Response, featuresRes: Response
  try {
    ;[changelogRes, roadmapRes, featuresRes] = await Promise.all([
      fetch(`${base}/changelog`, fetchOpts()),
      fetch(`${base}/roadmap`, fetchOpts()),
      fetch(`${base}/features`, fetchOpts()),
    ])
  } catch (err) {
    console.error('[public page] data fetch failed:', err instanceof Error ? err.message : String(err))
    throw err
  }

  if (!changelogRes.ok) throw new Error(`Changelog fetch failed: ${changelogRes.status}`)
  if (!roadmapRes.ok) throw new Error(`Roadmap fetch failed: ${roadmapRes.status}`)
  if (!featuresRes.ok) throw new Error(`Features fetch failed: ${featuresRes.status}`)

  const [changelogRaw, roadmapRaw, featuresRaw] = await Promise.all([
    changelogRes.json(),
    roadmapRes.json(),
    featuresRes.json(),
  ])

  const changelog: PublicChangelogEntry[] = Array.isArray(changelogRaw)
    ? (changelogRaw as unknown[]).filter((e): e is PublicChangelogEntry => {
        if (typeof e !== 'object' || e === null) return false
        const x = e as Record<string, unknown>
        return typeof x.id === 'string' && typeof x.title === 'string'
      })
    : []

  const roadmap: PublicRoadmapItem[] = Array.isArray(roadmapRaw)
    ? (roadmapRaw as unknown[]).filter((e): e is PublicRoadmapItem => {
        if (typeof e !== 'object' || e === null) return false
        const x = e as Record<string, unknown>
        return typeof x.id === 'string' && typeof x.title === 'string' && typeof x.status === 'string'
      })
    : []

  const features: PublicFeature[] = Array.isArray(featuresRaw)
    ? (featuresRaw as unknown[]).filter((e): e is PublicFeature => {
        if (typeof e !== 'object' || e === null) return false
        const x = e as Record<string, unknown>
        return typeof x.id === 'string' && typeof x.title === 'string' && typeof x.voteCount === 'number'
      })
    : []

  return (
    <div className="min-h-screen bg-white">
      <header className="border-b border-gray-200 px-4 py-6">
        <div className="mx-auto max-w-3xl">
          <p className="text-xs font-medium uppercase tracking-wide text-gray-400">{project.orgName}</p>
          <h1 className="mt-1 text-2xl font-bold text-gray-900">{project.name}</h1>
          {project.description && (
            <p className="mt-1 text-sm text-gray-500">{project.description}</p>
          )}
        </div>
      </header>
      <PublicPageClient
        changelog={changelog}
        roadmap={roadmap}
        features={features}
        activeTab={activeTab}
      />
    </div>
  )
}
