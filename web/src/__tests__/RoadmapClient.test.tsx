import { render, screen, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import RoadmapClient from '@/app/(admin)/dashboard/projects/[projectId]/roadmap/RoadmapClient'
import { apiFetch } from '@/lib/api'
import type { RoadmapItem } from '@/types/roadmap'

jest.mock('@/lib/api', () => ({
  apiFetch: jest.fn(),
}))

const mockDndHandlers: { onDragEnd?: (event: any) => void } = {}

jest.mock('@dnd-kit/core', () => {
  const actual = jest.requireActual('@dnd-kit/core')
  return {
    ...actual,
    DndContext: ({ children, onDragEnd }: { children: React.ReactNode; onDragEnd?: (e: any) => void }) => {
      mockDndHandlers.onDragEnd = onDragEnd
      return <>{children}</>
    },
    DragOverlay: () => null,
  }
})

jest.mock('@dnd-kit/sortable', () => {
  const actual = jest.requireActual('@dnd-kit/sortable')
  return {
    ...actual,
    useSortable: () => ({
      attributes: {},
      listeners: {},
      setNodeRef: jest.fn(),
      transform: null,
      transition: undefined,
      isDragging: false,
    }),
    CSS: { Transform: { toString: () => '' } },
  }
})

const mockApiFetch = jest.mocked(apiFetch)

const PROJECT_ID = 'proj-1'

function makeItem(overrides: Partial<RoadmapItem> = {}): RoadmapItem {
  return {
    id: 'item-1',
    projectId: PROJECT_ID,
    title: 'Dark mode',
    description: null,
    status: 'planned',
    displayOrder: 0,
    createdAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  }
}

const DEFAULT_PROPS = {
  projectId: PROJECT_ID,
  projectName: 'Acme App',
  initialItems: [],
}

beforeEach(() => {
  jest.clearAllMocks()
  mockDndHandlers.onDragEnd = undefined
})

// ─── Rendering ────────────────────────────────────────────────────────────────

describe('RoadmapClient — rendering', () => {
  it('renders three column headers', () => {
    render(<RoadmapClient {...DEFAULT_PROPS} />)
    expect(screen.getByText('Planned')).toBeInTheDocument()
    expect(screen.getByText('In Progress')).toBeInTheDocument()
    expect(screen.getByText('Shipped')).toBeInTheDocument()
  })

  it('renders items in correct columns', () => {
    const items = [
      makeItem({ id: 'a', title: 'Alpha', status: 'planned', displayOrder: 0 }),
      makeItem({ id: 'b', title: 'Beta', status: 'in_progress', displayOrder: 1 }),
      makeItem({ id: 'c', title: 'Gamma', status: 'shipped', displayOrder: 2 }),
    ]
    render(<RoadmapClient {...DEFAULT_PROPS} initialItems={items} />)
    expect(screen.getByText('Alpha')).toBeInTheDocument()
    expect(screen.getByText('Beta')).toBeInTheDocument()
    expect(screen.getByText('Gamma')).toBeInTheDocument()
  })

  it('renders item description when present', () => {
    render(<RoadmapClient {...DEFAULT_PROPS} initialItems={[makeItem({ description: 'Some detail' })]} />)
    expect(screen.getByText('Some detail')).toBeInTheDocument()
  })

  it('renders Add item button for each column', () => {
    render(<RoadmapClient {...DEFAULT_PROPS} />)
    expect(screen.getAllByText('+ Add item')).toHaveLength(3)
  })

  it('renders empty state when no items', () => {
    render(<RoadmapClient {...DEFAULT_PROPS} />)
    expect(screen.getByText(/no roadmap items yet/i)).toBeInTheDocument()
  })

  it('renders project name in header', () => {
    render(<RoadmapClient {...DEFAULT_PROPS} />)
    expect(screen.getByText('Acme App')).toBeInTheDocument()
  })

  it('renders column item count badges', () => {
    const items = [
      makeItem({ id: 'a', status: 'planned' }),
      makeItem({ id: 'b', status: 'planned', displayOrder: 1 }),
    ]
    render(<RoadmapClient {...DEFAULT_PROPS} initialItems={items} />)
    expect(screen.getAllByText('2').length).toBeGreaterThan(0)
  })
})

// ─── Create item ──────────────────────────────────────────────────────────────

describe('RoadmapClient — create item', () => {
  it('opens modal on "+ Add item" click', async () => {
    const user = userEvent.setup()
    render(<RoadmapClient {...DEFAULT_PROPS} />)
    await user.click(screen.getAllByText('+ Add item')[0])
    expect(screen.getByText('New roadmap item')).toBeInTheDocument()
  })

  it('POSTs new item and adds it to the column', async () => {
    const user = userEvent.setup()
    const newItem = makeItem({ id: 'new-1', title: 'Accessibility', status: 'planned' })
    mockApiFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => newItem,
    } as Response)

    render(<RoadmapClient {...DEFAULT_PROPS} />)
    await user.click(screen.getAllByText('+ Add item')[0])
    await user.type(screen.getByPlaceholderText('What are you building?'), 'Accessibility')
    await user.click(screen.getByRole('button', { name: 'Create' }))

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith(
        `/api/v1/projects/${PROJECT_ID}/roadmap`,
        expect.objectContaining({ method: 'POST' }),
      )
    })
    expect(screen.getByText('Accessibility')).toBeInTheDocument()
  })

  it('shows error when POST fails', async () => {
    const user = userEvent.setup()
    mockApiFetch.mockResolvedValueOnce({
      ok: false,
      json: async () => ({ message: 'Plan limit reached' }),
    } as Response)

    render(<RoadmapClient {...DEFAULT_PROPS} />)
    await user.click(screen.getAllByText('+ Add item')[0])
    await user.type(screen.getByPlaceholderText('What are you building?'), 'New thing')
    await user.click(screen.getByRole('button', { name: 'Create' }))

    await waitFor(() => expect(screen.getByText('Plan limit reached')).toBeInTheDocument())
  })
})

// ─── Edit item ────────────────────────────────────────────────────────────────

describe('RoadmapClient — edit item', () => {
  it('opens edit modal with pre-filled title', async () => {
    const user = userEvent.setup()
    render(<RoadmapClient {...DEFAULT_PROPS} initialItems={[makeItem({ title: 'Original title' })]} />)
    await user.click(screen.getByRole('button', { name: 'Edit' }))
    expect(screen.getByText('Edit roadmap item')).toBeInTheDocument()
    expect(screen.getByDisplayValue('Original title')).toBeInTheDocument()
  })

  it('PATCHes item and updates it in the column', async () => {
    const user = userEvent.setup()
    const item = makeItem({ title: 'Old title' })
    const updated = makeItem({ title: 'New title' })
    mockApiFetch.mockResolvedValueOnce({ ok: true, json: async () => updated } as Response)

    render(<RoadmapClient {...DEFAULT_PROPS} initialItems={[item]} />)
    await user.click(screen.getByRole('button', { name: 'Edit' }))

    const titleInput = screen.getByDisplayValue('Old title')
    await user.clear(titleInput)
    await user.type(titleInput, 'New title')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith(
        `/api/v1/projects/${PROJECT_ID}/roadmap/${item.id}`,
        expect.objectContaining({ method: 'PATCH' }),
      )
    })
    expect(screen.getByText('New title')).toBeInTheDocument()
  })
})

// ─── Delete item ──────────────────────────────────────────────────────────────

describe('RoadmapClient — delete item', () => {
  it('shows confirm/cancel on first delete click', async () => {
    const user = userEvent.setup()
    render(<RoadmapClient {...DEFAULT_PROPS} initialItems={[makeItem()]} />)
    await user.click(screen.getByRole('button', { name: 'Delete' }))
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument()
  })

  it('DELETEs and removes item on confirm', async () => {
    const user = userEvent.setup()
    mockApiFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) } as Response)

    render(<RoadmapClient {...DEFAULT_PROPS} initialItems={[makeItem({ title: 'To remove' })]} />)
    await user.click(screen.getByRole('button', { name: 'Delete' }))
    await user.click(screen.getByRole('button', { name: 'Confirm' }))

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith(
        `/api/v1/projects/${PROJECT_ID}/roadmap/item-1`,
        expect.objectContaining({ method: 'DELETE' }),
      )
    })
    expect(screen.queryByText('To remove')).not.toBeInTheDocument()
  })

  it('restores delete button on cancel', async () => {
    const user = userEvent.setup()
    render(<RoadmapClient {...DEFAULT_PROPS} initialItems={[makeItem()]} />)
    await user.click(screen.getByRole('button', { name: 'Delete' }))
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument()
  })

  it('shows error when DELETE fails', async () => {
    const user = userEvent.setup()
    mockApiFetch.mockResolvedValueOnce({
      ok: false,
      json: async () => ({ message: 'Not found' }),
    } as Response)

    render(<RoadmapClient {...DEFAULT_PROPS} initialItems={[makeItem()]} />)
    await user.click(screen.getByRole('button', { name: 'Delete' }))
    await user.click(screen.getByRole('button', { name: 'Confirm' }))

    await waitFor(() => expect(screen.getByText('Not found')).toBeInTheDocument())
  })
})

// ─── Drag to reorder ──────────────────────────────────────────────────────────

describe('RoadmapClient — drag to reorder', () => {
  it('calls reorder PATCH after within-column drag', async () => {
    const items = [
      makeItem({ id: 'item-1', title: 'Alpha', status: 'planned', displayOrder: 0 }),
      makeItem({ id: 'item-2', title: 'Beta', status: 'planned', displayOrder: 1 }),
    ]
    mockApiFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ updated: 2 }),
    } as Response)

    render(<RoadmapClient {...DEFAULT_PROPS} initialItems={items} />)

    await act(async () => {
      await mockDndHandlers.onDragEnd?.({ active: { id: 'item-2' }, over: { id: 'item-1' } })
    })

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith(
        `/api/v1/projects/${PROJECT_ID}/roadmap/reorder`,
        expect.objectContaining({ method: 'PATCH' }),
      )
    })
    // No status PATCH for same-column drag
    expect(mockApiFetch).toHaveBeenCalledTimes(1)
  })

  it('calls status PATCH then reorder for cross-column drag', async () => {
    const items = [
      makeItem({ id: 'item-1', title: 'Alpha', status: 'planned', displayOrder: 0 }),
      makeItem({ id: 'item-2', title: 'Beta', status: 'in_progress', displayOrder: 1 }),
    ]
    mockApiFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) } as Response)        // status PATCH
      .mockResolvedValueOnce({ ok: true, json: async () => ({ updated: 2 }) } as Response) // reorder

    render(<RoadmapClient {...DEFAULT_PROPS} initialItems={items} />)

    await act(async () => {
      await mockDndHandlers.onDragEnd?.({ active: { id: 'item-1' }, over: { id: 'in_progress' } })
    })

    await waitFor(() => expect(mockApiFetch).toHaveBeenCalledTimes(2))

    const calls = mockApiFetch.mock.calls
    // First: status update
    expect(calls[0][0]).toContain('/roadmap/item-1')
    expect(JSON.parse(calls[0][1].body as string)).toMatchObject({ status: 'in_progress' })
    // Second: reorder
    expect(calls[1][0]).toContain('/roadmap/reorder')
  })

  it('reverts columns and shows error when reorder PATCH fails', async () => {
    const items = [
      makeItem({ id: 'item-1', title: 'Alpha', status: 'planned', displayOrder: 0 }),
      makeItem({ id: 'item-2', title: 'Beta', status: 'planned', displayOrder: 1 }),
    ]
    mockApiFetch.mockResolvedValueOnce({
      ok: false,
      json: async () => ({ message: 'Server error' }),
    } as Response)

    render(<RoadmapClient {...DEFAULT_PROPS} initialItems={items} />)

    await act(async () => {
      await mockDndHandlers.onDragEnd?.({ active: { id: 'item-2' }, over: { id: 'item-1' } })
    })

    await waitFor(() => expect(screen.getByText('Server error')).toBeInTheDocument())
  })

  it('aborts cross-column drag when status PATCH fails, no reorder sent', async () => {
    const items = [
      makeItem({ id: 'item-1', title: 'Alpha', status: 'planned', displayOrder: 0 }),
    ]
    mockApiFetch.mockResolvedValueOnce({
      ok: false,
      json: async () => ({ message: 'Forbidden' }),
    } as Response)

    render(<RoadmapClient {...DEFAULT_PROPS} initialItems={items} />)

    await act(async () => {
      await mockDndHandlers.onDragEnd?.({ active: { id: 'item-1' }, over: { id: 'in_progress' } })
    })

    await waitFor(() => expect(screen.getByText('Forbidden')).toBeInTheDocument())
    // Reorder should NOT have been called
    expect(mockApiFetch).toHaveBeenCalledTimes(1)
    expect(mockApiFetch).not.toHaveBeenCalledWith(
      expect.stringContaining('/roadmap/reorder'),
      expect.anything(),
    )
  })

  it('skips API calls for no-op drag (item dropped on itself)', async () => {
    const items = [makeItem({ id: 'item-1', status: 'planned', displayOrder: 0 })]
    render(<RoadmapClient {...DEFAULT_PROPS} initialItems={items} />)

    await act(async () => {
      await mockDndHandlers.onDragEnd?.({ active: { id: 'item-1' }, over: { id: 'item-1' } })
    })

    expect(mockApiFetch).not.toHaveBeenCalled()
  })
})

// ─── Error banner ─────────────────────────────────────────────────────────────

describe('RoadmapClient — error banner', () => {
  it('dismisses error banner on ✕ click', async () => {
    const user = userEvent.setup()
    mockApiFetch.mockResolvedValueOnce({
      ok: false,
      json: async () => ({ message: 'Oops' }),
    } as Response)

    render(<RoadmapClient {...DEFAULT_PROPS} initialItems={[makeItem()]} />)
    await user.click(screen.getByRole('button', { name: 'Delete' }))
    await user.click(screen.getByRole('button', { name: 'Confirm' }))

    await waitFor(() => expect(screen.getByText('Oops')).toBeInTheDocument())
    await user.click(screen.getByRole('button', { name: 'Dismiss error' }))
    expect(screen.queryByText('Oops')).not.toBeInTheDocument()
  })
})

// ─── Modal close ──────────────────────────────────────────────────────────────

describe('RoadmapClient — modal close', () => {
  it('closes modal on Cancel click', async () => {
    const user = userEvent.setup()
    render(<RoadmapClient {...DEFAULT_PROPS} />)
    await user.click(screen.getAllByText('+ Add item')[0])
    expect(screen.getByText('New roadmap item')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByText('New roadmap item')).not.toBeInTheDocument()
  })
})
