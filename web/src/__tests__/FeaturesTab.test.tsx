import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import FeaturesTab from '@/app/(public)/[orgSlug]/[projectSlug]/FeaturesTab'
import type { PublicFeature } from '@/types/public'

jest.mock('@/lib/api', () => ({
  apiFetch: jest.fn(),
}))

const mockApiFetch = jest.requireMock('@/lib/api').apiFetch as jest.Mock

function makeFeature(overrides: Partial<PublicFeature> = {}): PublicFeature {
  return {
    id: 'feat-1',
    projectId: 'proj-1',
    title: 'Dark Mode',
    description: 'Support dark theme',
    status: 'open',
    voteCount: 5,
    createdAt: '2024-01-15T00:00:00.000Z',
    updatedAt: '2024-01-15T00:00:00.000Z',
    ...overrides,
  }
}

// Must be a valid UUID — FeaturesTab rejects non-UUID keys before building fetch URLs
const PROJECT_KEY = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'

beforeEach(() => {
  mockApiFetch.mockReset()
})

// ── Rendering ──────────────────────────────────────────────────────────────

describe('FeaturesTab — rendering', () => {
  it('shows empty state when no features', () => {
    render(<FeaturesTab initialFeatures={[]} projectKey={PROJECT_KEY} />)
    expect(screen.getByText(/no feature requests yet/i)).toBeInTheDocument()
  })

  it('shows request count', () => {
    render(<FeaturesTab initialFeatures={[makeFeature()]} projectKey={PROJECT_KEY} />)
    expect(screen.getByText('1 request')).toBeInTheDocument()
  })

  it('pluralises request count', () => {
    render(
      <FeaturesTab
        initialFeatures={[makeFeature({ id: 'f1' }), makeFeature({ id: 'f2' })]}
        projectKey={PROJECT_KEY}
      />
    )
    expect(screen.getByText('2 requests')).toBeInTheDocument()
  })

  it('renders title, vote count, and status badge', () => {
    render(<FeaturesTab initialFeatures={[makeFeature()]} projectKey={PROJECT_KEY} />)
    expect(screen.getByText('Dark Mode')).toBeInTheDocument()
    expect(screen.getByText('5')).toBeInTheDocument()
    expect(screen.getByText('Open')).toBeInTheDocument()
  })

  it('renders description when present', () => {
    render(<FeaturesTab initialFeatures={[makeFeature()]} projectKey={PROJECT_KEY} />)
    expect(screen.getByText('Support dark theme')).toBeInTheDocument()
  })

  it('omits description when null', () => {
    render(<FeaturesTab initialFeatures={[makeFeature({ description: null })]} projectKey={PROJECT_KEY} />)
    expect(screen.queryByText('Support dark theme')).not.toBeInTheDocument()
  })

  it('renders unknown status as-is', () => {
    render(<FeaturesTab initialFeatures={[makeFeature({ status: 'custom_xyz' })]} projectKey={PROJECT_KEY} />)
    expect(screen.getByText('custom_xyz')).toBeInTheDocument()
  })

  it('renders Submit Request button', () => {
    render(<FeaturesTab initialFeatures={[]} projectKey={PROJECT_KEY} />)
    expect(screen.getByRole('button', { name: /submit request/i })).toBeInTheDocument()
  })

  it('Submit Request button has aria-haspopup="dialog"', () => {
    render(<FeaturesTab initialFeatures={[]} projectKey={PROJECT_KEY} />)
    expect(screen.getByRole('button', { name: /submit request/i })).toHaveAttribute('aria-haspopup', 'dialog')
  })
})

// ── Vote button state ──────────────────────────────────────────────────────

describe('FeaturesTab — vote button', () => {
  it('renders enabled vote button for open feature', () => {
    render(<FeaturesTab initialFeatures={[makeFeature()]} projectKey={PROJECT_KEY} />)
    expect(screen.getByRole('button', { name: /vote for dark mode/i })).not.toBeDisabled()
  })

  it('renders disabled vote button for closed feature', () => {
    render(<FeaturesTab initialFeatures={[makeFeature({ status: 'closed' })]} projectKey={PROJECT_KEY} />)
    expect(screen.getByRole('button', { name: /vote for dark mode/i })).toBeDisabled()
  })

  it('renders disabled vote button for shipped feature', () => {
    render(<FeaturesTab initialFeatures={[makeFeature({ status: 'shipped' })]} projectKey={PROJECT_KEY} />)
    expect(screen.getByRole('button', { name: /vote for dark mode/i })).toBeDisabled()
  })
})

// ── Inline vote email capture ──────────────────────────────────────────────

describe('FeaturesTab — inline vote flow', () => {
  it('shows email input after clicking vote button', () => {
    render(<FeaturesTab initialFeatures={[makeFeature()]} projectKey={PROJECT_KEY} />)
    fireEvent.click(screen.getByRole('button', { name: /vote for dark mode/i }))
    expect(screen.getByPlaceholderText(/your@email.com/i)).toBeInTheDocument()
  })

  it('collapses email input on second click', () => {
    render(<FeaturesTab initialFeatures={[makeFeature()]} projectKey={PROJECT_KEY} />)
    const voteBtn = screen.getByRole('button', { name: /vote for dark mode/i })
    fireEvent.click(voteBtn)
    expect(screen.getByPlaceholderText(/your@email.com/i)).toBeInTheDocument()
    fireEvent.click(voteBtn)
    expect(screen.queryByPlaceholderText(/your@email.com/i)).not.toBeInTheDocument()
  })

  it('cancel button collapses email input', () => {
    render(<FeaturesTab initialFeatures={[makeFeature()]} projectKey={PROJECT_KEY} />)
    fireEvent.click(screen.getByRole('button', { name: /vote for dark mode/i }))
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }))
    expect(screen.queryByPlaceholderText(/your@email.com/i)).not.toBeInTheDocument()
  })

  it('submits vote with email and shows success message', async () => {
    mockApiFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({}) })
    render(<FeaturesTab initialFeatures={[makeFeature()]} projectKey={PROJECT_KEY} />)
    fireEvent.click(screen.getByRole('button', { name: /vote for dark mode/i }))
    fireEvent.change(screen.getByPlaceholderText(/your@email.com/i), { target: { value: 'user@test.com' } })
    fireEvent.click(screen.getByRole('button', { name: /^vote$/i }))
    await waitFor(() => expect(screen.getByText(/check your email/i)).toBeInTheDocument())
    expect(mockApiFetch).toHaveBeenCalledWith(
      `/api/v1/public/${PROJECT_KEY}/features/feat-1/vote`,
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ email: 'user@test.com' }) })
    )
  })

  it('shows already voted message on 409', async () => {
    mockApiFetch.mockResolvedValue({
      ok: false,
      status: 409,
      json: () => Promise.resolve({ message: 'You have already voted for this feature.' }),
    })
    render(<FeaturesTab initialFeatures={[makeFeature()]} projectKey={PROJECT_KEY} />)
    fireEvent.click(screen.getByRole('button', { name: /vote for dark mode/i }))
    fireEvent.change(screen.getByPlaceholderText(/your@email.com/i), { target: { value: 'dup@test.com' } })
    fireEvent.click(screen.getByRole('button', { name: /^vote$/i }))
    await waitFor(() => expect(screen.getByText(/already voted/i)).toBeInTheDocument())
  })

  it('shows rate limit message on 429', async () => {
    mockApiFetch.mockResolvedValue({
      ok: false,
      status: 429,
      json: () => Promise.resolve({}),
    })
    render(<FeaturesTab initialFeatures={[makeFeature()]} projectKey={PROJECT_KEY} />)
    fireEvent.click(screen.getByRole('button', { name: /vote for dark mode/i }))
    fireEvent.change(screen.getByPlaceholderText(/your@email.com/i), { target: { value: 'rl@test.com' } })
    fireEvent.click(screen.getByRole('button', { name: /^vote$/i }))
    await waitFor(() => expect(screen.getByText(/too many attempts/i)).toBeInTheDocument())
  })

  it('shows error message on network failure', async () => {
    mockApiFetch.mockRejectedValue(new Error('Network error'))
    render(<FeaturesTab initialFeatures={[makeFeature()]} projectKey={PROJECT_KEY} />)
    fireEvent.click(screen.getByRole('button', { name: /vote for dark mode/i }))
    fireEvent.change(screen.getByPlaceholderText(/your@email.com/i), { target: { value: 'err@test.com' } })
    fireEvent.click(screen.getByRole('button', { name: /^vote$/i }))
    await waitFor(() => expect(screen.getByText(/network error/i)).toBeInTheDocument())
  })

  it('submits vote on Enter key', async () => {
    mockApiFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({}) })
    render(<FeaturesTab initialFeatures={[makeFeature()]} projectKey={PROJECT_KEY} />)
    fireEvent.click(screen.getByRole('button', { name: /vote for dark mode/i }))
    const input = screen.getByPlaceholderText(/your@email.com/i)
    fireEvent.change(input, { target: { value: 'enter@test.com' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(screen.getByText(/check your email/i)).toBeInTheDocument())
  })

  it('vote button disabled after sending', async () => {
    mockApiFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({}) })
    render(<FeaturesTab initialFeatures={[makeFeature()]} projectKey={PROJECT_KEY} />)
    fireEvent.click(screen.getByRole('button', { name: /vote for dark mode/i }))
    fireEvent.change(screen.getByPlaceholderText(/your@email.com/i), { target: { value: 'sent@test.com' } })
    fireEvent.click(screen.getByRole('button', { name: /^vote$/i }))
    await waitFor(() => expect(screen.getByText(/check your email/i)).toBeInTheDocument())
    expect(screen.getByRole('button', { name: /vote for dark mode/i })).toBeDisabled()
  })

  it('increments vote count after successful vote', async () => {
    mockApiFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({}) })
    render(<FeaturesTab initialFeatures={[makeFeature({ voteCount: 5 })]} projectKey={PROJECT_KEY} />)
    fireEvent.click(screen.getByRole('button', { name: /vote for dark mode/i }))
    fireEvent.change(screen.getByPlaceholderText(/your@email.com/i), { target: { value: 'inc@test.com' } })
    fireEvent.click(screen.getByRole('button', { name: /^vote$/i }))
    await waitFor(() => expect(screen.getByText('6')).toBeInTheDocument())
  })

  it('shows validation error for malformed email before calling API', async () => {
    render(<FeaturesTab initialFeatures={[makeFeature()]} projectKey={PROJECT_KEY} />)
    fireEvent.click(screen.getByRole('button', { name: /vote for dark mode/i }))
    fireEvent.change(screen.getByPlaceholderText(/your@email.com/i), { target: { value: 'notanemail' } })
    fireEvent.click(screen.getByRole('button', { name: /^vote$/i }))
    await waitFor(() => expect(screen.getByText(/valid email/i)).toBeInTheDocument())
    expect(mockApiFetch).not.toHaveBeenCalled()
  })

  it('shows error for invalid projectKey without calling API', async () => {
    render(<FeaturesTab initialFeatures={[makeFeature()]} projectKey="bad-key" />)
    fireEvent.click(screen.getByRole('button', { name: /vote for dark mode/i }))
    fireEvent.change(screen.getByPlaceholderText(/your@email.com/i), { target: { value: 'ok@test.com' } })
    fireEvent.click(screen.getByRole('button', { name: /^vote$/i }))
    await waitFor(() => expect(screen.getByText(/invalid project key/i)).toBeInTheDocument())
    expect(mockApiFetch).not.toHaveBeenCalled()
  })

  it('clears email input when cancel is clicked', () => {
    render(<FeaturesTab initialFeatures={[makeFeature()]} projectKey={PROJECT_KEY} />)
    fireEvent.click(screen.getByRole('button', { name: /vote for dark mode/i }))
    fireEvent.change(screen.getByPlaceholderText(/your@email.com/i), { target: { value: 'partial@test.com' } })
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }))
    // re-expand — input should be empty
    fireEvent.click(screen.getByRole('button', { name: /vote for dark mode/i }))
    expect(screen.getByPlaceholderText(/your@email.com/i)).toHaveValue('')
  })
})

// ── Submit new request modal ───────────────────────────────────────────────

describe('FeaturesTab — submit request modal', () => {
  it('opens modal on Submit Request click', () => {
    render(<FeaturesTab initialFeatures={[]} projectKey={PROJECT_KEY} />)
    fireEvent.click(screen.getByRole('button', { name: /submit request/i }))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByLabelText(/title/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument()
  })

  it('closes modal on cancel', () => {
    render(<FeaturesTab initialFeatures={[]} projectKey={PROJECT_KEY} />)
    fireEvent.click(screen.getByRole('button', { name: /submit request/i }))
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('closes modal on backdrop click', () => {
    render(<FeaturesTab initialFeatures={[]} projectKey={PROJECT_KEY} />)
    fireEvent.click(screen.getByRole('button', { name: /submit request/i }))
    fireEvent.click(screen.getByRole('dialog'))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('closes modal on Escape key', () => {
    render(<FeaturesTab initialFeatures={[]} projectKey={PROJECT_KEY} />)
    fireEvent.click(screen.getByRole('button', { name: /submit request/i }))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('shows validation error for whitespace-only title', async () => {
    render(<FeaturesTab initialFeatures={[]} projectKey={PROJECT_KEY} />)
    fireEvent.click(screen.getByRole('button', { name: /submit request/i }))
    fireEvent.change(screen.getByLabelText(/title/i), { target: { value: '   ' } })
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'ok@test.com' } })
    fireEvent.submit(screen.getByRole('dialog').querySelector('form')!)
    await waitFor(() => expect(screen.getByText(/title is required/i)).toBeInTheDocument())
    expect(mockApiFetch).not.toHaveBeenCalled()
  })

  it('shows error for invalid projectKey on submit without calling API', async () => {
    render(<FeaturesTab initialFeatures={[]} projectKey="not-a-uuid" />)
    fireEvent.click(screen.getByRole('button', { name: /submit request/i }))
    fireEvent.change(screen.getByLabelText(/title/i), { target: { value: 'Valid Title' } })
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'ok@test.com' } })
    fireEvent.submit(screen.getByRole('dialog').querySelector('form')!)
    await waitFor(() => expect(screen.getByText(/invalid project configuration/i)).toBeInTheDocument())
    expect(mockApiFetch).not.toHaveBeenCalled()
  })

  it('shows submitted title in success message', async () => {
    const newFeature = makeFeature({ id: 'feat-new', title: 'Unique Export XYZ', voteCount: 0 })
    mockApiFetch.mockResolvedValue({
      ok: true,
      status: 201,
      json: () => Promise.resolve(newFeature),
    })
    render(<FeaturesTab initialFeatures={[]} projectKey={PROJECT_KEY} />)
    fireEvent.click(screen.getByRole('button', { name: /submit request/i }))
    fireEvent.change(screen.getByLabelText(/title/i), { target: { value: 'Unique Export XYZ' } })
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'title@test.com' } })
    fireEvent.submit(screen.getByRole('dialog').querySelector('form')!)
    // match against the green success paragraph specifically
    await waitFor(() =>
      expect(screen.getByText(/unique export xyz.*submitted/i)).toBeInTheDocument()
    )
  })

  it('submits new feature and prepends to list', async () => {
    const newFeature = makeFeature({ id: 'feat-new', title: 'CSV Export', voteCount: 0 })
    mockApiFetch.mockResolvedValue({
      ok: true,
      status: 201,
      json: () => Promise.resolve(newFeature),
    })
    render(<FeaturesTab initialFeatures={[]} projectKey={PROJECT_KEY} />)
    fireEvent.click(screen.getByRole('button', { name: /submit request/i }))
    fireEvent.change(screen.getByLabelText(/title/i), { target: { value: 'CSV Export' } })
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'new@test.com' } })
    fireEvent.submit(screen.getByRole('dialog').querySelector('form')!)
    // success message now includes the submitted title
    await waitFor(() => expect(screen.getByText(/csv export.*submitted/i)).toBeInTheDocument())
    expect(mockApiFetch).toHaveBeenCalledWith(
      `/api/v1/public/${PROJECT_KEY}/features`,
      expect.objectContaining({ method: 'POST' })
    )
  })

  it('shows error from backend on submit failure', async () => {
    mockApiFetch.mockResolvedValue({
      ok: false,
      status: 400,
      json: () => Promise.resolve({ message: 'Title is required' }),
    })
    render(<FeaturesTab initialFeatures={[]} projectKey={PROJECT_KEY} />)
    fireEvent.click(screen.getByRole('button', { name: /submit request/i }))
    fireEvent.change(screen.getByLabelText(/title/i), { target: { value: 'x' } })
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'err@test.com' } })
    fireEvent.submit(screen.getByRole('dialog').querySelector('form')!)
    await waitFor(() => expect(screen.getByText('Title is required')).toBeInTheDocument())
  })

  it('shows network error message on fetch failure', async () => {
    mockApiFetch.mockRejectedValue(new Error('Network error'))
    render(<FeaturesTab initialFeatures={[]} projectKey={PROJECT_KEY} />)
    fireEvent.click(screen.getByRole('button', { name: /submit request/i }))
    fireEvent.change(screen.getByLabelText(/title/i), { target: { value: 'Test' } })
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'net@test.com' } })
    fireEvent.submit(screen.getByRole('dialog').querySelector('form')!)
    await waitFor(() => expect(screen.getByText(/network error/i)).toBeInTheDocument())
  })
})

// ── Pagination ─────────────────────────────────────────────────────────────

describe('FeaturesTab — pagination', () => {
  function makeFeatures(count: number): PublicFeature[] {
    return Array.from({ length: count }, (_, i) =>
      makeFeature({ id: `feat-${i}`, title: `Feature ${i + 1}` })
    )
  }

  it('does not show pagination for 10 or fewer items', () => {
    render(<FeaturesTab initialFeatures={makeFeatures(10)} projectKey={PROJECT_KEY} />)
    expect(screen.queryByRole('button', { name: /previous/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /next/i })).not.toBeInTheDocument()
  })

  it('shows pagination for more than 10 items', () => {
    render(<FeaturesTab initialFeatures={makeFeatures(11)} projectKey={PROJECT_KEY} />)
    expect(screen.getByRole('button', { name: /previous/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /next/i })).toBeInTheDocument()
  })

  it('shows first 10 items on page 1', () => {
    render(<FeaturesTab initialFeatures={makeFeatures(15)} projectKey={PROJECT_KEY} />)
    expect(screen.getByText('Feature 1')).toBeInTheDocument()
    expect(screen.getByText('Feature 10')).toBeInTheDocument()
    expect(screen.queryByText('Feature 11')).not.toBeInTheDocument()
  })

  it('shows page indicator', () => {
    render(<FeaturesTab initialFeatures={makeFeatures(11)} projectKey={PROJECT_KEY} />)
    expect(screen.getByText('Page 1 of 2')).toBeInTheDocument()
  })

  it('previous button disabled on first page', () => {
    render(<FeaturesTab initialFeatures={makeFeatures(11)} projectKey={PROJECT_KEY} />)
    expect(screen.getByRole('button', { name: /previous/i })).toBeDisabled()
  })

  it('navigates to next page', () => {
    render(<FeaturesTab initialFeatures={makeFeatures(11)} projectKey={PROJECT_KEY} />)
    fireEvent.click(screen.getByRole('button', { name: /next/i }))
    expect(screen.getByText('Feature 11')).toBeInTheDocument()
    expect(screen.queryByText('Feature 1')).not.toBeInTheDocument()
    expect(screen.getByText('Page 2 of 2')).toBeInTheDocument()
  })

  it('next button disabled on last page', () => {
    render(<FeaturesTab initialFeatures={makeFeatures(11)} projectKey={PROJECT_KEY} />)
    fireEvent.click(screen.getByRole('button', { name: /next/i }))
    expect(screen.getByRole('button', { name: /next/i })).toBeDisabled()
  })

  it('resets to page 1 after submitting new feature', async () => {
    jest.useFakeTimers()
    const newFeature = makeFeature({ id: 'feat-new', title: 'Brand New Feature', voteCount: 0 })
    mockApiFetch.mockResolvedValue({
      ok: true,
      status: 201,
      json: () => Promise.resolve(newFeature),
    })
    render(<FeaturesTab initialFeatures={makeFeatures(11)} projectKey={PROJECT_KEY} />)
    // navigate to page 2
    fireEvent.click(screen.getByRole('button', { name: /next/i }))
    expect(screen.getByText('Page 2 of 2')).toBeInTheDocument()
    // submit new feature
    fireEvent.click(screen.getByRole('button', { name: /submit request/i }))
    fireEvent.change(screen.getByLabelText(/title/i), { target: { value: 'Brand New Feature' } })
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'pg@test.com' } })
    fireEvent.submit(screen.getByRole('dialog').querySelector('form')!)
    // wait for success state inside modal
    await waitFor(() => expect(screen.getByText(/brand new feature.*submitted/i)).toBeInTheDocument())
    // advance past the 1500ms auto-close timeout
    act(() => { jest.runAllTimers() })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByText(/page 1 of/i)).toBeInTheDocument()
    jest.useRealTimers()
  })
})
