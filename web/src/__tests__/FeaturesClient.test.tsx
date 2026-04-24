import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import FeaturesClient from '@/app/(admin)/dashboard/projects/[projectId]/features/FeaturesClient'
import { apiFetch } from '@/lib/api'
import type { FeatureRequest } from '@/types/feature'

jest.mock('@/lib/api', () => ({
  apiFetch: jest.fn(),
}))

const mockApiFetch = jest.mocked(apiFetch)

const PROJECT_ID = 'proj-1'

let featureCounter = 0
beforeEach(() => { featureCounter = 0 })

function makeFeature(overrides: Partial<FeatureRequest> = {}): FeatureRequest {
  return {
    id: `feat-${++featureCounter}`,
    projectId: PROJECT_ID,
    title: 'Dark mode',
    description: 'Support dark theme',
    status: 'open',
    voteCount: 5,
    submitterEmail: 'user@example.com',
    createdAt: '2024-01-15T00:00:00.000Z',
    updatedAt: '2024-01-15T00:00:00.000Z',
    ...overrides,
  }
}

const DEFAULT_PROPS = {
  projectId: PROJECT_ID,
  projectName: 'Acme App',
  initialFeatures: [],
}

beforeEach(() => {
  jest.clearAllMocks()
})

// ─── Rendering ────────────────────────────────────────────────────────────────

describe('FeaturesClient — rendering', () => {
  it('renders empty state when no features', () => {
    render(<FeaturesClient {...DEFAULT_PROPS} />)
    expect(screen.getByText('No feature requests yet.')).toBeInTheDocument()
  })

  it('renders feature title, votes, submitter, and date', () => {
    render(<FeaturesClient {...DEFAULT_PROPS} initialFeatures={[makeFeature()]} />)
    expect(screen.getByText('Dark mode')).toBeInTheDocument()
    expect(screen.getByText('5')).toBeInTheDocument()
    expect(screen.getByText('user@example.com')).toBeInTheDocument()
    expect(screen.getByText('Jan 15, 2024')).toBeInTheDocument()
  })

  it('renders — for null submitterEmail', () => {
    render(<FeaturesClient {...DEFAULT_PROPS} initialFeatures={[makeFeature({ submitterEmail: null })]} />)
    expect(screen.getByText('—')).toBeInTheDocument()
  })

  it('renders description snippet', () => {
    render(<FeaturesClient {...DEFAULT_PROPS} initialFeatures={[makeFeature()]} />)
    expect(screen.getByText('Support dark theme')).toBeInTheDocument()
  })

  it('renders status select with current status selected', () => {
    render(<FeaturesClient {...DEFAULT_PROPS} initialFeatures={[makeFeature({ status: 'planned' })]} />)
    const select = screen.getByRole('combobox', { name: /Status for Dark mode/i })
    expect((select as HTMLSelectElement).value).toBe('planned')
  })

  it('renders table headers', () => {
    render(<FeaturesClient {...DEFAULT_PROPS} initialFeatures={[makeFeature()]} />)
    expect(screen.getByRole('button', { name: /votes/i })).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: /status/i })).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: /submitter/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /date/i })).toBeInTheDocument()
  })
})

// ─── Sorting ──────────────────────────────────────────────────────────────────

describe('FeaturesClient — sorting', () => {
  it('sorts by votes descending by default when clicking Votes', async () => {
    const user = userEvent.setup()
    const features = [
      makeFeature({ id: 'f1', title: 'Alpha', voteCount: 2, createdAt: '2024-01-01T00:00:00.000Z' }),
      makeFeature({ id: 'f2', title: 'Beta', voteCount: 10, createdAt: '2024-01-02T00:00:00.000Z' }),
      makeFeature({ id: 'f3', title: 'Gamma', voteCount: 5, createdAt: '2024-01-03T00:00:00.000Z' }),
    ]
    render(<FeaturesClient {...DEFAULT_PROPS} initialFeatures={features} />)
    await user.click(screen.getByRole('button', { name: /votes/i }))
    const rows = screen.getAllByRole('row')
    // header + 3 data rows
    expect(rows[1]).toHaveTextContent('Beta')
    expect(rows[2]).toHaveTextContent('Gamma')
    expect(rows[3]).toHaveTextContent('Alpha')
  })

  it('toggles votes sort to ascending on second click', async () => {
    const user = userEvent.setup()
    const features = [
      makeFeature({ id: 'f1', title: 'Alpha', voteCount: 2, createdAt: '2024-01-01T00:00:00.000Z' }),
      makeFeature({ id: 'f2', title: 'Beta', voteCount: 10, createdAt: '2024-01-02T00:00:00.000Z' }),
    ]
    render(<FeaturesClient {...DEFAULT_PROPS} initialFeatures={features} />)
    const votesBtn = screen.getByRole('button', { name: /votes/i })
    await user.click(votesBtn)
    await user.click(votesBtn)
    const rows = screen.getAllByRole('row')
    expect(rows[1]).toHaveTextContent('Alpha')
    expect(rows[2]).toHaveTextContent('Beta')
  })

  it('sorts by date descending by default', () => {
    const features = [
      makeFeature({ id: 'f1', title: 'Older', createdAt: '2024-01-01T00:00:00.000Z' }),
      makeFeature({ id: 'f2', title: 'Newer', createdAt: '2024-06-01T00:00:00.000Z' }),
    ]
    render(<FeaturesClient {...DEFAULT_PROPS} initialFeatures={features} />)
    const rows = screen.getAllByRole('row')
    expect(rows[1]).toHaveTextContent('Newer')
    expect(rows[2]).toHaveTextContent('Older')
  })
})

// ─── Status filter ────────────────────────────────────────────────────────────

describe('FeaturesClient — status filter', () => {
  it('filters to selected status', async () => {
    const user = userEvent.setup()
    const features = [
      makeFeature({ id: 'f1', title: 'Open one', status: 'open' }),
      makeFeature({ id: 'f2', title: 'Shipped one', status: 'shipped' }),
    ]
    render(<FeaturesClient {...DEFAULT_PROPS} initialFeatures={features} />)
    await user.selectOptions(screen.getByRole('combobox', { name: /Filter by status/i }), 'shipped')
    expect(screen.getByText('Shipped one')).toBeInTheDocument()
    expect(screen.queryByText('Open one')).not.toBeInTheDocument()
  })

  it('shows filtered empty state', async () => {
    const user = userEvent.setup()
    render(<FeaturesClient {...DEFAULT_PROPS} initialFeatures={[makeFeature({ status: 'open' })]} />)
    await user.selectOptions(screen.getByRole('combobox', { name: /Filter by status/i }), 'closed')
    expect(screen.getByText('No Closed requests.')).toBeInTheDocument()
  })
})

// ─── Status change ────────────────────────────────────────────────────────────

describe('FeaturesClient — status change', () => {
  it('calls PATCH and updates status on success', async () => {
    const user = userEvent.setup()
    const feature = makeFeature({ status: 'open' })
    const updated = { ...feature, status: 'planned' as const }
    mockApiFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => updated,
    } as Response)

    render(<FeaturesClient {...DEFAULT_PROPS} initialFeatures={[feature]} />)
    const select = screen.getByRole('combobox', { name: /Status for Dark mode/i })
    await user.selectOptions(select, 'planned')

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith(
        `/api/v1/projects/${PROJECT_ID}/features/feat-1`,
        expect.objectContaining({ method: 'PATCH' }),
      )
    })
    expect((select as HTMLSelectElement).value).toBe('planned')
  })

  it('shows error banner and reverts select on PATCH failure', async () => {
    const user = userEvent.setup()
    mockApiFetch.mockResolvedValueOnce({
      ok: false,
      json: async () => ({ message: 'Not allowed' }),
    } as Response)

    render(<FeaturesClient {...DEFAULT_PROPS} initialFeatures={[makeFeature({ status: 'open' })]} />)
    const select = screen.getByRole('combobox', { name: /Status for Dark mode/i })
    await user.selectOptions(select, 'closed')

    await waitFor(() => {
      expect(screen.getByText('Not allowed')).toBeInTheDocument()
    })
    expect((select as HTMLSelectElement).value).toBe('open')
  })

  it('shows per-feature title in network error message', async () => {
    const user = userEvent.setup()
    mockApiFetch.mockRejectedValueOnce(new Error('Network failure'))

    render(<FeaturesClient {...DEFAULT_PROPS} initialFeatures={[makeFeature()]} />)
    const select = screen.getByRole('combobox', { name: /Status for Dark mode/i })
    await user.selectOptions(select, 'closed')

    await waitFor(() => {
      expect(screen.getByText(/Status not updated for/)).toBeInTheDocument()
    })
  })
})

// ─── Delete ───────────────────────────────────────────────────────────────────

describe('FeaturesClient — delete', () => {
  it('shows confirm/cancel on first delete click', async () => {
    const user = userEvent.setup()
    render(<FeaturesClient {...DEFAULT_PROPS} initialFeatures={[makeFeature()]} />)
    await user.click(screen.getByRole('button', { name: /^Delete$/i }))
    expect(screen.getByRole('button', { name: /Confirm/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Cancel/i })).toBeInTheDocument()
  })

  it('cancels delete and hides confirm buttons', async () => {
    const user = userEvent.setup()
    render(<FeaturesClient {...DEFAULT_PROPS} initialFeatures={[makeFeature()]} />)
    await user.click(screen.getByRole('button', { name: /^Delete$/i }))
    await user.click(screen.getByRole('button', { name: /Cancel/i }))
    expect(screen.queryByRole('button', { name: /Confirm/i })).not.toBeInTheDocument()
  })

  it('calls DELETE and removes row on confirm', async () => {
    const user = userEvent.setup()
    mockApiFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) } as Response)

    render(<FeaturesClient {...DEFAULT_PROPS} initialFeatures={[makeFeature()]} />)
    await user.click(screen.getByRole('button', { name: /^Delete$/i }))
    await user.click(screen.getByRole('button', { name: /Confirm/i }))

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith(
        `/api/v1/projects/${PROJECT_ID}/features/feat-1`,
        expect.objectContaining({ method: 'DELETE' }),
      )
      expect(screen.queryByText('Dark mode')).not.toBeInTheDocument()
    })
  })

  it('shows error banner on DELETE failure', async () => {
    const user = userEvent.setup()
    mockApiFetch.mockResolvedValueOnce({
      ok: false,
      json: async () => ({ message: 'Server error' }),
    } as Response)

    render(<FeaturesClient {...DEFAULT_PROPS} initialFeatures={[makeFeature()]} />)
    await user.click(screen.getByRole('button', { name: /^Delete$/i }))
    await user.click(screen.getByRole('button', { name: /Confirm/i }))

    await waitFor(() => {
      expect(screen.getByText('Server error')).toBeInTheDocument()
    })
  })

  it('ignores second Confirm click while delete is in flight', async () => {
    const user = userEvent.setup()
    let resolveFirst!: (v: Response) => void
    const firstCall = new Promise<Response>((res) => { resolveFirst = res })
    mockApiFetch.mockReturnValueOnce(firstCall)

    render(<FeaturesClient {...DEFAULT_PROPS} initialFeatures={[makeFeature()]} />)
    await user.click(screen.getByRole('button', { name: /^Delete$/i }))
    await user.click(screen.getByRole('button', { name: /Confirm/i }))
    await user.click(screen.getByRole('button', { name: /Confirm|Deleting/i }))

    resolveFirst({ ok: true, json: async () => ({}) } as Response)
    await waitFor(() => expect(screen.queryByText('Dark mode')).not.toBeInTheDocument())

    expect(mockApiFetch).toHaveBeenCalledTimes(1)
  })

  it('dismisses error banner', async () => {
    const user = userEvent.setup()
    mockApiFetch.mockResolvedValueOnce({
      ok: false,
      json: async () => ({ message: 'Server error' }),
    } as Response)

    render(<FeaturesClient {...DEFAULT_PROPS} initialFeatures={[makeFeature()]} />)
    await user.click(screen.getByRole('button', { name: /^Delete$/i }))
    await user.click(screen.getByRole('button', { name: /Confirm/i }))
    await waitFor(() => screen.getByText('Server error'))
    await user.click(screen.getByRole('button', { name: /Dismiss error/i }))
    expect(screen.queryByText('Server error')).not.toBeInTheDocument()
  })
})
