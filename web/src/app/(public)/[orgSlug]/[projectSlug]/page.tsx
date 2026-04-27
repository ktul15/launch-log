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

// Safe: if APP_URL is malformed (e.g. missing scheme), falls back rather than crashing at import time.
const APP_ORIGIN = (() => {
  try {
    return new URL(process.env.APP_URL ?? 'http://localhost:3000').origin
  } catch {
    return 'http://localhost:3000'
  }
})()

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
    if (!project) return { title: 'Not Found — LaunchLog', robots: { index: false } }
    const title = `${project.name} — ${project.orgName}`
    const description = project.description ?? `Changelog, roadmap, and feature requests for ${project.name}.`
    const url = `${APP_ORIGIN}/${encodeURIComponent(orgSlug)}/${encodeURIComponent(projectSlug)}`
    return {
      title,
      description,
      openGraph: {
        title,
        description,
        url,
        siteName: 'LaunchLog',
        type: 'website',
        images: [{ url: '/og-default.png', width: 1200, height: 630, alt: title }],
      },
      twitter: {
        card: 'summary_large_image',
        title,
        description,
        images: ['/og-default.png'],
      },
    }
  } catch (err) {
    console.error('[public page] generateMetadata failed:', err instanceof Error ? err.message : String(err))
    return { title: 'LaunchLog', robots: { index: false } }
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

  const pageUrl = `${APP_ORIGIN}/${encodeURIComponent(orgSlug)}/${encodeURIComponent(projectSlug)}`
  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'SoftwareApplication',
        name: project.name,
        ...(project.description ? { description: project.description } : {}),
        applicationCategory: 'BusinessApplication',
        url: pageUrl,
      },
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          {
            '@type': 'ListItem',
            position: 1,
            name: project.orgName,
            item: `${APP_ORIGIN}/${encodeURIComponent(orgSlug)}`,
          },
          { '@type': 'ListItem', position: 2, name: project.name, item: pageUrl },
        ],
      },
    ],
  }
  // JSON.stringify is not HTML-safe: a string like `</script>` closes the tag early.
  // Unicode-escaping < > & prevents the browser HTML parser from misreading the JSON.
  const safeJsonLd = JSON.stringify(jsonLd)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')

  return (
    <div className="min-h-screen bg-white">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: safeJsonLd }} />
      <header className="border-b border-gray-200 px-4 py-4 sm:py-6">
        <div className="mx-auto max-w-3xl">
          <p className="text-xs font-medium uppercase tracking-wide text-gray-400">{project.orgName}</p>
          <h1 className="mt-1 text-xl font-bold text-gray-900 sm:text-2xl">{project.name}</h1>
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
        projectKey={project.widgetKey}
      />
    </div>
  )
}
