import { SendResult, SendChangelogEmailOptions, SendSubscribeVerificationEmailOptions } from '../services/emailService'

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
    unsubscribeUrl: 'http://localhost:3001/api/v1/public/unsubscribe?token=tok-1',
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

  it('includes unsubscribeUrl in html and text body', async () => {
    process.env.RESEND_API_KEY = 'test-key'
    jest.resetModules()
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { sendChangelogEmail } = require('../services/emailService') as { sendChangelogEmail: EmailFn }
    mockSend.mockResolvedValue({ data: { id: 'msg-unsub' } })

    await sendChangelogEmail(opts)

    const callArgs = mockSend.mock.calls[0][0]
    expect(callArgs.html).toContain(opts.unsubscribeUrl)
    expect(callArgs.text).toContain(opts.unsubscribeUrl)
  })
})

describe('sendSubscribeVerificationEmail', () => {
  type SubEmailFn = (opts: SendSubscribeVerificationEmailOptions) => Promise<SendResult>

  const opts: SendSubscribeVerificationEmailOptions = {
    to: 'user@example.com',
    projectName: 'Acme App',
    verifyUrl: 'http://localhost:3001/api/v1/public/verify-subscribe?token=tok-abc',
    unsubscribeUrl: 'http://localhost:3001/api/v1/public/unsubscribe?token=tok-abc',
  }

  beforeEach(() => {
    mockSend.mockReset()
  })

  it('returns { ok: false } when RESEND_API_KEY is not set', async () => {
    const saved = process.env.RESEND_API_KEY
    delete process.env.RESEND_API_KEY

    jest.resetModules()
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { sendSubscribeVerificationEmail } = require('../services/emailService') as { sendSubscribeVerificationEmail: SubEmailFn }

    const result = await sendSubscribeVerificationEmail(opts)
    expect(result.ok).toBe(false)
    expect((result as { ok: false; error: string }).error).toMatch(/RESEND_API_KEY/)

    if (saved !== undefined) process.env.RESEND_API_KEY = saved
  })

  it('sends email with verifyUrl and unsubscribeUrl in html and text', async () => {
    process.env.RESEND_API_KEY = 'test-key'
    jest.resetModules()
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { sendSubscribeVerificationEmail } = require('../services/emailService') as { sendSubscribeVerificationEmail: SubEmailFn }
    mockSend.mockResolvedValue({ data: { id: 'msg-sub-1' } })

    const result = await sendSubscribeVerificationEmail(opts)

    expect(result.ok).toBe(true)
    const callArgs = mockSend.mock.calls[0][0]
    expect(callArgs.to).toBe(opts.to)
    expect(callArgs.subject).toContain(opts.projectName)
    expect(callArgs.html).toContain(opts.verifyUrl)
    expect(callArgs.html).toContain(opts.unsubscribeUrl)
    expect(callArgs.text).toContain(opts.verifyUrl)
    expect(callArgs.text).toContain(opts.unsubscribeUrl)
  })

  it('HTML-escapes projectName to prevent XSS', async () => {
    process.env.RESEND_API_KEY = 'test-key'
    jest.resetModules()
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { sendSubscribeVerificationEmail } = require('../services/emailService') as { sendSubscribeVerificationEmail: SubEmailFn }
    mockSend.mockResolvedValue({ data: { id: 'msg-sub-2' } })

    await sendSubscribeVerificationEmail({
      ...opts,
      projectName: '<script>evil()</script>',
    })

    const html: string = mockSend.mock.calls[0][0].html
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('returns { ok: false, error } when Resend throws', async () => {
    process.env.RESEND_API_KEY = 'test-key'
    jest.resetModules()
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { sendSubscribeVerificationEmail } = require('../services/emailService') as { sendSubscribeVerificationEmail: SubEmailFn }
    mockSend.mockRejectedValue(new Error('Rate limit exceeded'))

    const result = await sendSubscribeVerificationEmail(opts)
    expect(result.ok).toBe(false)
    expect((result as { ok: false; error: string }).error).toBe('Rate limit exceeded')
  })

  it('HTML-escapes verifyUrl and unsubscribeUrl to prevent attribute injection', async () => {
    process.env.RESEND_API_KEY = 'test-key'
    jest.resetModules()
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { sendSubscribeVerificationEmail } = require('../services/emailService') as { sendSubscribeVerificationEmail: SubEmailFn }
    mockSend.mockResolvedValue({ data: { id: 'msg-sub-3' } })

    await sendSubscribeVerificationEmail({
      ...opts,
      verifyUrl: 'http://localhost:3000/verify/subscribe?token=tok"onmouseover="evil()',
      unsubscribeUrl: 'http://localhost:3000/unsubscribe?token=tok"onmouseover="evil()',
    })

    const html: string = mockSend.mock.calls[0][0].html
    expect(html).not.toContain('"onmouseover="')
    expect(html).toContain('&quot;')
  })
})
