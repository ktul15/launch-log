import { SendResult, SendChangelogEmailOptions } from '../services/emailService'

// Mock resend before any imports so the module factory is evaluated first.
// The mock factory is stable across jest.resetModules() calls — the same
// jest.fn() reference is reused, so mockReset() in beforeEach is reliable.
const mockSend = jest.fn()
jest.mock('resend', () => ({
  Resend: jest.fn().mockImplementation(() => ({
    emails: { send: mockSend },
  })),
}))

type EmailFn = (opts: SendChangelogEmailOptions) => Promise<SendResult>

describe('sendChangelogEmail', () => {
  const opts: SendChangelogEmailOptions = {
    to: 'user@example.com',
    entryTitle: 'v2.0 Released',
    changelogUrl: 'http://localhost:3000/p/acme/changelog',
  }

  beforeEach(() => {
    mockSend.mockReset()
  })

  it('returns { ok: false } when RESEND_API_KEY is not set', async () => {
    const saved = process.env.RESEND_API_KEY
    delete process.env.RESEND_API_KEY

    jest.resetModules()
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { sendChangelogEmail } = require('../services/emailService') as { sendChangelogEmail: EmailFn }

    const result = await sendChangelogEmail(opts)
    expect(result.ok).toBe(false)
    expect((result as { ok: false; error: string }).error).toMatch(/RESEND_API_KEY/)

    if (saved !== undefined) process.env.RESEND_API_KEY = saved
  })

  it('calls client.emails.send with correct arguments', async () => {
    process.env.RESEND_API_KEY = 'test-key'
    jest.resetModules()
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { sendChangelogEmail } = require('../services/emailService') as { sendChangelogEmail: EmailFn }
    mockSend.mockResolvedValue({ data: { id: 'msg-1' } })

    const result = await sendChangelogEmail(opts)

    expect(result.ok).toBe(true)
    expect(mockSend).toHaveBeenCalledTimes(1)
    const callArgs = mockSend.mock.calls[0][0]
    expect(callArgs.to).toBe(opts.to)
    expect(callArgs.subject).toContain(opts.entryTitle)
    expect(callArgs.html).toContain(opts.changelogUrl)
    expect(callArgs.text).toContain(opts.changelogUrl)
  })

  it('returns { ok: false, error } when Resend throws without propagating', async () => {
    process.env.RESEND_API_KEY = 'test-key'
    jest.resetModules()
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { sendChangelogEmail } = require('../services/emailService') as { sendChangelogEmail: EmailFn }
    mockSend.mockRejectedValue(new Error('Rate limit exceeded'))

    const result = await sendChangelogEmail(opts)

    expect(result.ok).toBe(false)
    expect((result as { ok: false; error: string }).error).toBe('Rate limit exceeded')
  })

  it('HTML-escapes entryTitle to prevent XSS in email body', async () => {
    process.env.RESEND_API_KEY = 'test-key'
    jest.resetModules()
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { sendChangelogEmail } = require('../services/emailService') as { sendChangelogEmail: EmailFn }
    mockSend.mockResolvedValue({ data: { id: 'msg-2' } })

    await sendChangelogEmail({
      ...opts,
      entryTitle: '<script>alert(1)</script>',
    })

    const html: string = mockSend.mock.calls[0][0].html
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('HTML-escapes changelogUrl to prevent attribute injection', async () => {
    process.env.RESEND_API_KEY = 'test-key'
    jest.resetModules()
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { sendChangelogEmail } = require('../services/emailService') as { sendChangelogEmail: EmailFn }
    mockSend.mockResolvedValue({ data: { id: 'msg-3' } })

    await sendChangelogEmail({
      ...opts,
      changelogUrl: 'http://localhost:3000/p/bad"onmouseover="evil()/changelog',
    })

    const html: string = mockSend.mock.calls[0][0].html
    expect(html).not.toContain('"onmouseover="')
    expect(html).toContain('&quot;')
  })
})
