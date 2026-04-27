import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import WidgetClient from '@/app/widget/[projectKey]/WidgetClient'
import type { WidgetProject, PublicChangelogEntry, PublicFeature, PublicRoadmapItem } from '@/types/public'

jest.mock('@/components/RichTextViewer', () => {
  function MockRichTextViewer() {
    return <div data-testid="rich-text-viewer" />
  }
  return MockRichTextViewer
})

jest.mock('@/components/FeaturesTab', () => {
  function MockFeaturesTab() {
    return <div data-testid="features-tab" />
  }
  return MockFeaturesTab
})

jest.mock('@/components/SubscribeForm', () => {
  function MockSubscribeForm() {
    return <div data-testid="subscribe-form" />
  }
  return MockSubscribeForm
})

jest.mock('@/lib/api', () => ({
  apiFetch: jest.fn(),
}))

const mockApiFetch = jest.requireMock('@/lib/api').apiFetch as jest.Mock

function makeProject(overrides: Partial<WidgetProject> = {}): WidgetProject {
  return {
    name: 'My Product',
    description: 'A great product',
    orgName: 'Acme Corp',
    plan: 'free',
    ...overrides,
  }
}

function makeChangelog(overrides: Partial<PublicChangelogEntry> = {}): PublicChangelogEntry {
  return {
    id: 'cl-1',
    title: 'v1.0 Released',
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
    description: null,
    status: 'open',
    voteCount: 5,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  }
}

const BASE_PROPS = {
  project: makeProject(),
  changelog: [],
  roadmap: [],
  features: [],
  projectKey: '00000000-0000-0000-0000-000000000001',
}

beforeEach(() => {
  mockApiFetch.mockReset()
})

describe('WidgetClient — header', () => {
  it('renders project name and org name', () => {
    render(<WidgetClient {...BASE_PROPS} />)
    expect(screen.getByText('My Product')).toBeInTheDocument()
    expect(screen.getByText('Acme Corp')).toBeInTheDocument()
  })

  it('renders description when present', () => {
    render(<WidgetClient {...BASE_PROPS} />)
    expect(screen.getByText('A great product')).toBeInTheDocument()
  })

  it('omits description when null', () => {
    render(<WidgetClient {...BASE_PROPS} project={makeProject({ description: null })} />)
    expect(screen.queryByText('A great product')).not.toBeInTheDocument()
  })
})

describe('WidgetClient — tab switching', () => {
  it('renders all three tab buttons with role="tab"', () => {
    render(<WidgetClient {...BASE_PROPS} />)
    expect(screen.getByRole('tab', { name: 'Changelog' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Roadmap' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Features' })).toBeInTheDocument()
  })

  it('defaults to changelog tab selected', () => {
    render(<WidgetClient {...BASE_PROPS} />)
    expect(screen.getByRole('tab', { name: 'Changelog' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: 'Roadmap' })).toHaveAttribute('aria-selected', 'false')
  })

  it('switches to roadmap tab on click', () => {
    render(<WidgetClient {...BASE_PROPS} />)
    fireEvent.click(screen.getByRole('tab', { name: 'Roadmap' }))
    expect(screen.getByRole('tab', { name: 'Roadmap' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tabpanel', { name: 'Roadmap' })).not.toHaveAttribute('hidden')
  })

  it('switches to features tab on click', () => {
    render(<WidgetClient {...BASE_PROPS} />)
    fireEvent.click(screen.getByRole('tab', { name: 'Features' }))
    expect(screen.getByRole('tab', { name: 'Features' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByTestId('features-tab')).toBeInTheDocument()
  })

  it('changelog panel hidden when roadmap tab active', () => {
    render(<WidgetClient {...BASE_PROPS} changelog={[makeChangelog()]} />)
    fireEvent.click(screen.getByRole('tab', { name: 'Roadmap' }))
    // aria-labelledby is not resolved for hidden elements by testing-library — query by id
    expect(document.getElementById('widget-panel-changelog')).toHaveAttribute('hidden')
    expect(document.getElementById('widget-panel-roadmap')).not.toHaveAttribute('hidden')
  })

  it('tab buttons have aria-controls pointing to correct panel ids', () => {
    render(<WidgetClient {...BASE_PROPS} />)
    expect(screen.getByRole('tab', { name: 'Changelog' })).toHaveAttribute('aria-controls', 'widget-panel-changelog')
    expect(screen.getByRole('tab', { name: 'Roadmap' })).toHaveAttribute('aria-controls', 'widget-panel-roadmap')
    expect(screen.getByRole('tab', { name: 'Features' })).toHaveAttribute('aria-controls', 'widget-panel-features')
  })
})

describe('WidgetClient — changelog tab', () => {
  it('shows empty state', () => {
    render(<WidgetClient {...BASE_PROPS} />)
    expect(screen.getByText(/no changelog entries yet/i)).toBeInTheDocument()
  })

  it('renders entry title and version', () => {
    render(<WidgetClient {...BASE_PROPS} changelog={[makeChangelog()]} />)
    expect(screen.getByText('v1.0 Released')).toBeInTheDocument()
    expect(screen.getByText('v1.0.0')).toBeInTheDocument()
  })

  it('fetches and shows content on expand', async () => {
    mockApiFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ content: { type: 'doc', content: [] } }),
    })
    render(<WidgetClient {...BASE_PROPS} changelog={[makeChangelog()]} />)
    fireEvent.click(screen.getByRole('button', { name: /v1.0 released/i }))
    await waitFor(() => expect(screen.getByTestId('rich-text-viewer')).toBeInTheDocument())
    expect(mockApiFetch).toHaveBeenCalledWith(
      `/api/v1/public/${encodeURIComponent(BASE_PROPS.projectKey)}/changelog/${encodeURIComponent('cl-1')}`,
      expect.any(Object),
    )
  })

  it('collapses on second click', async () => {
    mockApiFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ content: { type: 'doc', content: [] } }),
    })
    render(<WidgetClient {...BASE_PROPS} changelog={[makeChangelog()]} />)
    const btn = screen.getByRole('button', { name: /v1.0 released/i })
    fireEvent.click(btn)
    await waitFor(() => expect(screen.getByTestId('rich-text-viewer')).toBeInTheDocument())
    fireEvent.click(btn)
    expect(screen.queryByTestId('rich-text-viewer')).not.toBeInTheDocument()
  })

  it('shows error message on non-ok fetch response', async () => {
    mockApiFetch.mockResolvedValue({ ok: false })
    render(<WidgetClient {...BASE_PROPS} changelog={[makeChangelog()]} />)
    fireEvent.click(screen.getByRole('button', { name: /v1.0 released/i }))
    await waitFor(() => expect(screen.getByText(/failed to load/i)).toBeInTheDocument())
    expect(screen.queryByTestId('rich-text-viewer')).not.toBeInTheDocument()
  })

  it('shows error message on network failure', async () => {
    mockApiFetch.mockRejectedValue(new Error('Network error'))
    render(<WidgetClient {...BASE_PROPS} changelog={[makeChangelog()]} />)
    fireEvent.click(screen.getByRole('button', { name: /v1.0 released/i }))
    await waitFor(() => expect(screen.getByText(/failed to load/i)).toBeInTheDocument())
  })

  it('shows "No content yet." when content is null', async () => {
    mockApiFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ content: null }),
    })
    render(<WidgetClient {...BASE_PROPS} changelog={[makeChangelog()]} />)
    fireEvent.click(screen.getByRole('button', { name: /v1.0 released/i }))
    await waitFor(() => expect(screen.getByText(/no content yet/i)).toBeInTheDocument())
    expect(screen.queryByTestId('rich-text-viewer')).not.toBeInTheDocument()
  })

  it('does not show error when fetch is aborted (AbortError)', async () => {
    const abortError = new Error('Aborted')
    abortError.name = 'AbortError'
    mockApiFetch.mockRejectedValue(abortError)
    render(<WidgetClient {...BASE_PROPS} changelog={[makeChangelog()]} />)
    fireEvent.click(screen.getByRole('button', { name: /v1.0 released/i }))
    // Wait a tick for the async to settle
    await waitFor(() => expect(screen.queryByText(/failed to load/i)).not.toBeInTheDocument())
    expect(screen.queryByTestId('rich-text-viewer')).not.toBeInTheDocument()
  })

  it('error state is per-entry — concurrent expand of two entries tracks independently', async () => {
    mockApiFetch.mockResolvedValue({ ok: false })
    const entries = [
      makeChangelog({ id: 'cl-1', title: 'Entry One' }),
      makeChangelog({ id: 'cl-2', title: 'Entry Two' }),
    ]
    render(<WidgetClient {...BASE_PROPS} changelog={entries} />)
    fireEvent.click(screen.getByRole('button', { name: /entry one/i }))
    await waitFor(() => expect(screen.getByText(/failed to load/i)).toBeInTheDocument())
    // Collapse entry one, expand entry two — error should clear
    fireEvent.click(screen.getByRole('button', { name: /entry one/i }))
    fireEvent.click(screen.getByRole('button', { name: /entry two/i }))
    await waitFor(() => expect(screen.getByText(/failed to load/i)).toBeInTheDocument())
    // Only one error shown (for entry two), not two
    expect(screen.getAllByText(/failed to load/i)).toHaveLength(1)
  })

  it('aria-live region has aria-busy=true while loading', async () => {
    // Assign resolveJson before json() is ever called so the ref is ready.
    let resolveJson!: (v: unknown) => void
    const jsonPromise = new Promise((r) => { resolveJson = r })
    mockApiFetch.mockResolvedValue({ ok: true, json: () => jsonPromise })
    render(<WidgetClient {...BASE_PROPS} changelog={[makeChangelog()]} />)
    fireEvent.click(screen.getByRole('button', { name: /v1.0 released/i }))
    // While in-flight, aria-busy should be true
    const region = document.getElementById('changelog-content-cl-1')
    expect(region).toHaveAttribute('aria-busy', 'true')
    resolveJson({ content: { type: 'doc', content: [] } })
    await waitFor(() => expect(region).toHaveAttribute('aria-busy', 'false'))
  })
})

describe('WidgetClient — roadmap tab', () => {
  it('renders all three status columns', () => {
    render(<WidgetClient {...BASE_PROPS} />)
    fireEvent.click(screen.getByRole('tab', { name: 'Roadmap' }))
    expect(screen.getByText('Planned')).toBeInTheDocument()
    expect(screen.getByText('In Progress')).toBeInTheDocument()
    expect(screen.getByText('Shipped')).toBeInTheDocument()
  })

  it('renders item in correct column', () => {
    render(<WidgetClient {...BASE_PROPS} roadmap={[makeRoadmapItem()]} />)
    fireEvent.click(screen.getByRole('tab', { name: 'Roadmap' }))
    expect(screen.getByText('SSO Support')).toBeInTheDocument()
  })

  it('shows nothing-here-yet for empty columns', () => {
    render(<WidgetClient {...BASE_PROPS} />)
    fireEvent.click(screen.getByRole('tab', { name: 'Roadmap' }))
    expect(screen.getAllByText(/nothing here yet/i)).toHaveLength(3)
  })
})

describe('WidgetClient — features tab', () => {
  it('renders FeaturesTab component', () => {
    render(<WidgetClient {...BASE_PROPS} features={[makeFeature()]} />)
    fireEvent.click(screen.getByRole('tab', { name: 'Features' }))
    expect(screen.getByTestId('features-tab')).toBeInTheDocument()
  })
})

describe('WidgetClient — subscribe form', () => {
  it('renders SubscribeForm on all tabs', () => {
    render(<WidgetClient {...BASE_PROPS} />)
    expect(screen.getByTestId('subscribe-form')).toBeInTheDocument()
  })
})

describe('WidgetClient — free-tier footer', () => {
  it('renders "Powered by LaunchLog" link for free plan', () => {
    render(<WidgetClient {...BASE_PROPS} project={makeProject({ plan: 'free' })} />)
    const link = screen.getByRole('link', { name: /powered by launchlog/i })
    expect(link).toBeInTheDocument()
    expect(link).toHaveAttribute('href', 'https://launchlog.app')
    expect(link).toHaveAttribute('target', '_blank')
  })

  it('does not render footer for starter plan', () => {
    render(<WidgetClient {...BASE_PROPS} project={makeProject({ plan: 'starter' })} />)
    expect(screen.queryByRole('link', { name: /powered by launchlog/i })).not.toBeInTheDocument()
  })

  it('does not render footer for pro plan', () => {
    render(<WidgetClient {...BASE_PROPS} project={makeProject({ plan: 'pro' })} />)
    expect(screen.queryByRole('link', { name: /powered by launchlog/i })).not.toBeInTheDocument()
  })
})
