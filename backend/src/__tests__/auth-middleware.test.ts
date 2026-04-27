import crypto from 'crypto'
import { buildApp } from '../index'
import { FastifyInstance } from 'fastify'
import { PrismaClient } from '@prisma/client'
import { authenticate } from '../middleware/authenticate'

const prisma = new PrismaClient()
const RUN = crypto.randomUUID().replace(/-/g, '').slice(0, 12)

function testEmail(label: string) {
  return `${RUN}-${label}@test.invalid`
}

function testOrgName(label: string) {
  return `Test Org ${RUN} ${label}`
}

function getCookieValue(setCookieHeader: string | string[] | undefined, name: string): string {
  const headers = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader ?? '']
  const match = headers.find((c) => c.startsWith(`${name}=`))
  return match ? match.split(';')[0].replace(`${name}=`, '') : ''
}

let app: FastifyInstance
let userId: string
let orgId: string
let accessToken: string
let refreshToken: string

beforeAll(async () => {
  await prisma.organization.deleteMany({ where: { name: { contains: RUN } } })

  app = await buildApp()

  // Register a test route that requires authentication
  app.get(
    '/api/v1/test/protected',
    { preHandler: authenticate },
    async (req) => ({ ok: true, sub: req.user.sub, orgId: req.user.orgId, role: req.user.role }),
  )

  const reg = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: {
      orgName: testOrgName('mw'),
      name: 'MiddlewareUser',
      email: testEmail('mw'),
      password: 'securePass99',
    },
  })
  expect(reg.statusCode).toBe(201)

  const body = JSON.parse(reg.body) as { user: { id: string }; org: { id: string } }
  userId = body.user.id
  orgId = body.org.id

  accessToken = getCookieValue(reg.headers['set-cookie'], 'access_token')
  refreshToken = getCookieValue(reg.headers['set-cookie'], 'refresh_token')

  expect(accessToken).toBeTruthy()
  expect(refreshToken).toBeTruthy()
})

afterAll(async () => {
  await app.close()
  try {
    await prisma.organization.deleteMany({ where: { name: { contains: RUN } } })
  } finally {
    await prisma.$disconnect()
  }
})

// ─── authenticate preHandler ──────────────────────────────────────────────────

describe('authenticate middleware', () => {
  it('allows request with a valid access token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/test/protected',
      cookies: { access_token: accessToken },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body) as { ok: boolean; sub: string; orgId: string; role: string }
    expect(body.ok).toBe(true)
    expect(body.sub).toBe(userId)
    expect(body.orgId).toBe(orgId)
    expect(body.role).toBe('owner')
  })

  it('rejects request with no access token cookie', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/test/protected',
    })
    expect(res.statusCode).toBe(401)
    const body = JSON.parse(res.body) as { message: string }
    expect(body.message).toBe('Unauthorized')
  })

  it('rejects request with a tampered access token', async () => {
    const parts = accessToken.split('.')
    // Flip one byte in the signature to invalidate it
    const tampered = `${parts[0]}.${parts[1]}.AAAAAAAAAAAAAAAAAAAAAAAAA`
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/test/protected',
      cookies: { access_token: tampered },
    })
    expect(res.statusCode).toBe(401)
    const body = JSON.parse(res.body) as { message: string }
    expect(body.message).toBe('Unauthorized')
  })

  it('returns TOKEN_EXPIRED code for an expired access token', async () => {
    // Sign a token with 1-second expiry then wait for it to lapse
    const expiredToken = app.access.sign(
      { sub: userId, orgId, role: 'owner' },
      { expiresIn: 1 },
    )
    await new Promise((r) => setTimeout(r, 1100))

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/test/protected',
      cookies: { access_token: expiredToken },
    })
    expect(res.statusCode).toBe(401)
    const body = JSON.parse(res.body) as { message: string; code: string }
    expect(body.message).toBe('Token expired')
    expect(body.code).toBe('TOKEN_EXPIRED')
  }, 5000)
})

// ─── POST /api/v1/auth/refresh ────────────────────────────────────────────────

describe('POST /api/v1/auth/refresh', () => {
  it('issues a new access token with a valid refresh token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      cookies: { refresh_token: refreshToken },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body) as { message: string }
    expect(body.message).toBe('Token refreshed')

    const newAccessToken = getCookieValue(res.headers['set-cookie'], 'access_token')
    expect(newAccessToken).toBeTruthy()
    expect(newAccessToken).not.toBe(accessToken)
  })

  it('returns 401 when refresh token cookie is absent', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
    })
    expect(res.statusCode).toBe(401)
    const body = JSON.parse(res.body) as { message: string }
    expect(body.message).toBe('Unauthorized')
  })

  it('returns 401 with TOKEN_EXPIRED code for an expired refresh token', async () => {
    const expiredRefresh = app.refresh.sign(
      { sub: userId, orgId, role: 'owner' },
      { expiresIn: 1 },
    )
    await new Promise((r) => setTimeout(r, 1100))

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      cookies: { refresh_token: expiredRefresh },
    })
    expect(res.statusCode).toBe(401)
    const body = JSON.parse(res.body) as { message: string; code: string }
    expect(body.message).toBe('Token expired')
    expect(body.code).toBe('TOKEN_EXPIRED')
  }, 5000)

  it('returns 401 for a tampered refresh token', async () => {
    const parts = refreshToken.split('.')
    const tampered = `${parts[0]}.${parts[1]}.AAAAAAAAAAAAAAAAAAAAAAAAA`
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      cookies: { refresh_token: tampered },
    })
    expect(res.statusCode).toBe(401)
    const body = JSON.parse(res.body) as { message: string }
    expect(body.message).toBe('Unauthorized')
  })

  it('returns 401 for a valid JWT not present in Redis (post-logout)', async () => {
    // Sign a structurally valid refresh token that was never stored in Redis
    const orphanToken = app.refresh.sign({ sub: userId, orgId, role: 'owner' })
    // Do NOT store it in Redis — simulates a logged-out or revoked session
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      cookies: { refresh_token: orphanToken },
    })
    expect(res.statusCode).toBe(401)
    const body = JSON.parse(res.body) as { message: string }
    expect(body.message).toBe('Unauthorized')
  })

  it('returns 401 for a refresh token with missing sub claim', async () => {
    const badToken = app.refresh.sign({ orgId, role: 'owner' })
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      cookies: { refresh_token: badToken },
    })
    expect(res.statusCode).toBe(401)
    const body = JSON.parse(res.body) as { message: string }
    expect(body.message).toBe('Unauthorized')
  })

  it('returns 401 for a refresh token with an empty-string sub claim', async () => {
    const badToken = app.refresh.sign({ sub: '', orgId, role: 'owner' })
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      cookies: { refresh_token: badToken },
    })
    expect(res.statusCode).toBe(401)
    const body = JSON.parse(res.body) as { message: string }
    expect(body.message).toBe('Unauthorized')
  })

  it('returns 401 for a refresh token with an unrecognised role', async () => {
    const badToken = app.refresh.sign({ sub: userId, orgId, role: 'superadmin' })
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      cookies: { refresh_token: badToken },
    })
    expect(res.statusCode).toBe(401)
    const body = JSON.parse(res.body) as { message: string }
    expect(body.message).toBe('Unauthorized')
  })

  it('returns 401 for a refresh token with a missing orgId claim', async () => {
    const badToken = app.refresh.sign({ sub: userId, role: 'owner' })
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      cookies: { refresh_token: badToken },
    })
    expect(res.statusCode).toBe(401)
    const body = JSON.parse(res.body) as { message: string }
    expect(body.message).toBe('Unauthorized')
  })
})

// ─── authenticate middleware — orgId claim validation ─────────────────────────

describe('authenticate middleware — orgId claim', () => {
  it('returns 401 for an access token with a missing orgId claim', async () => {
    const badToken = app.access.sign({ sub: userId, role: 'owner' })
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/test/protected',
      cookies: { access_token: badToken },
    })
    expect(res.statusCode).toBe(401)
    const body = JSON.parse(res.body) as { message: string }
    expect(body.message).toBe('Unauthorized')
  })

  it('returns 401 for an access token with an empty-string orgId claim', async () => {
    const badToken = app.access.sign({ sub: userId, orgId: '', role: 'owner' })
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/test/protected',
      cookies: { access_token: badToken },
    })
    expect(res.statusCode).toBe(401)
    const body = JSON.parse(res.body) as { message: string }
    expect(body.message).toBe('Unauthorized')
  })
})
