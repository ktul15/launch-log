import crypto from 'crypto'
import { buildApp } from '../index'
import { FastifyInstance } from 'fastify'
import { Plan, PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()
const RUN = crypto.randomUUID().replace(/-/g, '').slice(0, 12)

function testEmail(label: string) {
  return `${RUN}-${label}@test.invalid`
}

function testOrgName(label: string) {
  return `Test Org ${RUN} ${label}`
}

// Extract a cookie value from a Set-Cookie header array.
function getCookieValue(setCookieHeader: string | string[] | undefined, name: string): string {
  const headers = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader ?? '']
  const match = headers.find((c) => c.startsWith(`${name}=`))
  return match ? match.split(';')[0].replace(`${name}=`, '') : ''
}

// Decode JWT payload without verifying signature — used alongside explicit verify() calls.
// Throws a clear error if the token is missing, malformed, or the decoded payload is not an
// object, surfacing the root cause rather than an opaque TypeError deep inside Buffer.from().
function decodeJwtPayload(token: string): Record<string, unknown> {
  if (typeof token !== 'string' || !token.includes('.')) {
    throw new Error(`decodeJwtPayload: expected a JWT string, got ${JSON.stringify(token)}`)
  }
  const decoded: unknown = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString())
  if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) {
    throw new Error(`decodeJwtPayload: payload is not an object: ${JSON.stringify(decoded)}`)
  }
  return decoded as Record<string, unknown>
}

let app: FastifyInstance
const loginEmail = testEmail('loginuser')
const loginPassword = 'securePass99'

beforeAll(async () => {
  await prisma.organization.deleteMany({ where: { name: { contains: RUN } } })

  app = await buildApp()

  // Seed the user used by all login/logout tests — assert success so failures are obvious.
  const seed = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: {
      orgName: testOrgName('login'),
      name: 'LoginUser',
      email: loginEmail,
      password: loginPassword,
    },
  })
  expect(seed.statusCode).toBe(201)
})

afterAll(async () => {
  await app.close()
  try {
    await prisma.organization.deleteMany({ where: { name: { contains: RUN } } })
  } finally {
    await prisma.$disconnect()
  }
})

// ─── Register ─────────────────────────────────────────────────────────────────

describe('POST /api/v1/auth/register', () => {
  it('creates org + user and returns 201 with user and org info', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: {
        orgName: testOrgName('success'),
        name: 'Alice',
        email: testEmail('success'),
        password: 'password123',
      },
    })

    expect(res.statusCode).toBe(201)
    const body = JSON.parse(res.body)
    // Tokens are in httpOnly cookies only — not in the response body
    expect(body.accessToken).toBeUndefined()
    expect(body.refreshToken).toBeUndefined()
    expect(body.user.email).toBe(testEmail('success'))
    expect(body.user.name).toBe('Alice')
    expect(typeof body.org.id).toBe('string')
    expect(typeof body.org.slug).toBe('string')
  })

  it('sets httpOnly cookies for access and refresh tokens', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: {
        orgName: testOrgName('cookies'),
        name: 'CookieUser',
        email: testEmail('cookies'),
        password: 'password123',
      },
    })

    expect(res.statusCode).toBe(201)
    const headers = res.headers['set-cookie']
    const cookies = Array.isArray(headers) ? headers : [headers ?? '']
    expect(cookies.find((c) => c.startsWith('access_token='))).toMatch(/HttpOnly/i)
    expect(cookies.find((c) => c.startsWith('refresh_token='))).toMatch(/HttpOnly/i)
  })

  it('access token is properly signed and contains correct claims', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: {
        orgName: testOrgName('jwt'),
        name: 'Bob',
        email: testEmail('jwt'),
        password: 'password123',
      },
    })

    expect(res.statusCode).toBe(201)
    const body = JSON.parse(res.body)
    const accessToken = getCookieValue(res.headers['set-cookie'], 'access_token')

    // Signature verification — throws if token was signed with the wrong secret
    expect(() => app.access.verify(accessToken)).not.toThrow()

    const claims = decodeJwtPayload(accessToken)
    expect(claims.sub).toBe(body.user.id)
    expect(claims.orgId).toBe(body.org.id)
    expect(claims.role).toBe('owner')
  })

  it('generates unique slugs for orgs with the same name', async () => {
    const sharedName = testOrgName('collision')

    const res1 = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { orgName: sharedName, name: 'User1', email: testEmail('col1'), password: 'password123' },
    })
    const res2 = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { orgName: sharedName, name: 'User2', email: testEmail('col2'), password: 'password123' },
    })

    expect(res1.statusCode).toBe(201)
    expect(res2.statusCode).toBe(201)
    expect(JSON.parse(res1.body).org.slug).not.toBe(JSON.parse(res2.body).org.slug)
  })

  it('returns 409 when email is already registered', async () => {
    const payload = {
      orgName: testOrgName('dup'),
      name: 'Carol',
      email: testEmail('dup'),
      password: 'password123',
    }

    await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload })
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload })

    expect(res.statusCode).toBe(409)
  })

  it('returns 422 for invalid email', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { orgName: 'My Org', name: 'Dave', email: 'not-an-email', password: 'password123' },
    })
    expect(res.statusCode).toBe(422)
  })

  it('returns 422 for password shorter than 8 characters', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: {
        orgName: testOrgName('shortpw'),
        name: 'Eve',
        email: testEmail('shortpw'),
        password: 'short',
      },
    })
    expect(res.statusCode).toBe(422)
  })

  it('returns 422 when required fields are missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email: testEmail('missing') },
    })
    expect(res.statusCode).toBe(422)
  })

  it('returns 422 when orgName is shorter than 2 characters', async () => {
    // Single-char orgName — validation rejects before any DB write, so no cleanup needed.
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { orgName: 'X', name: 'Frank', email: testEmail('short-org'), password: 'password123' },
    })
    expect(res.statusCode).toBe(422)
  })

  it('persists org with plan=free and a valid slug in the database', async () => {
    const expectedName = testOrgName('db-org')
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: {
        orgName: expectedName,
        name: 'Grace',
        email: testEmail('db-org'),
        password: 'password123',
      },
    })

    expect(res.statusCode).toBe(201)
    const body = JSON.parse(res.body)
    const org = await prisma.organization.findUnique({ where: { id: body.org.id } })
    expect(org).not.toBeNull()
    expect(org!.plan).toBe(Plan.free)
    expect(org!.name).toBe(expectedName)
    // Slug must be non-empty, lowercase, no leading/trailing hyphens
    expect(org!.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/)
  })

  it('persists user with role=owner, correct orgId, and hashed password in the database', async () => {
    const expectedEmail = testEmail('db-user')
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: {
        orgName: testOrgName('db-user'),
        name: 'Henry',
        email: expectedEmail,
        password: 'password123',
      },
    })

    expect(res.statusCode).toBe(201)
    const body = JSON.parse(res.body)
    const user = await prisma.user.findUnique({ where: { id: body.user.id } })
    expect(user).not.toBeNull()
    expect(user!.role).toBe('owner')
    expect(user!.orgId).toBe(body.org.id)
    expect(user!.email).toBe(expectedEmail)
    // Password must be stored as a bcrypt hash, never as plain text
    expect(user!.passwordHash).toMatch(/^\$2[ab]\$/)
  })
})

// ─── Login ────────────────────────────────────────────────────────────────────

describe('POST /api/v1/auth/login', () => {
  it('returns 200 with user and org info', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: loginEmail, password: loginPassword },
    })

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.accessToken).toBeUndefined()
    expect(body.refreshToken).toBeUndefined()
    expect(body.user.email).toBe(loginEmail)
    expect(typeof body.org.slug).toBe('string')
  })

  it('sets httpOnly cookies on login', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: loginEmail, password: loginPassword },
    })

    const headers = res.headers['set-cookie']
    const cookies = Array.isArray(headers) ? headers : [headers ?? '']
    expect(cookies.find((c) => c.startsWith('access_token='))).toMatch(/HttpOnly/i)
    expect(cookies.find((c) => c.startsWith('refresh_token='))).toMatch(/HttpOnly/i)
  })

  it('access token is properly signed and contains correct claims', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: loginEmail, password: loginPassword },
    })

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    const accessToken = getCookieValue(res.headers['set-cookie'], 'access_token')

    expect(() => app.access.verify(accessToken)).not.toThrow()

    const claims = decodeJwtPayload(accessToken)
    expect(claims.sub).toBe(body.user.id)
    expect(claims.orgId).toBe(body.org.id)
    expect(claims.role).toBe('owner')
  })

  it('returns 401 for wrong password', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: loginEmail, password: 'wrongpassword' },
    })
    expect(res.statusCode).toBe(401)
    expect(JSON.parse(res.body).message).toBe('Invalid credentials')
  })

  it('returns 401 for unknown email', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'nobody@nowhere.invalid', password: 'password123' },
    })
    expect(res.statusCode).toBe(401)
  })

  it('returns 422 when fields are missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: loginEmail },
    })
    expect(res.statusCode).toBe(422)
  })
})

// ─── Logout ───────────────────────────────────────────────────────────────────

describe('POST /api/v1/auth/logout', () => {
  it('clears auth cookies, deletes Redis token, and returns 200', async () => {
    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: loginEmail, password: loginPassword },
    })
    expect(loginRes.statusCode).toBe(200)
    const { user } = JSON.parse(loginRes.body)

    // Confirm the refresh token was stored in Redis before logout
    const beforeLogout = await app.redis.get(`refresh:${user.id}`)
    expect(beforeLogout).not.toBeNull()

    // Pass the refresh_token cookie so logout can verify and delete from Redis
    const refreshCookieLine = (
      Array.isArray(loginRes.headers['set-cookie'])
        ? loginRes.headers['set-cookie']
        : [loginRes.headers['set-cookie'] ?? '']
    ).find((c) => c.startsWith('refresh_token=')) ?? ''
    const refreshCookieValue = refreshCookieLine.split(';')[0]

    const logoutRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { cookie: refreshCookieValue },
    })

    expect(logoutRes.statusCode).toBe(200)

    // Confirm the Redis key was deleted
    const afterLogout = await app.redis.get(`refresh:${user.id}`)
    expect(afterLogout).toBeNull()

    const cleared = Array.isArray(logoutRes.headers['set-cookie'])
      ? logoutRes.headers['set-cookie']
      : [logoutRes.headers['set-cookie'] ?? '']

    // Cleared cookies must be expired — @fastify/cookie v8 uses Expires=epoch rather than Max-Age=0.
    // Either form proves the cookie was cleared, not re-issued.
    const isExpired = (c: string) => /Max-Age=0/i.test(c) || /Expires=Thu, 01 Jan 1970/i.test(c)
    expect(cleared.find((c) => c.startsWith('access_token=') && isExpired(c))).toBeTruthy()
    expect(cleared.find((c) => c.startsWith('refresh_token=') && isExpired(c))).toBeTruthy()
  })

  it('returns 200 even with no cookie (idempotent)', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/logout' })
    expect(res.statusCode).toBe(200)
  })
})
