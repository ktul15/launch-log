import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ChangelogClient from '@/app/(admin)/dashboard/projects/[projectId]/changelog/ChangelogClient'
import { apiFetch } from '@/lib/api'
import type { ChangelogEntry } from '@/types/changelog'

jest.mock('@/lib/api', () => ({
  apiFetch: jest.fn(),
}))

const mockApiFetch = jest.mocked(apiFetch)

const PROJECT_ID = 'proj-1'

function makeEntry(overrides: Partial<ChangelogEntry> = {}): ChangelogEntry {
  return {
    id: 'entry-1',
    projectId: PROJECT_ID,
    title: 'Dark mode support',
    version: 'v1.2.0',
    status: 'draft',
    publishedAt: null,
    createdAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  }
}

const DEFAULT_PROPS = {
  projectId: PROJECT_ID,
  projectName: 'Acme App',
  initialEntries: [],
}

beforeEach(() => {
  jest.clearAllMocks()
})

// ─── Rendering ────────────────────────────────────────────────────────────────

describe('ChangelogClient — rendering', () => {
  it('renders entry title, version, and status badge', () => {
    render(<ChangelogClient {...DEFAULT_PROPS} initialEntries={[makeEntry()]} />)
    expect(screen.getByText('Dark mode support')).toBeInTheDocument()
    expect(screen.getByText('v1.2.0')).toBeInTheDocument()
    expect(screen.getByText('draft')).toBeInTheDocument()
  })

  it('renders — for null version', () => {
    render(<ChangelogClient {...DEFAULT_PROPS} initialEntries={[makeEntry({ version: null })]} />)
    expect(screen.getAllByText('—').length).toBeGreaterThan(0)
  })

  it('renders — for null publishedAt', () => {
    render(<ChangelogClient {...DEFAULT_PROPS} initialEntries={[makeEntry({ publishedAt: null })]} />)
    expect(screen.getAllByText('—').length).toBeGreaterThan(0)
  })

  it('renders published date when present', () => {
    render(
      <ChangelogClient
        {...DEFAULT_PROPS}
        initialEntries={[makeEntry({ status: 'published', publishedAt: '2024-06-15T00:00:00.000Z' })]}
      />,
    )
    expect(screen.getByText(/Jun 15, 2024/)).toBeInTheDocument()
  })

  it('renders empty state when no entries', () => {
    render(<ChangelogClient {...DEFAULT_PROPS} initialEntries={[]} />)
    expect(screen.getByText(/no changelog entries yet/i)).toBeInTheDocument()
  })

  it('renders project name as subtitle', () => {
    render(<ChangelogClient {...DEFAULT_PROPS} />)
    expect(screen.getByText('Acme App')).toBeInTheDocument()
  })

  it('renders Publish button for draft entries', () => {
    render(<ChangelogClient {...DEFAULT_PROPS} initialEntries={[makeEntry({ status: 'draft' })]} />)
    expect(screen.getByRole('button', { name: /^publish$/i })).toBeInTheDocument()
  })

  it('renders Unpublish button for published entries', () => {
    render(
      <ChangelogClient
        {...DEFAULT_PROPS}
        initialEntries={[makeEntry({ status: 'published', publishedAt: '2024-01-01T00:00:00.000Z' })]}
      />,
    )
    expect(screen.getByRole('button', { name: /^unpublish$/i })).toBeInTheDocument()
  })

  it('renders Edit link with correct href for non-archived entry', () => {
    render(<ChangelogClient {...DEFAULT_PROPS} initialEntries={[makeEntry({ id: 'entry-abc' })]} />)
    const editLink = screen.getByRole('link', { name: /^edit$/i })
    expect(editLink).toHaveAttribute('href', `/dashboard/projects/${PROJECT_ID}/changelog/entry-abc/edit`)
  })

  it('renders back link to projects', () => {
    render(<ChangelogClient {...DEFAULT_PROPS} />)
    const backLink = screen.getByRole('link', { name: /← projects/i })
    expect(backLink).toHaveAttribute('href', '/dashboard/projects')
  })

  // Issue 2 fix — archived entries should not have an Edit link
  it('renders disabled Edit label (not link) for archived entries', () => {
    render(
      <ChangelogClient
        {...DEFAULT_PROPS}
        initialEntries={[makeEntry({ status: 'archived' })]}
      />,
    )
    expect(screen.queryByRole('link', { name: /^edit$/i })).not.toBeInTheDocument()
    expect(screen.getByText('Edit')).toBeInTheDocument()
  })

  it('renders neither Publish nor Unpublish button for archived entries', () => {
    render(
      <ChangelogClient
        {...DEFAULT_PROPS}
        initialEntries={[makeEntry({ status: 'archived' })]}
      />,
    )
    expect(screen.queryByRole('button', { name: /^publish$/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^unpublish$/i })).not.toBeInTheDocument()
  })
})

// ─── Publish action ───────────────────────────────────────────────────────────

describe('ChangelogClient — publish', () => {
  it('calls POST publish and updates status to published', async () => {
    const entry = makeEntry({ status: 'draft' })
    mockApiFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ...entry, status: 'published', publishedAt: '2024-06-15T00:00:00.000Z' }),
    } as Response)

    render(<ChangelogClient {...DEFAULT_PROPS} initialEntries={[entry]} />)
    await userEvent.click(screen.getByRole('button', { name: /^publish$/i }))

    expect(mockApiFetch).toHaveBeenCalledWith(
      `/api/v1/projects/${PROJECT_ID}/changelog/entry-1/publish`,
      { method: 'POST' },
    )

    await waitFor(() => {
      expect(screen.getByText('published')).toBeInTheDocument()
    })
    expect(screen.queryByRole('button', { name: /^publish$/i })).not.toBeInTheDocument()
  })

  it('shows error message on publish failure', async () => {
    mockApiFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({ message: 'Server error' }),
    } as Response)

    render(<ChangelogClient {...DEFAULT_PROPS} initialEntries={[makeEntry({ status: 'draft' })]} />)
    await userEvent.click(screen.getByRole('button', { name: /^publish$/i }))

    await waitFor(() => {
      expect(screen.getByText('Server error')).toBeInTheDocument()
    })
  })

  // Issue 10 fix — verify loading state while publish in flight
  it('disables button and shows Publishing… while request is in flight', async () => {
    let resolveRequest!: (v: Partial<Response>) => void
    mockApiFetch.mockReturnValueOnce(
      new Promise((res) => { resolveRequest = res }) as unknown as Promise<Response>,
    )

    render(<ChangelogClient {...DEFAULT_PROPS} initialEntries={[makeEntry({ status: 'draft' })]} />)
    await userEvent.click(screen.getByRole('button', { name: /^publish$/i }))

    expect(screen.getByRole('button', { name: /publishing…/i })).toBeDisabled()

    resolveRequest({ ok: true, json: async () => ({ ...makeEntry(), status: 'published', publishedAt: '2024-06-15T00:00:00.000Z' }) })
    await waitFor(() => expect(screen.queryByRole('button', { name: /publishing…/i })).not.toBeInTheDocument())
  })
})

// ─── Unpublish action ─────────────────────────────────────────────────────────

describe('ChangelogClient — unpublish', () => {
  it('calls POST unpublish and updates status to draft', async () => {
    const entry = makeEntry({ status: 'published', publishedAt: '2024-01-01T00:00:00.000Z' })
    mockApiFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ...entry, status: 'draft', publishedAt: null }),
    } as Response)

    render(<ChangelogClient {...DEFAULT_PROPS} initialEntries={[entry]} />)
    await userEvent.click(screen.getByRole('button', { name: /^unpublish$/i }))

    expect(mockApiFetch).toHaveBeenCalledWith(
      `/api/v1/projects/${PROJECT_ID}/changelog/entry-1/unpublish`,
      { method: 'POST' },
    )

    await waitFor(() => {
      expect(screen.getByText('draft')).toBeInTheDocument()
    })
  })

  // Issue 9 fix — network error for unpublish
  it('shows fallback error message on unpublish network failure', async () => {
    mockApiFetch.mockRejectedValueOnce(new Error('Network error'))

    render(
      <ChangelogClient
        {...DEFAULT_PROPS}
        initialEntries={[makeEntry({ status: 'published', publishedAt: '2024-01-01T00:00:00.000Z' })]}
      />,
    )
    await userEvent.click(screen.getByRole('button', { name: /^unpublish$/i }))

    await waitFor(() => {
      expect(screen.getByText('Something went wrong. Please try again.')).toBeInTheDocument()
    })
  })

  // Issue 10 fix — verify loading state while unpublish in flight
  it('disables button and shows Unpublishing… while request is in flight', async () => {
    let resolveRequest!: (v: Partial<Response>) => void
    mockApiFetch.mockReturnValueOnce(
      new Promise((res) => { resolveRequest = res }) as unknown as Promise<Response>,
    )

    render(
      <ChangelogClient
        {...DEFAULT_PROPS}
        initialEntries={[makeEntry({ status: 'published', publishedAt: '2024-01-01T00:00:00.000Z' })]}
      />,
    )
    await userEvent.click(screen.getByRole('button', { name: /^unpublish$/i }))

    expect(screen.getByRole('button', { name: /unpublishing…/i })).toBeDisabled()

    resolveRequest({ ok: true, json: async () => ({ ...makeEntry(), status: 'draft', publishedAt: null }) })
    await waitFor(() => expect(screen.queryByRole('button', { name: /unpublishing…/i })).not.toBeInTheDocument())
  })
})

// ─── Delete action ────────────────────────────────────────────────────────────

describe('ChangelogClient — delete', () => {
  it('shows Confirm and Cancel on first delete click', async () => {
    render(<ChangelogClient {...DEFAULT_PROPS} initialEntries={[makeEntry()]} />)
    await userEvent.click(screen.getByRole('button', { name: /^delete$/i }))

    expect(screen.getByRole('button', { name: /^confirm$/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^cancel$/i })).toBeInTheDocument()
  })

  it('cancels delete and restores Delete button', async () => {
    render(<ChangelogClient {...DEFAULT_PROPS} initialEntries={[makeEntry()]} />)
    await userEvent.click(screen.getByRole('button', { name: /^delete$/i }))
    await userEvent.click(screen.getByRole('button', { name: /^cancel$/i }))

    expect(screen.getByRole('button', { name: /^delete$/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^confirm$/i })).not.toBeInTheDocument()
  })

  it('calls DELETE and removes row on confirm', async () => {
    mockApiFetch.mockResolvedValueOnce({ ok: true, status: 204 } as Response)

    render(<ChangelogClient {...DEFAULT_PROPS} initialEntries={[makeEntry()]} />)
    await userEvent.click(screen.getByRole('button', { name: /^delete$/i }))
    await userEvent.click(screen.getByRole('button', { name: /^confirm$/i }))

    expect(mockApiFetch).toHaveBeenCalledWith(
      `/api/v1/projects/${PROJECT_ID}/changelog/entry-1`,
      { method: 'DELETE' },
    )

    await waitFor(() => {
      expect(screen.queryByText('Dark mode support')).not.toBeInTheDocument()
    })
  })

  it('shows error and keeps row on delete failure', async () => {
    mockApiFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({ message: 'Delete failed' }),
    } as Response)

    render(<ChangelogClient {...DEFAULT_PROPS} initialEntries={[makeEntry()]} />)
    await userEvent.click(screen.getByRole('button', { name: /^delete$/i }))
    await userEvent.click(screen.getByRole('button', { name: /^confirm$/i }))

    await waitFor(() => {
      expect(screen.getByText('Delete failed')).toBeInTheDocument()
    })
    expect(screen.getByText('Dark mode support')).toBeInTheDocument()
  })

  // Issue 9 fix — network error for delete
  it('shows fallback error message on delete network failure', async () => {
    mockApiFetch.mockRejectedValueOnce(new Error('Network error'))

    render(<ChangelogClient {...DEFAULT_PROPS} initialEntries={[makeEntry()]} />)
    await userEvent.click(screen.getByRole('button', { name: /^delete$/i }))
    await userEvent.click(screen.getByRole('button', { name: /^confirm$/i }))

    await waitFor(() => {
      expect(screen.getByText('Something went wrong. Please try again.')).toBeInTheDocument()
    })
    expect(screen.getByText('Dark mode support')).toBeInTheDocument()
  })

  // Issue 10 fix — verify loading state while delete in flight
  it('disables Confirm button and shows Deleting… while request is in flight', async () => {
    let resolveRequest!: (v: Partial<Response>) => void
    mockApiFetch.mockReturnValueOnce(
      new Promise((res) => { resolveRequest = res }) as unknown as Promise<Response>,
    )

    render(<ChangelogClient {...DEFAULT_PROPS} initialEntries={[makeEntry()]} />)
    await userEvent.click(screen.getByRole('button', { name: /^delete$/i }))
    await userEvent.click(screen.getByRole('button', { name: /^confirm$/i }))

    expect(screen.getByRole('button', { name: /deleting…/i })).toBeDisabled()

    resolveRequest({ ok: true, status: 204 })
    await waitFor(() => expect(screen.queryByText('Dark mode support')).not.toBeInTheDocument())
  })

  // Issue 7 fix — confirm state clears when publish starts on a different row
  it('clears delete confirm when publish action starts on another row', async () => {
    const entryA = makeEntry({ id: 'entry-a', status: 'draft', title: 'Entry A' })
    const entryB = makeEntry({ id: 'entry-b', status: 'draft', title: 'Entry B' })

    let resolvePublish!: (v: Partial<Response>) => void
    mockApiFetch.mockReturnValueOnce(
      new Promise((res) => { resolvePublish = res }) as unknown as Promise<Response>,
    )

    render(<ChangelogClient {...DEFAULT_PROPS} initialEntries={[entryA, entryB]} />)

    const [deleteA] = screen.getAllByRole('button', { name: /^delete$/i })
    await userEvent.click(deleteA)
    expect(screen.getByRole('button', { name: /^confirm$/i })).toBeInTheDocument()

    const [publishB] = screen.getAllByRole('button', { name: /^publish$/i }).filter(
      (btn) => btn.closest('tr')?.textContent?.includes('Entry B'),
    )
    await userEvent.click(publishB)

    expect(screen.queryByRole('button', { name: /^confirm$/i })).not.toBeInTheDocument()

    resolvePublish({ ok: true, json: async () => ({ ...entryB, status: 'published', publishedAt: '2024-06-15T00:00:00.000Z' }) })
    await waitFor(() => expect(screen.queryByRole('button', { name: /publishing…/i })).not.toBeInTheDocument())
  })
})

// ─── Network error handling ───────────────────────────────────────────────────

describe('ChangelogClient — network errors', () => {
  it('shows fallback error message on publish network failure', async () => {
    mockApiFetch.mockRejectedValueOnce(new Error('Network error'))

    render(<ChangelogClient {...DEFAULT_PROPS} initialEntries={[makeEntry({ status: 'draft' })]} />)
    await userEvent.click(screen.getByRole('button', { name: /^publish$/i }))

    await waitFor(() => {
      expect(screen.getByText('Something went wrong. Please try again.')).toBeInTheDocument()
    })
  })
})
