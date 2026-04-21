import crypto from 'crypto'
import { buildApp } from '../index'
import { FastifyInstance } from 'fastify'
import { PrismaClient } from '@prisma/client'
import { googleOAuth } from '../plugins/passport'

// mockState is module-level so it persists across the jest.mock factory boundary.
// Tests set profile/failWith before each inject call; afterEach resets it.
const mockState = { profile: null as any, failWith: null as Error | null }

jest.mock('passport-google-oauth20', () => {
  class MockStrategy {
    name = 'google'
    private _verify: Function

    // These five are set by our Fastify adapter before calling authenticate()
    success!: (user: any) => void
    fail!: (challenge: any) => void
    redirect!: (url: string) => void
    error!: (err: Error) => void
    pass!: () => void

    constructor(_options: unknown, verify: Function) {
      this._verify = verify
    }

    authenticate(req: any) {
      const query = req.query ?? {}

      // GET /google — no code in query → simulate redirect to Google
      if (!query.code) {
        this.redirect('https://accounts.google.com/o/oauth2/v2/auth?mock=1')
        return
      }

      // GET /google/callback — simulate Google returning a profile (or an error)
      if (mockState.failWith) {
        this.error(mockState.failWith)
        return
      }
      if (!mockState.profile) {
        this.fail({ message: 'No mock profile configured' })
        return
      }
      this._verify(null, null, mockState.profile, (err: Error | null, user: any) => {
        if (err) { this.error(err); return }
        if (!user) { this.fail({ message: 'No user returned' }); return }
        this.success(user)
      })
    }
  }

  return { Strategy: MockStrategy }
})

const prisma = new PrismaClient()
const RUN = crypto.randomUUID().replace(/-/g, '').slice(0, 12)

function testEmail(label: string) {
  return `${RUN}-google-${label}@test.invalid`
}

function makeProfile(overrides: {
  id?: string
  displayName?: string
  email?: string
} = {}) {
  return {
    id: overrides.id ?? `google-${crypto.randomBytes(4).toString('hex')}`,
    displayName: overrides.displayName ?? 'Test User',
    emails: [{ value: overrides.email ?? testEmail('default'), verified: 'true' }],
    photos: [{ value: 'https://lh3.googleusercontent.com/photo.jpg' }],
  }
}

let app: FastifyInstance

beforeAll(async () => {
  await prisma.organization.deleteMany({ where: { name: { contains: RUN } } })
  app = await buildApp()
})

afterEach(() => {
  mockState.profile = null
  mockState.failWith = null
})

afterAll(async () => {
  await app.close()
  try {
    await prisma.organization.deleteMany({ where: { name: { contains: RUN } } })
  } finally {
    await prisma.$disconnect()
  }
})

// ─── GET /google ──────────────────────────────────────────────────────────────

describe('GET /api/v1/auth/google', () => {
  it('redirects to Google OAuth consent screen', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/auth/google' })
    expect(res.statusCode).toBe(302)
    expect(res.headers['location']).toMatch(/accounts\.google\.com/)
  })

  it('returns 503 when Google OAuth is not configured', async () => {
    const original = googleOAuth.authenticate
    googleOAuth.authenticate = null

    const res = await app.inject({ method: 'GET', url: '/api/v1/auth/google' })
    expect(res.statusCode).toBe(503)
    expect(JSON.parse(res.body).message).toBe('Google OAuth is not configured')

    googleOAuth.authenticate = original
  })
})

// ─── GET /google/callback ─────────────────────────────────────────────────────

describe('GET /api/v1/auth/google/callback', () => {
  it('new Google user: creates org + user, sets httpOnly lax cookies, redirects to frontend', async () => {
    const profile = makeProfile({ email: testEmail('new') })
    mockState.profile = profile

    const res = await app.inject({ method: 'GET', url: '/api/v1/auth/google/callback?code=mock' })

    expect(res.statusCode).toBe(302)
    expect(res.headers['location']).toBe('http://localhost:3000')

    const cookies = Array.isArray(res.headers['set-cookie'])
      ? res.headers['set-cookie']
      : [res.headers['set-cookie'] ?? '']

    const accessCookie = cookies.find((c) => c.startsWith('access_token=')) ?? ''
    expect(accessCookie).toMatch(/HttpOnly/i)
    expect(accessCookie).toMatch(/SameSite=Lax/i)

    const refreshCookie = cookies.find((c) => c.startsWith('refresh_token=')) ?? ''
    expect(refreshCookie).toMatch(/HttpOnly/i)
    expect(refreshCookie).toMatch(/SameSite=Lax/i)

    const user = await prisma.user.findFirst({ where: { email: profile.emails[0].value } })
    expect(user).not.toBeNull()
    expect(user?.googleId).toBe(profile.id)
    expect(user?.passwordHash).toBeNull()
    expect(user?.avatarUrl).toBe('https://lh3.googleusercontent.com/photo.jpg')
  })

  it('existing email without googleId: links googleId, preserves existing avatarUrl, signs in', async () => {
    const email = testEmail('link')

    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { orgName: `Link Org ${RUN}`, name: 'LinkUser', email, password: 'password123' },
    })

    // Give the existing user a custom avatar before linking
    await prisma.user.updateMany({ where: { email }, data: { avatarUrl: 'https://custom.example.com/avatar.png' } })

    const profile = makeProfile({ email, id: `google-link-${RUN}` })
    mockState.profile = profile

    const res = await app.inject({ method: 'GET', url: '/api/v1/auth/google/callback?code=mock' })
    expect(res.statusCode).toBe(302)

    const user = await prisma.user.findFirst({ where: { email } })
    expect(user?.googleId).toBe(profile.id)
    // passwordHash intact — linking does not remove it
    expect(user?.passwordHash).not.toBeNull()
    // custom avatarUrl preserved — Google photo must not overwrite it
    expect(user?.avatarUrl).toBe('https://custom.example.com/avatar.png')
  })

  it('existing googleId: signs in directly without creating a duplicate user', async () => {
    const email = testEmail('returning')
    const googleId = `google-returning-${RUN}`
    const profile = makeProfile({ email, id: googleId })

    mockState.profile = profile
    const first = await app.inject({ method: 'GET', url: '/api/v1/auth/google/callback?code=mock' })
    expect(first.statusCode).toBe(302)

    const countBefore = await prisma.user.count({ where: { googleId } })

    mockState.profile = profile
    const second = await app.inject({ method: 'GET', url: '/api/v1/auth/google/callback?code=mock' })
    expect(second.statusCode).toBe(302)

    expect(await prisma.user.count({ where: { googleId } })).toBe(countBefore)
  })

  it('missing email in profile (empty array): redirects to failure URL without setting auth cookies', async () => {
    mockState.profile = { ...makeProfile(), emails: [] }

    const res = await app.inject({ method: 'GET', url: '/api/v1/auth/google/callback?code=mock' })

    expect(res.statusCode).toBe(302)
    expect(res.headers['location']).toMatch(/error=oauth/)

    const cookies = res.headers['set-cookie']
    const cookieList = Array.isArray(cookies) ? cookies : [cookies ?? '']
    expect(cookieList.find((c) => c.startsWith('access_token='))).toBeUndefined()
  })

  it('missing email in profile (undefined emails): redirects to failure URL', async () => {
    const { emails: _emails, ...profileNoEmails } = makeProfile()
    mockState.profile = profileNoEmails

    const res = await app.inject({ method: 'GET', url: '/api/v1/auth/google/callback?code=mock' })

    expect(res.statusCode).toBe(302)
    expect(res.headers['location']).toMatch(/error=oauth/)
  })

  it('strategy error (e.g. network failure): redirects to failure URL', async () => {
    mockState.failWith = new Error('Google token exchange failed')

    const res = await app.inject({ method: 'GET', url: '/api/v1/auth/google/callback?code=mock' })

    expect(res.statusCode).toBe(302)
    expect(res.headers['location']).toMatch(/error=oauth/)

    const cookies = res.headers['set-cookie']
    const cookieList = Array.isArray(cookies) ? cookies : [cookies ?? '']
    expect(cookieList.find((c) => c.startsWith('access_token='))).toBeUndefined()
  })

  it('concurrent callbacks with same googleId: both succeed, exactly one user created', async () => {
    const email = testEmail('race')
    const googleId = `google-race-${RUN}`
    const profile = makeProfile({ email, id: googleId })

    // Keep profile set for both concurrent requests.
    // The @@unique([googleId]) constraint means the second DB insert fails with P2002,
    // which the retry logic catches to return the first request's record instead.
    mockState.profile = profile

    const [first, second] = await Promise.all([
      app.inject({ method: 'GET', url: '/api/v1/auth/google/callback?code=mock' }),
      app.inject({ method: 'GET', url: '/api/v1/auth/google/callback?code=mock' }),
    ])

    // Both should succeed — the loser falls back to the winner's record
    expect(first.statusCode).toBe(302)
    expect(second.statusCode).toBe(302)
    expect(first.headers['location']).toBe('http://localhost:3000')
    expect(second.headers['location']).toBe('http://localhost:3000')

    // Both responses must carry auth cookies — the race loser must not be silently unauthenticated
    const toCookies = (res: typeof first) => {
      const raw = res.headers['set-cookie']
      return Array.isArray(raw) ? raw : [raw ?? '']
    }
    expect(toCookies(first).some((c) => c.startsWith('access_token='))).toBe(true)
    expect(toCookies(second).some((c) => c.startsWith('access_token='))).toBe(true)

    // Exactly one user record exists regardless of which request won the race
    expect(await prisma.user.count({ where: { googleId } })).toBe(1)
  })
})
