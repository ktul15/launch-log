import type { NextRequest } from 'next/server'
import { middleware, config } from '@/middleware'

// AbortSignal.timeout is unavailable in jsdom — polyfill so the refresh path is exercisable.
if (typeof (AbortSignal as { timeout?: unknown }).timeout !== 'function') {
  ;(AbortSignal as unknown as { timeout: (ms: number) => AbortSignal }).timeout = (ms) => {
    const ac = new AbortController()
    setTimeout(() => ac.abort(), ms)
    return ac.signal
  }
}

const mockNextResponse = {
  next: jest.fn(),
  redirect: jest.fn(),
}

type CookieSpy = { name: string; value: string; opts: unknown }

function makeNextResponse() {
  const cookiesSet: CookieSpy[] = []
  return {
    headers: new Headers(),
    cookies: {
      set: (name: string, value: string, opts?: unknown) => cookiesSet.push({ name, value, opts }),
      _set: cookiesSet,
    },
  }
}

jest.mock('next/server', () => ({
  NextRequest: jest.fn(),
  NextResponse: {
    next: (...args: unknown[]) => mockNextResponse.next(...args),
    redirect: (...args: unknown[]) => mockNextResponse.redirect(...args),
  },
}))

type RequestStub = Pick<NextRequest, 'url'> & {
  cookies: {
    has: (name: string) => boolean
    get: (name: string) => { name: string; value: string } | undefined
  }
}

function makeRequest(
  cookies: Record<string, string>,
  url = 'http://localhost/dashboard',
): RequestStub {
  return {
    url,
    cookies: {
      has: (name) => name in cookies,
      get: (name) => (name in cookies ? { name, value: cookies[name] } : undefined),
    },
  }
}

function encodeBase64Url(obj: object): string {
  return btoa(JSON.stringify(obj))
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
}

function makeJwt(exp: number): string {
  return [
    encodeBase64Url({ alg: 'HS256', typ: 'JWT' }),
    encodeBase64Url({ sub: 'u1', exp }),
    'fakesig',
  ].join('.')
}

// Well within the 10-second clock-skew buffer
const FUTURE = Math.floor(Date.now() / 1000) + 3600
// Definitively expired
const PAST = Math.floor(Date.now() / 1000) - 1

const REFRESH_COOKIE = 'access_token=new; Max-Age=900; Path=/; HttpOnly; SameSite=Lax'

function mockRefreshOk() {
  ;(global.fetch as jest.Mock).mockResolvedValue({
    ok: true,
    headers: {
      get: (name: string) => (name === 'set-cookie' ? REFRESH_COOKIE : null),
      getSetCookie: () => [REFRESH_COOKIE],
    },
  })
}

beforeEach(() => {
  jest.clearAllMocks()
  mockNextResponse.next.mockReturnValue(makeNextResponse())
  mockNextResponse.redirect.mockReturnValue({})
  global.fetch = jest.fn()
})

// ─── Matcher pattern ──────────────────────────────────────────────────────────

describe('config.matcher', () => {
  // Anchor with ^ so the regex doesn't substring-match on interior slashes
  // (e.g. the `/` between `_next` and `static` in `/_next/static/chunk.js`).
  // Next.js anchors its own matcher; we replicate that behaviour here.
  const re = new RegExp('^' + config.matcher[0])

  it.each([
    ['/dashboard', true],
    ['/dashboard/settings', true],
    ['/dashboard/projects/proj-1/changelog', true],
    ['/onboarding', true],
    ['/onboarding/setup', true],
    ['/billing', true],
    ['/billing/plans', true],
    ['/account', true],
    ['/team', true],
    ['/team/members', true],
  ])('matches protected path "%s"', (path, expected) => {
    expect(re.test(path)).toBe(expected)
  })

  it.each([
    ['/', false],
    ['/login', false],
    ['/login/', false],
    ['/_next/static/chunk.js', false],
    ['/_next/image', false],
    ['/favicon.ico', false],
    ['/api/webhooks/stripe', false],
    ['/verify/vote', false],
    ['/acme-org/my-project', false],
    // word-boundary guards — prefixes without a trailing slash must not match
    ['/dashboardx', false],
    ['/onboarding-marketing', false],
  ])('does not match public/internal path "%s"', (path, expected) => {
    expect(re.test(path)).toBe(expected)
  })
})

// ─── Access token — happy path ────────────────────────────────────────────────

it('allows through a valid non-expired access_token without calling refresh', async () => {
  const req = makeRequest({ access_token: makeJwt(FUTURE) })
  await middleware(req as unknown as NextRequest)
  expect(mockNextResponse.next).toHaveBeenCalledTimes(1)
  expect(global.fetch).not.toHaveBeenCalled()
  expect(mockNextResponse.redirect).not.toHaveBeenCalled()
})

it('short-circuits on access_token without calling refresh when both cookies present', async () => {
  const req = makeRequest({ access_token: makeJwt(FUTURE), refresh_token: 'a.b.c' })
  await middleware(req as unknown as NextRequest)
  expect(mockNextResponse.next).toHaveBeenCalledTimes(1)
  expect(global.fetch).not.toHaveBeenCalled()
  expect(mockNextResponse.redirect).not.toHaveBeenCalled()
})

// ─── Access token — expiry and shape ─────────────────────────────────────────

it('falls through to redirect when access_token is expired and no refresh_token present', async () => {
  const req = makeRequest({ access_token: makeJwt(PAST) })
  await middleware(req as unknown as NextRequest)
  expect(global.fetch).not.toHaveBeenCalled()
  const url = mockNextResponse.redirect.mock.calls[0][0] as URL
  expect(url.pathname).toBe('/login')
})

it('treats access_token expiring within the clock-skew buffer as expired', async () => {
  // 5 seconds from now — inside the 10-second CLOCK_SKEW_S buffer
  const req = makeRequest({ access_token: makeJwt(Math.floor(Date.now() / 1000) + 5) })
  await middleware(req as unknown as NextRequest)
  expect(global.fetch).not.toHaveBeenCalled()
  expect(mockNextResponse.redirect).toHaveBeenCalledTimes(1)
  expect(mockNextResponse.next).not.toHaveBeenCalled()
})

it('falls through to refresh when access_token fails JWT_SHAPE check', async () => {
  ;(global.fetch as jest.Mock).mockResolvedValue({ ok: false, status: 401 })
  const req = makeRequest({ access_token: 'not-a-jwt', refresh_token: 'a.b.c' })
  await middleware(req as unknown as NextRequest)
  expect(global.fetch).toHaveBeenCalledTimes(1)
})

// ─── No-cookie path ───────────────────────────────────────────────────────────

it('redirects to /login when no cookies are present', async () => {
  const req = makeRequest({})
  await middleware(req as unknown as NextRequest)
  expect(mockNextResponse.redirect).toHaveBeenCalledTimes(1)
  const url = mockNextResponse.redirect.mock.calls[0][0] as URL
  expect(url.pathname).toBe('/login')
  expect(mockNextResponse.next).not.toHaveBeenCalled()
})

// ─── Refresh token path ───────────────────────────────────────────────────────

it('allows through and sets cookie via cookies API when refresh succeeds', async () => {
  const mockRes = makeNextResponse()
  mockNextResponse.next.mockReturnValue(mockRes)
  ;(global.fetch as jest.Mock).mockResolvedValue({
    ok: true,
    headers: {
      get: (name: string) => (name === 'set-cookie' ? REFRESH_COOKIE : null),
      getSetCookie: () => [REFRESH_COOKIE],
    },
  })

  const req = makeRequest({ refresh_token: 'a.b.c' })
  await middleware(req as unknown as NextRequest)

  expect(global.fetch).toHaveBeenCalledWith(
    expect.stringContaining('/api/v1/auth/refresh'),
    expect.objectContaining({ method: 'POST', headers: { Cookie: 'refresh_token=a.b.c' } }),
  )
  expect(mockNextResponse.next).toHaveBeenCalledTimes(1)
  expect(mockNextResponse.redirect).not.toHaveBeenCalled()
  expect(mockRes.cookies._set).toHaveLength(1)
  expect(mockRes.cookies._set[0]).toMatchObject({
    name: 'access_token',
    value: 'new',
    opts: expect.objectContaining({ httpOnly: true, maxAge: 900, sameSite: 'lax' }),
  })
})

it('redirects to /login when refresh endpoint returns 401', async () => {
  ;(global.fetch as jest.Mock).mockResolvedValue({ ok: false, status: 401 })
  const req = makeRequest({ refresh_token: 'a.b.c' })
  await middleware(req as unknown as NextRequest)
  const url = mockNextResponse.redirect.mock.calls[0][0] as URL
  expect(url.pathname).toBe('/login')
  expect(mockNextResponse.next).not.toHaveBeenCalled()
})

it('redirects to /login when fetch throws a network error', async () => {
  ;(global.fetch as jest.Mock).mockRejectedValue(new Error('Network error'))
  const req = makeRequest({ refresh_token: 'a.b.c' })
  await middleware(req as unknown as NextRequest)
  const url = mockNextResponse.redirect.mock.calls[0][0] as URL
  expect(url.pathname).toBe('/login')
  expect(mockNextResponse.next).not.toHaveBeenCalled()
})

it('redirects to /login when refresh returns 200 but no Set-Cookie headers', async () => {
  ;(global.fetch as jest.Mock).mockResolvedValue({
    ok: true,
    headers: { get: () => null, getSetCookie: () => [] },
  })
  const req = makeRequest({ refresh_token: 'a.b.c' })
  await middleware(req as unknown as NextRequest)
  expect(mockNextResponse.redirect).toHaveBeenCalledTimes(1)
  const url = mockNextResponse.redirect.mock.calls[0][0] as URL
  expect(url.pathname).toBe('/login')
  expect(mockNextResponse.next).not.toHaveBeenCalled()
})

it('redirects when refresh_token fails JWT shape validation (CRLF injection guard)', async () => {
  const req = makeRequest({ refresh_token: 'bad\r\nX-Injected: evil' })
  await middleware(req as unknown as NextRequest)
  expect(global.fetch).not.toHaveBeenCalled()
  expect(mockNextResponse.redirect).toHaveBeenCalledTimes(1)
})

it('attempts refresh when access_token is expired but refresh_token is present', async () => {
  const mockRes = makeNextResponse()
  mockNextResponse.next.mockReturnValue(mockRes)
  mockRefreshOk()
  const req = makeRequest({ access_token: makeJwt(PAST), refresh_token: 'a.b.c' })
  await middleware(req as unknown as NextRequest)
  expect(global.fetch).toHaveBeenCalledTimes(1)
  expect(mockNextResponse.next).toHaveBeenCalledTimes(1)
})
