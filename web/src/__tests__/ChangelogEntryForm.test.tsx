import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ChangelogEntryForm from '@/app/(admin)/dashboard/projects/[projectId]/changelog/ChangelogEntryForm'
import { apiFetch } from '@/lib/api'
import type { ChangelogEntry, TipTapDoc } from '@/types/changelog'

jest.mock('@/lib/api', () => ({ apiFetch: jest.fn() }))

const mockPush = jest.fn()
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}))

const FILLED_DOC: TipTapDoc = { type: 'doc', content: [{ type: 'paragraph' }] }

jest.mock('@/components/RichTextEditor', () =>
  function MockEditor({ onChange }: { onChange: (json: TipTapDoc) => void }) {
    return (
      <button
        data-testid="mock-editor"
        onClick={() => onChange(FILLED_DOC)}
      >
        editor
      </button>
    )
  }
)

const mockApiFetch = jest.mocked(apiFetch)
const PROJECT_ID = 'proj-abc'

function makeEntry(overrides: Partial<ChangelogEntry> = {}): ChangelogEntry {
  return {
    id: 'entry-1',
    projectId: PROJECT_ID,
    title: 'Dark mode',
    content: FILLED_DOC,
    version: 'v1.0.0',
    categoryId: null,
    status: 'draft',
    publishedAt: null,
    createdAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function okMock(body: object = {}) {
  return { ok: true, status: 200, json: () => Promise.resolve(body) } as Response
}

function createdMock(body: object = {}) {
  return { ok: true, status: 201, json: () => Promise.resolve(body) } as Response
}

function errMock(status: number, message: string) {
  return { ok: false, status, json: () => Promise.resolve({ message }) } as Response
}

beforeEach(() => {
  jest.clearAllMocks()
})

// ─── New mode ──────────────────────────────────────────────────────────────────

describe('ChangelogEntryForm — new', () => {
  it('renders title and version inputs', () => {
    render(<ChangelogEntryForm mode="new" projectId={PROJECT_ID} />)
    expect(screen.getByLabelText(/title/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/version/i)).toBeInTheDocument()
  })

  it('shows error when content is empty on submit', async () => {
    const user = userEvent.setup()
    render(<ChangelogEntryForm mode="new" projectId={PROJECT_ID} />)
    await user.type(screen.getByLabelText(/title/i), 'Title')
    await user.click(screen.getByRole('button', { name: /save draft/i }))
    expect(screen.getByText('Content is required.')).toBeInTheDocument()
    expect(mockApiFetch).not.toHaveBeenCalled()
  })

  it('POSTs correct payload on submit', async () => {
    mockApiFetch.mockResolvedValueOnce(createdMock({ id: 'new-entry' }))
    const user = userEvent.setup()

    render(<ChangelogEntryForm mode="new" projectId={PROJECT_ID} />)

    await user.type(screen.getByLabelText(/title/i), 'New feature')
    await user.type(screen.getByLabelText(/version/i), 'v2.0.0')
    await user.click(screen.getByTestId('mock-editor'))
    await user.click(screen.getByRole('button', { name: /save draft/i }))

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith(
        `/api/v1/projects/${PROJECT_ID}/changelog`,
        expect.objectContaining({ method: 'POST' }),
      )
    })
    const body = JSON.parse(mockApiFetch.mock.calls[0][1]?.body as string)
    expect(body.title).toBe('New feature')
    expect(body.version).toBe('v2.0.0')
    expect(body.content).toEqual(FILLED_DOC)
  })

  it('omits version when blank', async () => {
    mockApiFetch.mockResolvedValueOnce(createdMock({ id: 'new-entry' }))
    const user = userEvent.setup()

    render(<ChangelogEntryForm mode="new" projectId={PROJECT_ID} />)
    await user.type(screen.getByLabelText(/title/i), 'Title only')
    await user.click(screen.getByTestId('mock-editor'))
    await user.click(screen.getByRole('button', { name: /save draft/i }))

    await waitFor(() => expect(mockApiFetch).toHaveBeenCalled())
    const body = JSON.parse(mockApiFetch.mock.calls[0][1]?.body as string)
    expect(body.version).toBeUndefined()
  })

  it('redirects to changelog list on success', async () => {
    mockApiFetch.mockResolvedValueOnce(createdMock({ id: 'new-entry' }))
    const user = userEvent.setup()

    render(<ChangelogEntryForm mode="new" projectId={PROJECT_ID} />)
    await user.type(screen.getByLabelText(/title/i), 'Title')
    await user.click(screen.getByTestId('mock-editor'))
    await user.click(screen.getByRole('button', { name: /save draft/i }))

    await waitFor(() =>
      expect(mockPush).toHaveBeenCalledWith(`/dashboard/projects/${PROJECT_ID}/changelog`)
    )
  })

  it('shows API error on failure', async () => {
    mockApiFetch.mockResolvedValueOnce(errMock(422, 'Title is required'))
    const user = userEvent.setup()

    render(<ChangelogEntryForm mode="new" projectId={PROJECT_ID} />)
    await user.type(screen.getByLabelText(/title/i), 'x')
    await user.click(screen.getByTestId('mock-editor'))
    await user.click(screen.getByRole('button', { name: /save draft/i }))

    await waitFor(() => expect(screen.getByText('Title is required')).toBeInTheDocument())
    expect(mockPush).not.toHaveBeenCalled()
  })

  it('maps 403 to friendly message', async () => {
    mockApiFetch.mockResolvedValueOnce(errMock(403, 'Forbidden'))
    const user = userEvent.setup()

    render(<ChangelogEntryForm mode="new" projectId={PROJECT_ID} />)
    await user.type(screen.getByLabelText(/title/i), 'Title')
    await user.click(screen.getByTestId('mock-editor'))
    await user.click(screen.getByRole('button', { name: /save draft/i }))

    await waitFor(() =>
      expect(screen.getByText('You do not have permission to perform this action.')).toBeInTheDocument()
    )
  })

  it('maps 500 to friendly message', async () => {
    mockApiFetch.mockResolvedValueOnce(errMock(500, 'Internal Server Error'))
    const user = userEvent.setup()

    render(<ChangelogEntryForm mode="new" projectId={PROJECT_ID} />)
    await user.type(screen.getByLabelText(/title/i), 'Title')
    await user.click(screen.getByTestId('mock-editor'))
    await user.click(screen.getByRole('button', { name: /save draft/i }))

    await waitFor(() =>
      expect(screen.getByText('Server error. Please try again later.')).toBeInTheDocument()
    )
  })

  it('shows error on network failure', async () => {
    mockApiFetch.mockRejectedValueOnce(new Error('Network error'))
    const user = userEvent.setup()

    render(<ChangelogEntryForm mode="new" projectId={PROJECT_ID} />)
    await user.type(screen.getByLabelText(/title/i), 'Title')
    await user.click(screen.getByTestId('mock-editor'))
    await user.click(screen.getByRole('button', { name: /save draft/i }))

    await waitFor(() =>
      expect(screen.getByText('Something went wrong. Please try again.')).toBeInTheDocument()
    )
    expect(mockPush).not.toHaveBeenCalled()
  })

  it('disables submit button while loading', async () => {
    let resolve!: (v: Response) => void
    mockApiFetch.mockReturnValueOnce(
      new Promise((r) => { resolve = r }) as unknown as Promise<Response>
    )
    const user = userEvent.setup()

    render(<ChangelogEntryForm mode="new" projectId={PROJECT_ID} />)
    await user.type(screen.getByLabelText(/title/i), 'Loading test')
    await user.click(screen.getByTestId('mock-editor'))
    await user.click(screen.getByRole('button', { name: /save draft/i }))

    expect(screen.getByRole('button', { name: /saving/i })).toBeDisabled()
    resolve(createdMock({}))
  })
})

// ─── Edit mode ─────────────────────────────────────────────────────────────────

describe('ChangelogEntryForm — edit', () => {
  it('pre-fills title and version from entry', () => {
    render(<ChangelogEntryForm mode="edit" projectId={PROJECT_ID} entry={makeEntry()} />)
    expect(screen.getByDisplayValue('Dark mode')).toBeInTheDocument()
    expect(screen.getByDisplayValue('v1.0.0')).toBeInTheDocument()
  })

  it('PATCHes correct endpoint on submit', async () => {
    mockApiFetch.mockResolvedValueOnce(okMock({ id: 'entry-1' }))
    const user = userEvent.setup()
    const entry = makeEntry()

    render(<ChangelogEntryForm mode="edit" projectId={PROJECT_ID} entry={entry} />)
    await user.click(screen.getByRole('button', { name: /save draft/i }))

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith(
        `/api/v1/projects/${PROJECT_ID}/changelog/${entry.id}`,
        expect.objectContaining({ method: 'PATCH' }),
      )
    })
  })

  it('only sends changed title in PATCH body', async () => {
    mockApiFetch.mockResolvedValueOnce(okMock({ id: 'entry-1' }))
    const user = userEvent.setup()
    const entry = makeEntry()

    render(<ChangelogEntryForm mode="edit" projectId={PROJECT_ID} entry={entry} />)
    await user.clear(screen.getByLabelText(/title/i))
    await user.type(screen.getByLabelText(/title/i), 'Updated title')
    await user.click(screen.getByRole('button', { name: /save draft/i }))

    await waitFor(() => expect(mockApiFetch).toHaveBeenCalled())
    const body = JSON.parse(mockApiFetch.mock.calls[0][1]?.body as string)
    expect(body.title).toBe('Updated title')
  })

  it('sends updated content when editor fires onChange', async () => {
    mockApiFetch.mockResolvedValueOnce(okMock({ id: 'entry-1' }))
    const user = userEvent.setup()
    const entry = makeEntry()

    render(<ChangelogEntryForm mode="edit" projectId={PROJECT_ID} entry={entry} />)
    await user.click(screen.getByTestId('mock-editor'))
    await user.click(screen.getByRole('button', { name: /save draft/i }))

    await waitFor(() => expect(mockApiFetch).toHaveBeenCalled())
    const body = JSON.parse(mockApiFetch.mock.calls[0][1]?.body as string)
    expect(body.content).toEqual(FILLED_DOC)
  })

  it('redirects to changelog list on success', async () => {
    mockApiFetch.mockResolvedValueOnce(okMock({ id: 'entry-1' }))
    const user = userEvent.setup()

    render(<ChangelogEntryForm mode="edit" projectId={PROJECT_ID} entry={makeEntry()} />)
    await user.click(screen.getByRole('button', { name: /save draft/i }))

    await waitFor(() =>
      expect(mockPush).toHaveBeenCalledWith(`/dashboard/projects/${PROJECT_ID}/changelog`)
    )
  })

  it('shows API error on failure', async () => {
    mockApiFetch.mockResolvedValueOnce(errMock(409, 'Archived entries cannot be edited'))
    const user = userEvent.setup()

    render(<ChangelogEntryForm mode="edit" projectId={PROJECT_ID} entry={makeEntry()} />)
    await user.click(screen.getByRole('button', { name: /save draft/i }))

    await waitFor(() =>
      expect(screen.getByText('Archived entries cannot be edited')).toBeInTheDocument()
    )
  })

  it('shows error on network failure', async () => {
    mockApiFetch.mockRejectedValueOnce(new Error('Network error'))
    const user = userEvent.setup()

    render(<ChangelogEntryForm mode="edit" projectId={PROJECT_ID} entry={makeEntry()} />)
    await user.click(screen.getByRole('button', { name: /save draft/i }))

    await waitFor(() =>
      expect(screen.getByText('Something went wrong. Please try again.')).toBeInTheDocument()
    )
  })
})
