import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import RoadmapItemModal from '@/app/(admin)/dashboard/projects/[projectId]/roadmap/RoadmapItemModal'
import { apiFetch } from '@/lib/api'
import type { RoadmapItem } from '@/types/roadmap'

jest.mock('@/lib/api', () => ({
  apiFetch: jest.fn(),
}))

const mockApiFetch = jest.mocked(apiFetch)

const PROJECT_ID = 'proj-1'

function makeItem(overrides: Partial<RoadmapItem> = {}): RoadmapItem {
  return {
    id: 'item-1',
    projectId: PROJECT_ID,
    title: 'Existing item',
    description: 'Some detail',
    status: 'planned',
    displayOrder: 0,
    createdAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  }
}

const onSave = jest.fn()
const onClose = jest.fn()

beforeEach(() => {
  jest.clearAllMocks()
})

// ─── Create mode ──────────────────────────────────────────────────────────────

describe('RoadmapItemModal — create', () => {
  it('renders create heading and Create button', () => {
    render(<RoadmapItemModal projectId={PROJECT_ID} mode="create" onSave={onSave} onClose={onClose} />)
    expect(screen.getByText('New roadmap item')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Create' })).toBeInTheDocument()
  })

  it('Create button disabled when title empty', () => {
    render(<RoadmapItemModal projectId={PROJECT_ID} mode="create" onSave={onSave} onClose={onClose} />)
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled()
  })

  it('POSTs and calls onSave on success', async () => {
    const user = userEvent.setup()
    const created = makeItem({ id: 'new-1', title: 'New feature' })
    mockApiFetch.mockResolvedValueOnce({ ok: true, json: async () => created } as Response)

    render(<RoadmapItemModal projectId={PROJECT_ID} mode="create" onSave={onSave} onClose={onClose} />)
    await user.type(screen.getByPlaceholderText('What are you building?'), 'New feature')
    await user.click(screen.getByRole('button', { name: 'Create' }))

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith(
        `/api/v1/projects/${PROJECT_ID}/roadmap`,
        expect.objectContaining({ method: 'POST', body: expect.stringContaining('New feature') }),
      )
    })
    expect(onSave).toHaveBeenCalledWith(created)
  })

  it('shows API error message', async () => {
    const user = userEvent.setup()
    mockApiFetch.mockResolvedValueOnce({ ok: false, json: async () => ({ message: 'Validation failed' }) } as Response)

    render(<RoadmapItemModal projectId={PROJECT_ID} mode="create" onSave={onSave} onClose={onClose} />)
    await user.type(screen.getByPlaceholderText('What are you building?'), 'Thing')
    await user.click(screen.getByRole('button', { name: 'Create' }))

    await waitFor(() => expect(screen.getByText('Validation failed')).toBeInTheDocument())
    expect(onSave).not.toHaveBeenCalled()
  })

  it('uses initialStatus as default', () => {
    render(<RoadmapItemModal projectId={PROJECT_ID} mode="create" initialStatus="shipped" onSave={onSave} onClose={onClose} />)
    expect(screen.getByRole('combobox')).toHaveValue('shipped')
  })

  it('sends description: null when description field is empty', async () => {
    const user = userEvent.setup()
    mockApiFetch.mockResolvedValueOnce({ ok: true, json: async () => makeItem({ description: null }) } as Response)

    render(<RoadmapItemModal projectId={PROJECT_ID} mode="create" onSave={onSave} onClose={onClose} />)
    await user.type(screen.getByPlaceholderText('What are you building?'), 'No desc item')
    await user.click(screen.getByRole('button', { name: 'Create' }))

    await waitFor(() => expect(mockApiFetch).toHaveBeenCalled())
    const body = JSON.parse(mockApiFetch.mock.calls[0][1]?.body as string)
    expect(body.description).toBeNull()
  })
})

// ─── Edit mode ────────────────────────────────────────────────────────────────

describe('RoadmapItemModal — edit', () => {
  it('renders edit heading and Save button', () => {
    render(<RoadmapItemModal projectId={PROJECT_ID} mode="edit" item={makeItem()} onSave={onSave} onClose={onClose} />)
    expect(screen.getByText('Edit roadmap item')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument()
  })

  it('pre-fills title and description from item', () => {
    render(<RoadmapItemModal projectId={PROJECT_ID} mode="edit" item={makeItem()} onSave={onSave} onClose={onClose} />)
    expect(screen.getByDisplayValue('Existing item')).toBeInTheDocument()
    expect(screen.getByDisplayValue('Some detail')).toBeInTheDocument()
  })

  it('PATCHes and calls onSave on success', async () => {
    const user = userEvent.setup()
    const item = makeItem()
    const updated = makeItem({ title: 'Updated title' })
    mockApiFetch.mockResolvedValueOnce({ ok: true, json: async () => updated } as Response)

    render(<RoadmapItemModal projectId={PROJECT_ID} mode="edit" item={item} onSave={onSave} onClose={onClose} />)
    const titleInput = screen.getByDisplayValue('Existing item')
    await user.clear(titleInput)
    await user.type(titleInput, 'Updated title')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith(
        `/api/v1/projects/${PROJECT_ID}/roadmap/${item.id}`,
        expect.objectContaining({ method: 'PATCH' }),
      )
    })
    expect(onSave).toHaveBeenCalledWith(updated)
  })

  it('sends description: null when description cleared in edit mode', async () => {
    const user = userEvent.setup()
    const item = makeItem({ description: 'Old description' })
    mockApiFetch.mockResolvedValueOnce({ ok: true, json: async () => makeItem({ description: null }) } as Response)

    render(<RoadmapItemModal projectId={PROJECT_ID} mode="edit" item={item} onSave={onSave} onClose={onClose} />)
    await user.clear(screen.getByDisplayValue('Old description'))
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(mockApiFetch).toHaveBeenCalled())
    const body = JSON.parse(mockApiFetch.mock.calls[0][1]?.body as string)
    expect(body.description).toBeNull()
  })
})

// ─── Accessibility ────────────────────────────────────────────────────────────

describe('RoadmapItemModal — accessibility', () => {
  it('has role=dialog with aria-modal', () => {
    render(<RoadmapItemModal projectId={PROJECT_ID} mode="create" onSave={onSave} onClose={onClose} />)
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-modal', 'true')
  })

  it('labels are programmatically associated with inputs via htmlFor/id', () => {
    render(<RoadmapItemModal projectId={PROJECT_ID} mode="create" onSave={onSave} onClose={onClose} />)
    expect(screen.getByLabelText('Title')).toBeInTheDocument()
    expect(screen.getByLabelText('Description')).toBeInTheDocument()
    expect(screen.getByLabelText('Status')).toBeInTheDocument()
  })

  it('closes on Escape key', async () => {
    const user = userEvent.setup()
    render(<RoadmapItemModal projectId={PROJECT_ID} mode="create" onSave={onSave} onClose={onClose} />)
    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalled()
  })
})

// ─── Close behaviour ──────────────────────────────────────────────────────────

describe('RoadmapItemModal — close', () => {
  it('calls onClose when Cancel clicked', async () => {
    const user = userEvent.setup()
    render(<RoadmapItemModal projectId={PROJECT_ID} mode="create" onSave={onSave} onClose={onClose} />)
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onClose).toHaveBeenCalled()
  })

  it('calls onClose when backdrop clicked', async () => {
    const user = userEvent.setup()
    const { container } = render(
      <RoadmapItemModal projectId={PROJECT_ID} mode="create" onSave={onSave} onClose={onClose} />,
    )
    await user.click(container.firstElementChild as Element)
    expect(onClose).toHaveBeenCalled()
  })
})
