import { render, screen } from '@testing-library/react'
import PublicPageClient from '@/app/(public)/[orgSlug]/[projectSlug]/PublicPageClient'
import type { PublicChangelogEntry, PublicFeature, PublicRoadmapItem } from '@/types/public'

jest.mock('next/link', () => {
  const MockLink = ({ children, href, ...props }: { children: React.ReactNode; href: string; [key: string]: unknown }) => (
    <a href={href} {...props}>{children}</a>
  )
  MockLink.displayName = 'Link'
  return MockLink
})

function makeChangelog(overrides: Partial<PublicChangelogEntry> = {}): PublicChangelogEntry {
  return {
    id: 'cl-1',
    title: 'Initial Release',
    version: 'v1.0.0',
    status: 'published',
    publishedAt: '2024-03-01T00:00:00.000Z',
    categoryId: null,
    ...overrides,
  }
}

function makeRoadmapItem(overrides: Partial<PublicRoadmapItem> = {}): PublicRoadmapItem {
  return {
    id: 'rm-1',
    title: 'SSO Support',
    description: 'Add SAML/SSO',
    status: 'planned',
    displayOrder: 0,
    ...overrides,
  }
}

function makeFeature(overrides: Partial<PublicFeature> = {}): PublicFeature {
  return {
    id: 'feat-1',
    projectId: 'proj-1',
    title: 'Dark Mode',
    description: 'Support dark theme',
    status: 'open',
    voteCount: 12,
    createdAt: '2024-01-15T00:00:00.000Z',
    updatedAt: '2024-01-15T00:00:00.000Z',
    ...overrides,
  }
}

const BASE_PROPS = { changelog: [], roadmap: [], features: [] }

describe('PublicPageClient — tab nav', () => {
  it('renders all three tab links', () => {
    render(<PublicPageClient {...BASE_PROPS} activeTab="changelog" />)
    expect(screen.getByRole('tab', { name: 'Changelog' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Roadmap' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Features' })).toBeInTheDocument()
  })

  it('marks active tab with aria-selected and aria-current', () => {
    render(<PublicPageClient {...BASE_PROPS} activeTab="roadmap" />)
    const roadmapTab = screen.getByRole('tab', { name: 'Roadmap' })
    expect(roadmapTab).toHaveAttribute('aria-selected', 'true')
    expect(roadmapTab).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('tab', { name: 'Changelog' })).toHaveAttribute('aria-selected', 'false')
  })

  it('tab links point to correct ?tab= URLs', () => {
    render(<PublicPageClient {...BASE_PROPS} activeTab="changelog" />)
    expect(screen.getByRole('tab', { name: 'Roadmap' })).toHaveAttribute('href', '?tab=roadmap')
    expect(screen.getByRole('tab', { name: 'Features' })).toHaveAttribute('href', '?tab=features')
    expect(screen.getByRole('tab', { name: 'Changelog' })).toHaveAttribute('href', '?tab=changelog')
  })
})

describe('PublicPageClient — changelog tab', () => {
  it('shows empty state', () => {
    render(<PublicPageClient {...BASE_PROPS} activeTab="changelog" />)
    expect(screen.getByText(/no changelog entries yet/i)).toBeInTheDocument()
  })

  it('renders changelog entries with version badge and date', () => {
    render(<PublicPageClient {...BASE_PROPS} changelog={[makeChangelog()]} activeTab="changelog" />)
    expect(screen.getByText('Initial Release')).toBeInTheDocument()
    expect(screen.getByText('v1.0.0')).toBeInTheDocument()
    expect(screen.getByText('Mar 1, 2024')).toBeInTheDocument()
  })

  it('omits version badge when version is null', () => {
    render(<PublicPageClient {...BASE_PROPS} changelog={[makeChangelog({ version: null })]} activeTab="changelog" />)
    expect(screen.queryByText('v1.0.0')).not.toBeInTheDocument()
    expect(screen.getByText('Initial Release')).toBeInTheDocument()
  })

  it('omits date when publishedAt is invalid', () => {
    render(<PublicPageClient {...BASE_PROPS} changelog={[makeChangelog({ publishedAt: 'not-a-date' })]} activeTab="changelog" />)
    expect(screen.queryByText('Invalid Date')).not.toBeInTheDocument()
  })

  it('does not render when activeTab is not changelog', () => {
    render(<PublicPageClient {...BASE_PROPS} changelog={[makeChangelog()]} activeTab="roadmap" />)
    expect(screen.queryByText('Initial Release')).not.toBeInTheDocument()
  })
})

describe('PublicPageClient — roadmap tab', () => {
  it('shows empty state for all three columns', () => {
    render(<PublicPageClient {...BASE_PROPS} activeTab="roadmap" />)
    expect(screen.getAllByText(/nothing here yet/i)).toHaveLength(3)
  })

  it('renders roadmap item in correct column', () => {
    render(<PublicPageClient {...BASE_PROPS} roadmap={[makeRoadmapItem()]} activeTab="roadmap" />)
    expect(screen.getByText('SSO Support')).toBeInTheDocument()
    expect(screen.getByText('Add SAML/SSO')).toBeInTheDocument()
  })

  it('does not render when activeTab is not roadmap', () => {
    render(<PublicPageClient {...BASE_PROPS} roadmap={[makeRoadmapItem()]} activeTab="changelog" />)
    expect(screen.queryByText('SSO Support')).not.toBeInTheDocument()
  })
})

describe('PublicPageClient — features tab', () => {
  it('shows empty state', () => {
    render(<PublicPageClient {...BASE_PROPS} activeTab="features" />)
    expect(screen.getByText(/no feature requests yet/i)).toBeInTheDocument()
  })

  it('renders feature with vote count and status label', () => {
    render(<PublicPageClient {...BASE_PROPS} features={[makeFeature()]} activeTab="features" />)
    expect(screen.getByText('Dark Mode')).toBeInTheDocument()
    expect(screen.getByText('12')).toBeInTheDocument()
    expect(screen.getByText('Open')).toBeInTheDocument()
  })

  it('renders feature without description', () => {
    render(<PublicPageClient {...BASE_PROPS} features={[makeFeature({ description: null })]} activeTab="features" />)
    expect(screen.getByText('Dark Mode')).toBeInTheDocument()
  })

  it('renders unknown status as-is', () => {
    render(<PublicPageClient {...BASE_PROPS} features={[makeFeature({ status: 'custom_status' })]} activeTab="features" />)
    expect(screen.getByText('custom_status')).toBeInTheDocument()
  })

  it('does not render when activeTab is not features', () => {
    render(<PublicPageClient {...BASE_PROPS} features={[makeFeature()]} activeTab="changelog" />)
    expect(screen.queryByText('Dark Mode')).not.toBeInTheDocument()
  })
})
