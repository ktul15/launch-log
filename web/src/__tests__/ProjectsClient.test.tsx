import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ProjectsClient from '@/app/(admin)/dashboard/projects/ProjectsClient'
import { apiFetch } from '@/lib/api'
import type { Project } from '@/app/(admin)/dashboard/projects/page'

jest.mock('@/lib/api', () => ({
  apiFetch: jest.fn(),
}))

const mockApiFetch = jest.mocked(apiFetch)

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'proj-1',
    name: 'Acme App',
    slug: 'acme-app',
    description: null,
    widgetKey: '11111111-2222-3333-4444-555555555555',
    createdAt: '2024-01-01T00:00:00.000Z',
    _count: { changelogEntries: 3, roadmapItems: 7 },
    ...overrides,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  HTMLDialogElement.prototype.showModal = jest.fn(function (this: HTMLDialogElement) {
    this.setAttribute('open', '')
  })
  HTMLDialogElement.prototype.close = jest.fn(function (this: HTMLDialogElement) {
    this.removeAttribute('open')
  })
})

// ─── Rendering ────────────────────────────────────────────────────────────────

describe('ProjectsClient — rendering', () => {
  it('renders project name, slug, and entry counts', () => {
    render(<ProjectsClient initialProjects={[makeProject()]} />)
    expect(screen.getByText('Acme App')).toBeInTheDocument()
    expect(screen.getByText('acme-app')).toBeInTheDocument()
    // Changelog and roadmap counts
    expect(screen.getAllByText('3').length).toBeGreaterThan(0)
    expect(screen.getAllByText('7').length).toBeGreaterThan(0)
  })

  it('renders truncated widget key', () => {
    render(<ProjectsClient initialProjects={[makeProject()]} />)
    // slice(0, 12) of '11111111-2222-...' = '11111111-222'
    expect(screen.getByText(/11111111-222/)).toBeInTheDocument()
  })

  it('renders empty state when no projects', () => {
    render(<ProjectsClient initialProjects={[]} />)
    expect(screen.getByText(/no projects yet/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /create your first project/i })).toBeInTheDocument()
  })

  it('renders "New project" button', () => {
    render(<ProjectsClient initialProjects={[makeProject()]} />)
    expect(screen.getByRole('button', { name: /new project/i })).toBeInTheDocument()
  })

  it('renders Changelog link with correct href per project', () => {
    render(<ProjectsClient initialProjects={[makeProject({ id: 'proj-abc' })]} />)
    const link = screen.getByRole('link', { name: /changelog/i })
    expect(link).toHaveAttribute('href', '/dashboard/projects/proj-abc/changelog')
  })
})

// ─── Modal open/close ─────────────────────────────────────────────────────────

describe('ProjectsClient — modal open/close', () => {
  it('opens create modal when "New project" button clicked', async () => {
    render(<ProjectsClient initialProjects={[makeProject()]} />)
    await userEvent.click(screen.getByRole('button', { name: /new project/i }))
    expect(screen.getByRole('heading', { name: /new project/i })).toBeInTheDocument()
    expect(screen.getByLabelText(/^name$/i)).toHaveValue('')
  })

  it('opens create modal from empty state button', async () => {
    render(<ProjectsClient initialProjects={[]} />)
    await userEvent.click(screen.getByRole('button', { name: /create your first project/i }))
    expect(screen.getByLabelText(/^name$/i)).toHaveValue('')
  })

  it('opens edit modal with pre-filled data when Edit button clicked', async () => {
    const project = makeProject({ name: 'Acme App', slug: 'acme-app' })
    render(<ProjectsClient initialProjects={[project]} />)
    await userEvent.click(screen.getByRole('button', { name: /^edit$/i }))
    expect(screen.getByLabelText(/^name$/i)).toHaveValue('Acme App')
    expect(screen.getByLabelText(/^slug$/i)).toHaveValue('acme-app')
  })

  it('closes modal when Cancel is clicked', async () => {
    render(<ProjectsClient initialProjects={[makeProject()]} />)
    await userEvent.click(screen.getByRole('button', { name: /new project/i }))
    await userEvent.click(screen.getByRole('button', { name: /^cancel$/i }))
    expect(screen.queryByLabelText(/^name$/i)).not.toBeInTheDocument()
  })
})

// ─── Create flow ──────────────────────────────────────────────────────────────

describe('ProjectsClient — create flow', () => {
  it('appends new project to list on successful create', async () => {
    const newProject = makeProject({ id: 'proj-2', name: 'Beta App', slug: 'beta-app', _count: { changelogEntries: 0, roadmapItems: 0 } })
    mockApiFetch.mockResolvedValue({
      ok: true,
      json: async () => newProject,
    } as Response)

    render(<ProjectsClient initialProjects={[makeProject()]} />)
    await userEvent.click(screen.getByRole('button', { name: /new project/i }))
    await userEvent.type(screen.getByLabelText(/^name$/i), 'Beta App')
    await userEvent.click(screen.getByRole('button', { name: /^create$/i }))

    await waitFor(() => expect(screen.getByText('Beta App')).toBeInTheDocument())
    expect(screen.getByText('Acme App')).toBeInTheDocument()
    // Count cells must render without crash — _count injected even when POST response omits it.
    expect(screen.getAllByText('0').length).toBeGreaterThanOrEqual(2)
  })

  it('shows error in modal on 409 slug conflict', async () => {
    mockApiFetch.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ message: 'slug already exists' }),
    } as Response)

    render(<ProjectsClient initialProjects={[]} />)
    await userEvent.click(screen.getByRole('button', { name: /create your first project/i }))
    await userEvent.type(screen.getByLabelText(/^name$/i), 'Clash')
    await userEvent.click(screen.getByRole('button', { name: /^create$/i }))

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
    expect(screen.getByRole('alert')).toHaveTextContent('A project with this slug already exists.')
  })

  it('shows error in modal on 403 plan limit', async () => {
    mockApiFetch.mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({ message: 'Project limit reached for your plan' }),
    } as Response)

    render(<ProjectsClient initialProjects={[makeProject()]} />)
    await userEvent.click(screen.getByRole('button', { name: /new project/i }))
    await userEvent.type(screen.getByLabelText(/^name$/i), 'One More')
    await userEvent.click(screen.getByRole('button', { name: /^create$/i }))

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
    expect(screen.getByRole('alert')).toHaveTextContent('Project limit reached')
  })
})

// ─── Edit flow ────────────────────────────────────────────────────────────────

describe('ProjectsClient — edit flow', () => {
  it('updates project in list after successful PATCH', async () => {
    const project = makeProject()
    const updated = { ...project, name: 'Acme App Renamed' }
    mockApiFetch.mockResolvedValue({
      ok: true,
      json: async () => updated,
    } as Response)

    render(<ProjectsClient initialProjects={[project]} />)
    await userEvent.click(screen.getByRole('button', { name: /^edit$/i }))
    await userEvent.type(screen.getByLabelText(/^name$/i), ' Renamed')
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }))

    await waitFor(() => expect(screen.getByText('Acme App Renamed')).toBeInTheDocument())
  })

  it('shows error in modal on 409 during edit', async () => {
    mockApiFetch.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ message: 'slug already exists' }),
    } as Response)

    render(<ProjectsClient initialProjects={[makeProject()]} />)
    await userEvent.click(screen.getByRole('button', { name: /^edit$/i }))
    await userEvent.clear(screen.getByLabelText(/^slug$/i))
    await userEvent.type(screen.getByLabelText(/^slug$/i), 'taken-slug')
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }))

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
  })
})

// ─── Delete flow ──────────────────────────────────────────────────────────────

describe('ProjectsClient — delete flow', () => {
  it('removes project from list after confirmed delete', async () => {
    mockApiFetch.mockResolvedValue({ status: 204 } as Response)

    const project = makeProject()
    render(<ProjectsClient initialProjects={[project]} />)
    await userEvent.click(screen.getByRole('button', { name: /^edit$/i }))

    // First click — confirm state
    await userEvent.click(screen.getByRole('button', { name: /^delete$/i }))
    expect(mockApiFetch).not.toHaveBeenCalled()

    // Second click — actual delete
    await userEvent.click(screen.getByRole('button', { name: /confirm delete/i }))

    await waitFor(() => expect(screen.queryByText('Acme App')).not.toBeInTheDocument())
    expect(mockApiFetch).toHaveBeenCalledWith(`/api/v1/projects/${project.id}`, {
      method: 'DELETE',
    })
  })
})
