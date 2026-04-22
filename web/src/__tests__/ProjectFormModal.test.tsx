import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ProjectFormModal from '@/app/(admin)/dashboard/projects/ProjectFormModal'
import { apiFetch } from '@/lib/api'
import type { Project } from '@/app/(admin)/dashboard/projects/page'

jest.mock('@/lib/api', () => ({
  apiFetch: jest.fn(),
}))

const mockApiFetch = jest.mocked(apiFetch)

const baseProject: Project = {
  id: 'proj-1',
  name: 'Acme App',
  slug: 'acme-app',
  description: null,
  widgetKey: 'wk-uuid',
  createdAt: '2024-01-01T00:00:00.000Z',
  _count: { changelogEntries: 0, roadmapItems: 0 },
}

const noop = jest.fn()

beforeEach(() => {
  jest.clearAllMocks()
  HTMLDialogElement.prototype.showModal = jest.fn(function (this: HTMLDialogElement) {
    this.setAttribute('open', '')
  })
  HTMLDialogElement.prototype.close = jest.fn(function (this: HTMLDialogElement) {
    this.removeAttribute('open')
  })
})

// ─── Create mode ─────────────────────────────────────────────────────────────

describe('ProjectFormModal — create mode', () => {
  it('renders empty name and slug fields', () => {
    render(<ProjectFormModal mode="create" onClose={noop} onSaved={noop} />)
    expect(screen.getByLabelText(/^name$/i)).toHaveValue('')
    expect(screen.getByLabelText(/^slug$/i)).toHaveValue('')
  })

  it('auto-generates slug from name', async () => {
    render(<ProjectFormModal mode="create" onClose={noop} onSaved={noop} />)
    await userEvent.type(screen.getByLabelText(/^name$/i), 'Hello World App')
    expect(screen.getByLabelText(/^slug$/i)).toHaveValue('hello-world-app')
  })

  it('stops auto-generating slug after manual slug edit', async () => {
    render(<ProjectFormModal mode="create" onClose={noop} onSaved={noop} />)
    const nameInput = screen.getByLabelText(/^name$/i)
    const slugInput = screen.getByLabelText(/^slug$/i)

    await userEvent.type(nameInput, 'Hello')
    expect(slugInput).toHaveValue('hello')

    await userEvent.clear(slugInput)
    await userEvent.type(slugInput, 'custom-slug')

    await userEvent.type(nameInput, ' World')
    expect(slugInput).toHaveValue('custom-slug')
  })

  it('submits POST with correct body', async () => {
    const savedProject = { ...baseProject, id: 'new-id' }
    mockApiFetch.mockResolvedValue({
      ok: true,
      json: async () => savedProject,
    } as Response)

    const onSaved = jest.fn()
    render(<ProjectFormModal mode="create" onClose={noop} onSaved={onSaved} />)

    await userEvent.type(screen.getByLabelText(/^name$/i), 'My Project')
    await userEvent.clear(screen.getByLabelText(/^slug$/i))
    await userEvent.type(screen.getByLabelText(/^slug$/i), 'my-project')
    await userEvent.click(screen.getByRole('button', { name: /^create$/i }))

    await waitFor(() => expect(mockApiFetch).toHaveBeenCalledTimes(1))
    expect(mockApiFetch).toHaveBeenCalledWith('/api/v1/projects', {
      method: 'POST',
      body: JSON.stringify({ name: 'My Project', slug: 'my-project' }),
    })
    expect(onSaved).toHaveBeenCalledWith(savedProject)
  })

  it('shows error message on 409 (slug conflict)', async () => {
    mockApiFetch.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ message: 'slug already exists' }),
    } as Response)

    render(<ProjectFormModal mode="create" onClose={noop} onSaved={noop} />)
    await userEvent.type(screen.getByLabelText(/^name$/i), 'My Project')
    await userEvent.click(screen.getByRole('button', { name: /^create$/i }))

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
    expect(screen.getByRole('alert')).toHaveTextContent('A project with this slug already exists.')
  })

  it('shows error message on 403 (plan limit)', async () => {
    mockApiFetch.mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({ message: 'Project limit reached for your plan' }),
    } as Response)

    render(<ProjectFormModal mode="create" onClose={noop} onSaved={noop} />)
    await userEvent.type(screen.getByLabelText(/^name$/i), 'My Project')
    await userEvent.click(screen.getByRole('button', { name: /^create$/i }))

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
    expect(screen.getByRole('alert')).toHaveTextContent('Project limit reached')
  })

  it('shows error message on network failure', async () => {
    mockApiFetch.mockRejectedValue(new Error('Network error'))

    render(<ProjectFormModal mode="create" onClose={noop} onSaved={noop} />)
    await userEvent.type(screen.getByLabelText(/^name$/i), 'My Project')
    await userEvent.click(screen.getByRole('button', { name: /^create$/i }))

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
    expect(screen.getByRole('alert')).toHaveTextContent('Unable to connect')
  })

  it('disables submit button while loading', async () => {
    mockApiFetch.mockReturnValue(new Promise(() => {}))

    render(<ProjectFormModal mode="create" onClose={noop} onSaved={noop} />)
    await userEvent.type(screen.getByLabelText(/^name$/i), 'My Project')
    await userEvent.click(screen.getByRole('button', { name: /^create$/i }))

    expect(screen.getByRole('button', { name: /saving/i })).toBeDisabled()
  })
})

// ─── Edit mode ────────────────────────────────────────────────────────────────

describe('ProjectFormModal — edit mode', () => {
  it('pre-fills name and slug from project prop', () => {
    render(
      <ProjectFormModal mode="edit" project={baseProject} onClose={noop} onSaved={noop} onDeleted={noop} />,
    )
    expect(screen.getByLabelText(/^name$/i)).toHaveValue('Acme App')
    expect(screen.getByLabelText(/^slug$/i)).toHaveValue('acme-app')
  })

  it('does not overwrite slug when name is changed in edit mode', async () => {
    render(
      <ProjectFormModal mode="edit" project={baseProject} onClose={noop} onSaved={noop} onDeleted={noop} />,
    )
    await userEvent.type(screen.getByLabelText(/^name$/i), ' Updated')
    expect(screen.getByLabelText(/^slug$/i)).toHaveValue('acme-app')
  })

  it('shows description field', () => {
    render(
      <ProjectFormModal mode="edit" project={baseProject} onClose={noop} onSaved={noop} onDeleted={noop} />,
    )
    expect(screen.getByLabelText(/description/i)).toBeInTheDocument()
  })

  it('sends PATCH with only changed fields (delta)', async () => {
    const updatedProject = { ...baseProject, name: 'Acme App Updated' }
    mockApiFetch.mockResolvedValue({
      ok: true,
      json: async () => updatedProject,
    } as Response)

    const onSaved = jest.fn()
    render(
      <ProjectFormModal mode="edit" project={baseProject} onClose={noop} onSaved={onSaved} onDeleted={noop} />,
    )

    await userEvent.type(screen.getByLabelText(/^name$/i), ' Updated')
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }))

    await waitFor(() => expect(mockApiFetch).toHaveBeenCalledTimes(1))
    expect(mockApiFetch).toHaveBeenCalledWith(`/api/v1/projects/${baseProject.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ name: 'Acme App Updated' }),
    })
    expect(onSaved).toHaveBeenCalled()
  })

  it('calls onClose immediately when nothing changed', async () => {
    const onClose = jest.fn()
    render(
      <ProjectFormModal mode="edit" project={baseProject} onClose={onClose} onSaved={noop} onDeleted={noop} />,
    )
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }))
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(mockApiFetch).not.toHaveBeenCalled()
  })

  it('shows error message on 409 slug conflict', async () => {
    mockApiFetch.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ message: 'slug already exists' }),
    } as Response)

    render(
      <ProjectFormModal mode="edit" project={baseProject} onClose={noop} onSaved={noop} onDeleted={noop} />,
    )
    await userEvent.clear(screen.getByLabelText(/^slug$/i))
    await userEvent.type(screen.getByLabelText(/^slug$/i), 'other-slug')
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }))

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
    expect(screen.getByRole('alert')).toHaveTextContent('A project with this slug already exists.')
  })

  it('shows delete button', () => {
    render(
      <ProjectFormModal mode="edit" project={baseProject} onClose={noop} onSaved={noop} onDeleted={noop} />,
    )
    expect(screen.getByRole('button', { name: /^delete$/i })).toBeInTheDocument()
  })

  it('requires a second click to confirm delete', async () => {
    render(
      <ProjectFormModal mode="edit" project={baseProject} onClose={noop} onSaved={noop} onDeleted={noop} />,
    )
    await userEvent.click(screen.getByRole('button', { name: /^delete$/i }))
    expect(mockApiFetch).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: /confirm delete/i })).toBeInTheDocument()
  })

  it('sends DELETE and calls onDeleted on confirmed delete', async () => {
    mockApiFetch.mockResolvedValue({ status: 204 } as Response)

    const onDeleted = jest.fn()
    render(
      <ProjectFormModal mode="edit" project={baseProject} onClose={noop} onSaved={noop} onDeleted={onDeleted} />,
    )

    await userEvent.click(screen.getByRole('button', { name: /^delete$/i }))
    await userEvent.click(screen.getByRole('button', { name: /confirm delete/i }))

    await waitFor(() => expect(mockApiFetch).toHaveBeenCalledTimes(1))
    expect(mockApiFetch).toHaveBeenCalledWith(`/api/v1/projects/${baseProject.id}`, {
      method: 'DELETE',
    })
    expect(onDeleted).toHaveBeenCalledWith(baseProject.id)
  })
})
