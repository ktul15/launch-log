import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import WidgetSettingsClient from '@/app/(admin)/dashboard/projects/[projectId]/settings/WidgetSettingsClient'
import { apiFetch } from '@/lib/api'
import { DEFAULT_WIDGET_SETTINGS } from '@/types/widget'

jest.mock('@/lib/api', () => ({
  apiFetch: jest.fn(),
}))

const mockApiFetch = jest.mocked(apiFetch)

const DEFAULT_PROPS = {
  projectId: 'proj-1',
  projectName: 'Acme App',
  initialSettings: { ...DEFAULT_WIDGET_SETTINGS },
}

beforeEach(() => {
  jest.clearAllMocks()
})

describe('WidgetSettingsClient — rendering', () => {
  it('renders three tab checkboxes', () => {
    render(<WidgetSettingsClient {...DEFAULT_PROPS} />)
    expect(screen.getByRole('checkbox', { name: 'Changelog' })).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: 'Roadmap' })).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: 'Features' })).toBeInTheDocument()
  })

  it('renders button position select', () => {
    render(<WidgetSettingsClient {...DEFAULT_PROPS} />)
    expect(screen.getByRole('combobox')).toBeInTheDocument()
  })

  it('renders two color inputs', () => {
    render(<WidgetSettingsClient {...DEFAULT_PROPS} />)
    const colorInputs = screen.getAllByDisplayValue(/#[0-9a-fA-F]{6}/)
    expect(colorInputs.length).toBeGreaterThanOrEqual(2)
  })

  it('renders Save settings button', () => {
    render(<WidgetSettingsClient {...DEFAULT_PROPS} />)
    expect(screen.getByRole('button', { name: /save settings/i })).toBeInTheDocument()
  })
})

describe('WidgetSettingsClient — initial state', () => {
  it('reflects initialSettings checkboxes', () => {
    const settings = { ...DEFAULT_WIDGET_SETTINGS, showRoadmap: false }
    render(<WidgetSettingsClient {...DEFAULT_PROPS} initialSettings={settings} />)
    expect(screen.getByRole('checkbox', { name: 'Roadmap' })).not.toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Changelog' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Features' })).toBeChecked()
  })

  it('reflects initialSettings button position in select', () => {
    const settings = { ...DEFAULT_WIDGET_SETTINGS, buttonPosition: 'top-left' as const }
    render(<WidgetSettingsClient {...DEFAULT_PROPS} initialSettings={settings} />)
    expect(screen.getByRole('combobox')).toHaveValue('top-left')
  })
})

describe('WidgetSettingsClient — interactions', () => {
  it('toggling a checkbox updates its state', async () => {
    const user = userEvent.setup()
    render(<WidgetSettingsClient {...DEFAULT_PROPS} />)
    const checkbox = screen.getByRole('checkbox', { name: 'Roadmap' })
    expect(checkbox).toBeChecked()
    await user.click(checkbox)
    expect(checkbox).not.toBeChecked()
  })

  it('changing select updates button position', async () => {
    const user = userEvent.setup()
    render(<WidgetSettingsClient {...DEFAULT_PROPS} />)
    const select = screen.getByRole('combobox')
    await user.selectOptions(select, 'top-right')
    expect(select).toHaveValue('top-right')
  })
})

describe('WidgetSettingsClient — save', () => {
  it('calls PATCH with correct payload on save', async () => {
    const user = userEvent.setup()
    mockApiFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({}) } as Response)

    render(<WidgetSettingsClient {...DEFAULT_PROPS} />)
    await user.click(screen.getByRole('button', { name: /save settings/i }))

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith('/api/v1/projects/proj-1', {
        method: 'PATCH',
        body: JSON.stringify({ widgetSettings: DEFAULT_WIDGET_SETTINGS }),
      })
    })
  })

  it('shows "Settings saved." on successful save', async () => {
    const user = userEvent.setup()
    mockApiFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({}) } as Response)

    render(<WidgetSettingsClient {...DEFAULT_PROPS} />)
    await user.click(screen.getByRole('button', { name: /save settings/i }))

    await waitFor(() => {
      expect(screen.getByText('Settings saved.')).toBeInTheDocument()
    })
  })

  it('shows error message on failed save', async () => {
    const user = userEvent.setup()
    mockApiFetch.mockResolvedValue({
      ok: false,
      json: () => Promise.resolve({ message: 'Server error' }),
    } as Response)

    render(<WidgetSettingsClient {...DEFAULT_PROPS} />)
    await user.click(screen.getByRole('button', { name: /save settings/i }))

    await waitFor(() => {
      expect(screen.getByText('Server error')).toBeInTheDocument()
    })
  })

  it('shows generic error when fetch throws', async () => {
    const user = userEvent.setup()
    mockApiFetch.mockRejectedValue(new Error('Network down'))

    render(<WidgetSettingsClient {...DEFAULT_PROPS} />)
    await user.click(screen.getByRole('button', { name: /save settings/i }))

    await waitFor(() => {
      expect(screen.getByText('Something went wrong. Please try again.')).toBeInTheDocument()
    })
  })

  it('clears "Settings saved." banner after further edits', async () => {
    const user = userEvent.setup()
    mockApiFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({}) } as Response)

    render(<WidgetSettingsClient {...DEFAULT_PROPS} />)
    await user.click(screen.getByRole('button', { name: /save settings/i }))
    await waitFor(() => expect(screen.getByText('Settings saved.')).toBeInTheDocument())

    await user.click(screen.getByRole('checkbox', { name: 'Roadmap' }))
    expect(screen.queryByText('Settings saved.')).not.toBeInTheDocument()
  })

  it('sends modified settings in save payload', async () => {
    const user = userEvent.setup()
    mockApiFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({}) } as Response)

    render(<WidgetSettingsClient {...DEFAULT_PROPS} />)
    await user.click(screen.getByRole('checkbox', { name: 'Roadmap' }))
    await user.click(screen.getByRole('button', { name: /save settings/i }))

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith('/api/v1/projects/proj-1', {
        method: 'PATCH',
        body: JSON.stringify({ widgetSettings: { ...DEFAULT_WIDGET_SETTINGS, showRoadmap: false } }),
      })
    })
  })

  it('disables Save button when all tabs are unchecked', async () => {
    const user = userEvent.setup()
    render(<WidgetSettingsClient {...DEFAULT_PROPS} />)
    await user.click(screen.getByRole('checkbox', { name: 'Changelog' }))
    await user.click(screen.getByRole('checkbox', { name: 'Roadmap' }))
    await user.click(screen.getByRole('checkbox', { name: 'Features' }))
    expect(screen.getByRole('button', { name: /save settings/i })).toBeDisabled()
  })

  it('shows warning when all tabs are unchecked', async () => {
    const user = userEvent.setup()
    render(<WidgetSettingsClient {...DEFAULT_PROPS} />)
    await user.click(screen.getByRole('checkbox', { name: 'Changelog' }))
    await user.click(screen.getByRole('checkbox', { name: 'Roadmap' }))
    await user.click(screen.getByRole('checkbox', { name: 'Features' }))
    expect(screen.getByText(/at least one tab must be enabled/i)).toBeInTheDocument()
  })
})
