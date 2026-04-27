import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import OnboardingWizard from '@/app/(onboarding)/onboarding/OnboardingWizard'
import { apiFetch } from '@/lib/api'

const mockReplace = jest.fn()

jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mockReplace }),
}))

jest.mock('@/lib/api', () => ({
  apiFetch: jest.fn(),
}))

const mockApiFetch = jest.mocked(apiFetch)

// org response with projectCount=0 — triggers the onboarding wizard (not redirect)
const orgResponse = {
  ok: true,
  status: 200,
  json: async () => ({ id: 'org-1', name: 'Acme Inc', slug: 'acme-inc', projectCount: 0 }),
} as Response

beforeEach(() => {
  jest.clearAllMocks()
})

// ─── Initial load ─────────────────────────────────────────────────────────────

describe('OnboardingWizard — initial load', () => {
  it('shows loading skeleton while org fetch is in-flight', () => {
    mockApiFetch.mockReturnValue(new Promise(() => {}))
    render(<OnboardingWizard />)
    expect(screen.getByTestId('loading-skeleton')).toBeInTheDocument()
  })

  it('pre-fills org name and slug from GET /api/v1/org', async () => {
    mockApiFetch.mockResolvedValue(orgResponse)
    render(<OnboardingWizard />)

    await waitFor(() => expect(screen.getByLabelText(/organisation name/i)).toBeInTheDocument())
    expect(screen.getByLabelText(/organisation name/i)).toHaveValue('Acme Inc')
    expect(screen.getByLabelText(/workspace url/i)).toHaveValue('acme-inc')
  })

  it('shows error message when org fetch throws (network error)', async () => {
    mockApiFetch.mockRejectedValue(new Error('Network error'))
    render(<OnboardingWizard />)

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
    expect(screen.getByRole('alert')).toHaveTextContent('Failed to load')
  })

  it('shows error message when org fetch returns non-OK response', async () => {
    mockApiFetch.mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ message: 'Unauthorized' }),
    } as Response)
    render(<OnboardingWizard />)

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
    expect(screen.getByRole('alert')).toHaveTextContent('Failed to load')
  })

  it('redirects to /dashboard if org already has projects', async () => {
    mockApiFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: 'org-1', name: 'Acme Inc', slug: 'acme-inc', projectCount: 1 }),
    } as Response)
    render(<OnboardingWizard />)

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/dashboard'))
    // Form must never appear — skeleton stays visible during navigation.
    expect(screen.queryByLabelText(/organisation name/i)).not.toBeInTheDocument()
    expect(screen.getByTestId('loading-skeleton')).toBeInTheDocument()
  })

  it('shows step 1 fields after load', async () => {
    mockApiFetch.mockResolvedValue(orgResponse)
    render(<OnboardingWizard />)

    await waitFor(() => expect(screen.getByLabelText(/organisation name/i)).toBeInTheDocument())
    expect(screen.getByLabelText(/workspace url/i)).toBeInTheDocument()
    expect(screen.queryByLabelText(/project name/i)).not.toBeInTheDocument()
  })
})

// ─── Slug auto-generation ─────────────────────────────────────────────────────

describe('OnboardingWizard — slug auto-generation', () => {
  async function renderLoaded() {
    mockApiFetch.mockResolvedValue(orgResponse)
    render(<OnboardingWizard />)
    await waitFor(() => expect(screen.getByLabelText(/organisation name/i)).toBeInTheDocument())
  }

  it('auto-generates org slug from name', async () => {
    await renderLoaded()
    const nameInput = screen.getByLabelText(/organisation name/i)
    await userEvent.clear(nameInput)
    await userEvent.type(nameInput, 'My Company')

    expect(screen.getByLabelText(/workspace url/i)).toHaveValue('my-company')
  })

  it('updates org slug as name changes multiple times', async () => {
    await renderLoaded()
    const nameInput = screen.getByLabelText(/organisation name/i)

    await userEvent.clear(nameInput)
    await userEvent.type(nameInput, 'First Name')
    expect(screen.getByLabelText(/workspace url/i)).toHaveValue('first-name')

    await userEvent.clear(nameInput)
    await userEvent.type(nameInput, 'Second Name')
    expect(screen.getByLabelText(/workspace url/i)).toHaveValue('second-name')
  })

  it('stops auto-generating org slug after manual edit', async () => {
    await renderLoaded()
    const slugInput = screen.getByLabelText(/workspace url/i)
    await userEvent.clear(slugInput)
    await userEvent.type(slugInput, 'custom-slug')

    const nameInput = screen.getByLabelText(/organisation name/i)
    await userEvent.clear(nameInput)
    await userEvent.type(nameInput, 'New Name')

    expect(screen.getByLabelText(/workspace url/i)).toHaveValue('custom-slug')
  })
})

// ─── Step 1: org submission ───────────────────────────────────────────────────

describe('OnboardingWizard — step 1 submission', () => {
  async function renderLoaded() {
    mockApiFetch.mockResolvedValue(orgResponse)
    render(<OnboardingWizard />)
    await waitFor(() => expect(screen.getByLabelText(/organisation name/i)).toBeInTheDocument())
  }

  it('advances to step 2 without PATCH when nothing changed', async () => {
    await renderLoaded()
    await userEvent.click(screen.getByRole('button', { name: /continue/i }))

    await waitFor(() => expect(screen.getByLabelText(/project name/i)).toBeInTheDocument())
    // Only the initial GET org call — no PATCH
    expect(mockApiFetch).toHaveBeenCalledTimes(1)
    expect(mockApiFetch).toHaveBeenCalledWith('/api/v1/org')
  })

  it('sends only slug when only slug manually changes', async () => {
    await renderLoaded()
    const slugInput = screen.getByLabelText(/workspace url/i)
    await userEvent.clear(slugInput)
    await userEvent.type(slugInput, 'new-workspace')

    mockApiFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) } as Response)
    await userEvent.click(screen.getByRole('button', { name: /continue/i }))

    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith(
        '/api/v1/org',
        expect.objectContaining({ method: 'PATCH' }),
      ),
    )
    const patchCall = mockApiFetch.mock.calls.find(
      ([path, init]) => path === '/api/v1/org' && (init as RequestInit)?.method === 'PATCH',
    )
    const body = JSON.parse((patchCall![1] as RequestInit).body as string)
    expect(body).toHaveProperty('slug', 'new-workspace')
    expect(body).not.toHaveProperty('name')
  })

  it('advances to step 2 on successful PATCH', async () => {
    await renderLoaded()
    const nameInput = screen.getByLabelText(/organisation name/i)
    await userEvent.clear(nameInput)
    await userEvent.type(nameInput, 'Updated Name')

    mockApiFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) } as Response)
    await userEvent.click(screen.getByRole('button', { name: /continue/i }))

    await waitFor(() => expect(screen.getByLabelText(/project name/i)).toBeInTheDocument())
    expect(screen.queryByLabelText(/organisation name/i)).not.toBeInTheDocument()
  })

  it('shows error when slug field is empty', async () => {
    await renderLoaded()
    const slugInput = screen.getByLabelText(/workspace url/i)
    await userEvent.clear(slugInput)

    await userEvent.click(screen.getByRole('button', { name: /continue/i }))

    expect(screen.getByRole('alert')).toHaveTextContent('Please enter a workspace URL')
    expect(screen.queryByLabelText(/project name/i)).not.toBeInTheDocument()
  })

  it('shows slug-taken error on 409', async () => {
    await renderLoaded()
    const slugInput = screen.getByLabelText(/workspace url/i)
    await userEvent.clear(slugInput)
    await userEvent.type(slugInput, 'taken-slug')

    mockApiFetch.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ message: 'Slug is already taken' }),
    } as Response)
    await userEvent.click(screen.getByRole('button', { name: /continue/i }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Slug is already taken')
  })

  it('shows generic error on network failure', async () => {
    await renderLoaded()
    const nameInput = screen.getByLabelText(/organisation name/i)
    await userEvent.clear(nameInput)
    await userEvent.type(nameInput, 'Changed')

    mockApiFetch.mockRejectedValue(new Error('Network error'))
    await userEvent.click(screen.getByRole('button', { name: /continue/i }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Unable to connect')
  })

  it('disables button while PATCH is loading', async () => {
    await renderLoaded()
    const nameInput = screen.getByLabelText(/organisation name/i)
    await userEvent.clear(nameInput)
    await userEvent.type(nameInput, 'Changed Name')

    mockApiFetch.mockReturnValue(new Promise(() => {}))
    await userEvent.click(screen.getByRole('button', { name: /continue/i }))

    expect(screen.getByRole('button', { name: /saving/i })).toBeDisabled()
  })
})

// ─── Step 2: project creation ─────────────────────────────────────────────────

describe('OnboardingWizard — step 2', () => {
  // Nothing changed from pre-filled values → no PATCH needed → advance directly
  async function renderAtStep2() {
    mockApiFetch.mockResolvedValue(orgResponse)
    render(<OnboardingWizard />)
    await waitFor(() => expect(screen.getByLabelText(/organisation name/i)).toBeInTheDocument())

    await userEvent.click(screen.getByRole('button', { name: /continue/i }))
    await waitFor(() => expect(screen.getByLabelText(/project name/i)).toBeInTheDocument())
  }

  it('auto-generates project slug from project name', async () => {
    await renderAtStep2()
    await userEvent.type(screen.getByLabelText(/project name/i), 'My Widget')
    expect(screen.getByLabelText(/project slug/i)).toHaveValue('my-widget')
  })

  it('back button returns to step 1 and clears error', async () => {
    await renderAtStep2()
    await userEvent.type(screen.getByLabelText(/project name/i), 'Test')

    mockApiFetch.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ message: 'Slug conflict' }),
    } as Response)
    await userEvent.click(screen.getByRole('button', { name: /create project/i }))
    await screen.findByRole('alert')

    await userEvent.click(screen.getByRole('button', { name: /back/i }))

    expect(screen.getByLabelText(/organisation name/i)).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('shows error when project slug field is empty', async () => {
    await renderAtStep2()
    await userEvent.type(screen.getByLabelText(/project name/i), '!!!')
    // toClientSlug('!!!') = '' — slug field will be empty

    await userEvent.click(screen.getByRole('button', { name: /create project/i }))

    expect(screen.getByRole('alert')).toHaveTextContent('Please enter a project slug')
  })

  it('calls POST /api/v1/projects and redirects to /dashboard on 201', async () => {
    await renderAtStep2()
    mockApiFetch.mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ id: 'proj-1', name: 'My Product', slug: 'my-product', widgetKey: 'wk-1' }),
    } as Response)

    await userEvent.type(screen.getByLabelText(/project name/i), 'My Product')
    await userEvent.click(screen.getByRole('button', { name: /create project/i }))

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/dashboard'))
    expect(mockApiFetch).toHaveBeenCalledWith(
      '/api/v1/projects',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('shows plan limit error on 403', async () => {
    await renderAtStep2()
    mockApiFetch.mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({ message: 'Project limit reached for your plan' }),
    } as Response)

    await userEvent.type(screen.getByLabelText(/project name/i), 'Over Limit')
    await userEvent.click(screen.getByRole('button', { name: /create project/i }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Project limit reached')
  })

  it('shows slug conflict error on 409', async () => {
    await renderAtStep2()
    mockApiFetch.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ message: 'A project with this slug already exists in your organisation' }),
    } as Response)

    await userEvent.type(screen.getByLabelText(/project name/i), 'Taken')
    await userEvent.click(screen.getByRole('button', { name: /create project/i }))

    expect(await screen.findByRole('alert')).toHaveTextContent('slug already exists')
  })

  it('disables button while loading', async () => {
    await renderAtStep2()
    mockApiFetch.mockReturnValue(new Promise(() => {}))

    await userEvent.type(screen.getByLabelText(/project name/i), 'Test')
    await userEvent.click(screen.getByRole('button', { name: /create project/i }))

    expect(screen.getByRole('button', { name: /creating project/i })).toBeDisabled()
  })
})

// ─── Progress indicator ───────────────────────────────────────────────────────

describe('OnboardingWizard — progress indicator', () => {
  it('shows step 1 active and step 2 pending on step 1', async () => {
    mockApiFetch.mockResolvedValue(orgResponse)
    render(<OnboardingWizard />)
    await waitFor(() => expect(screen.getByLabelText(/organisation name/i)).toBeInTheDocument())

    expect(screen.getByText('1')).toBeInTheDocument()
    expect(screen.getByText('2')).toBeInTheDocument()
    expect(screen.queryByText('✓')).not.toBeInTheDocument()
  })

  it('shows checkmark on step 1 circle when on step 2', async () => {
    mockApiFetch.mockResolvedValue(orgResponse)
    render(<OnboardingWizard />)
    await waitFor(() => expect(screen.getByLabelText(/organisation name/i)).toBeInTheDocument())

    await userEvent.click(screen.getByRole('button', { name: /continue/i }))
    await waitFor(() => expect(screen.getByLabelText(/project name/i)).toBeInTheDocument())

    expect(screen.getByText('✓')).toBeInTheDocument()
    expect(screen.queryByText('1')).not.toBeInTheDocument()
  })
})
