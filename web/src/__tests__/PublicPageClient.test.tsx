import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import PublicPageClient from '@/app/(public)/[orgSlug]/[projectSlug]/PublicPageClient'
import type { PublicChangelogEntry, PublicFeature, PublicRoadmapItem } from '@/types/public'

jest.mock('next/link', () => {
  const MockLink = ({ children, href, ...props }: { children: React.ReactNode; href: string; [key: string]: unknown }) => (
    <a href={href} {...props}>{children}</a>
  )
  MockLink.displayName = 'Link'
  return MockLink
})

jest.mock('@/components/RichTextViewer', () => {
  function MockRichTextViewer() {
    return <div data-testid="rich-text-viewer" />
  }
  return MockRichTextViewer
})

jest.mock('@/lib/api', () => ({
  apiFetch: jest.fn(),
}))

const mockApiFetch = jest.requireMock('@/lib/api').apiFetch as jest.Mock

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

const BASE_PROPS = { changelog: [], roadmap: [], features: [], projectKey: 'test-key' }

function mockFetchSuccess(content = { type: 'doc', content: [] }) {
  mockApiFetch.mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ content }),
  })
}

function mockFetchFailure() {
  mockApiFetch.mockRejectedValue(new Error('Network error'))
}

beforeEach(() => {
  mockApiFetch.mockReset()
})

describe('PublicPageClient — tab nav', () => {
  it('renders all three tab links', () => {
    render(<PublicPageClient {...BASE_PROPS} activeTab="changelog" />)
    expect(screen.getByRole('link', { name: 'Changelog' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Roadmap' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Features' })).toBeInTheDocument()
  })

  it('marks active tab with aria-current', () => {
    render(<PublicPageClient {...BASE_PROPS} activeTab="roadmap" />)
    expect(screen.getByRole('link', { name: 'Roadmap' })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('link', { name: 'Changelog' })).not.toHaveAttribute('aria-current')
  })

  it('tab links point to correct ?tab= URLs', () => {
    render(<PublicPageClient {...BASE_PROPS} activeTab="changelog" />)
    expect(screen.getByRole('link', { name: 'Roadmap' })).toHaveAttribute('href', '?tab=roadmap')
    expect(screen.getByRole('link', { name: 'Features' })).toHaveAttribute('href', '?tab=features')
    expect(screen.getByRole('link', { name: 'Changelog' })).toHaveAttribute('href', '?tab=changelog')
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

  it('does not show viewer before clicking an entry', () => {
    render(<PublicPageClient {...BASE_PROPS} changelog={[makeChangelog()]} activeTab="changelog" />)
    expect(screen.queryByTestId('rich-text-viewer')).not.toBeInTheDocument()
  })

  it('fetches and shows viewer after clicking an entry', async () => {
    mockFetchSuccess()
    render(<PublicPageClient {...BASE_PROPS} changelog={[makeChangelog()]} activeTab="changelog" />)
    fireEvent.click(screen.getByRole('button', { name: /initial release/i }))
    await waitFor(() => expect(screen.getByTestId('rich-text-viewer')).toBeInTheDocument())
    expect(mockApiFetch).toHaveBeenCalledWith('/api/v1/public/test-key/changelog/cl-1', expect.any(Object))
  })

  it('collapses entry on second click', async () => {
    mockFetchSuccess()
    render(<PublicPageClient {...BASE_PROPS} changelog={[makeChangelog()]} activeTab="changelog" />)
    const btn = screen.getByRole('button', { name: /initial release/i })
    fireEvent.click(btn)
    await waitFor(() => expect(screen.getByTestId('rich-text-viewer')).toBeInTheDocument())
    fireEvent.click(btn)
    expect(screen.queryByTestId('rich-text-viewer')).not.toBeInTheDocument()
  })

  it('toggles aria-expanded on click', () => {
    mockFetchSuccess()
    render(<PublicPageClient {...BASE_PROPS} changelog={[makeChangelog()]} activeTab="changelog" />)
    const btn = screen.getByRole('button', { name: /initial release/i })
    expect(btn).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(btn)
    expect(btn).toHaveAttribute('aria-expanded', 'true')
  })

  it('button has aria-controls pointing to content region', () => {
    render(<PublicPageClient {...BASE_PROPS} changelog={[makeChangelog()]} activeTab="changelog" />)
    const btn = screen.getByRole('button', { name: /initial release/i })
    expect(btn).toHaveAttribute('aria-controls', 'changelog-content-cl-1')
    expect(document.getElementById('changelog-content-cl-1')).toBeInTheDocument()
  })

  it('caches content — does not refetch on re-expand', async () => {
    mockFetchSuccess()
    render(<PublicPageClient {...BASE_PROPS} changelog={[makeChangelog()]} activeTab="changelog" />)
    const btn = screen.getByRole('button', { name: /initial release/i })
    fireEvent.click(btn)
    await waitFor(() => expect(screen.getByTestId('rich-text-viewer')).toBeInTheDocument())
    fireEvent.click(btn)
    fireEvent.click(btn)
    await waitFor(() => expect(screen.getByTestId('rich-text-viewer')).toBeInTheDocument())
    expect(mockApiFetch).toHaveBeenCalledTimes(1)
  })

  it('switching to another entry collapses the first', async () => {
    mockFetchSuccess()
    const entries = [
      makeChangelog({ id: 'cl-1', title: 'Entry One' }),
      makeChangelog({ id: 'cl-2', title: 'Entry Two' }),
    ]
    render(<PublicPageClient {...BASE_PROPS} changelog={entries} activeTab="changelog" />)
    fireEvent.click(screen.getByRole('button', { name: /entry one/i }))
    await waitFor(() => expect(screen.getAllByTestId('rich-text-viewer')).toHaveLength(1))
    fireEvent.click(screen.getByRole('button', { name: /entry two/i }))
    await waitFor(() => expect(screen.getAllByTestId('rich-text-viewer')).toHaveLength(1))
    expect(screen.getByRole('button', { name: /entry one/i })).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByRole('button', { name: /entry two/i })).toHaveAttribute('aria-expanded', 'true')
  })

  it('shows no viewer when fetch fails', async () => {
    mockFetchFailure()
    render(<PublicPageClient {...BASE_PROPS} changelog={[makeChangelog()]} activeTab="changelog" />)
    fireEvent.click(screen.getByRole('button', { name: /initial release/i }))
    await waitFor(() => expect(screen.getByRole('button', { name: /initial release/i })).toHaveAttribute('aria-expanded', 'true'))
    expect(screen.queryByTestId('rich-text-viewer')).not.toBeInTheDocument()
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
