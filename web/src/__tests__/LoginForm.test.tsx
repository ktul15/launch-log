import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import LoginForm from '@/app/(admin)/login/LoginForm'
import { apiFetch } from '@/lib/api'

const mockPush = jest.fn()
const mockReplace = jest.fn()

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, replace: mockReplace }),
}))

jest.mock('@/lib/api', () => ({
  apiFetch: jest.fn(),
  API_BASE: 'http://localhost:3001',
}))

const mockApiFetch = jest.mocked(apiFetch)

beforeEach(() => {
  jest.clearAllMocks()
})

describe('LoginForm', () => {
  it('renders email field, password field, and submit button', () => {
    render(<LoginForm />)
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/password/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /sign in/i })).toBeInTheDocument()
  })

  it('renders Google Sign-In link pointing to the backend', () => {
    render(<LoginForm />)
    const link = screen.getByRole('link', { name: /sign in with google/i })
    expect(link).toHaveAttribute('href', 'http://localhost:3001/api/v1/auth/google')
  })

  it('redirects to /dashboard on successful login', async () => {
    mockApiFetch.mockResolvedValue({ ok: true, status: 200 } as Response)

    render(<LoginForm />)
    await userEvent.type(screen.getByLabelText(/email/i), 'user@example.com')
    await userEvent.type(screen.getByLabelText(/password/i), 'password123')
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }))

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/dashboard'))
  })

  it('shows error message on 401 response', async () => {
    mockApiFetch.mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ message: 'Invalid credentials' }),
    } as Response)

    render(<LoginForm />)
    await userEvent.type(screen.getByLabelText(/email/i), 'bad@example.com')
    await userEvent.type(screen.getByLabelText(/password/i), 'wrongpass')
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid credentials')
    expect(mockReplace).not.toHaveBeenCalled()
  })

  it('shows generic error message when fetch throws', async () => {
    mockApiFetch.mockRejectedValue(new Error('Network error'))

    render(<LoginForm />)
    await userEvent.type(screen.getByLabelText(/email/i), 'user@example.com')
    await userEvent.type(screen.getByLabelText(/password/i), 'password123')
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Unable to connect')
    expect(mockReplace).not.toHaveBeenCalled()
  })
})
