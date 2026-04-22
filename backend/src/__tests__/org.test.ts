import crypto from 'crypto'
import { buildApp } from '../index'
import { FastifyInstance } from 'fastify'
import { PrismaClient } from '@prisma/client'

// Mock r2 module so tests control R2 availability without needing real credentials.
// The 503 path is exercised by default (mockGetR2Client returns null).
// The happy-path test overrides these mocks within its own describe block.
const mockGetR2Client = jest.fn<ReturnType<typeof import('../services/r2').getR2Client>, []>()
const mockCreateLogoPresignedUrl = jest.fn<ReturnType<typeof import('../services/r2').createLogoPresignedUrl>, [string]>()

jest.mock('../services/r2', () => ({
  getR2Client: () => mockGetR2Client(),
  createLogoPresignedUrl: (orgId: string) => mockCreateLogoPresignedUrl(orgId),
}))

const prisma = new PrismaClient()
const RUN = crypto.randomUUID().replace(/-/g, '').slice(0, 12)

// Org IDs created during this run — cleaned up by ID in afterAll so renamed orgs are not missed.
const createdOrgIds: string[] = []

function testEmail(label: string) {
  return `${RUN}-${label}@test.invalid`
}

function testOrgName(label: string) {
  return `Test Org ${RUN} ${label}`
}

async function registerAndGetCookie(
  app: FastifyInstance,
  label: string,
): Promise<{ cookie: string; orgId: string; userId: string }> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: {
      orgName: testOrgName(label),
      name: 'TestUser',
      email: testEmail(label),
      password: 'password123',
    },
  })
  expect(res.statusCode).toBe(201)
  const body = JSON.parse(res.body)
  createdOrgIds.push(body.org.id)
  const setCookie = res.headers['set-cookie']
  const cookies = Array.isArray(setCookie) ? setCookie : [setCookie ?? '']
  const cookie = cookies.map((c) => c.split(';')[0]).join('; ')
  return { cookie, orgId: body.org.id, userId: body.user.id }
}

async function createEditorCookie(
  app: FastifyInstance,
  orgId: string,
  label: string,
): Promise<string> {
  const bcrypt = await import('bcrypt')
  // Round 1 is intentionally low — tests need a valid hash, not production security.
  const hash = await bcrypt.hash('password123', 1)
  await prisma.user.create({
    data: {
      orgId,
      email: testEmail(label),
      passwordHash: hash,
      name: 'Editor',
      role: 'editor',
    },
  })

  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email: testEmail(label), password: 'password123' },
  })
  expect(res.statusCode).toBe(200)
  const setCookie = res.headers['set-cookie']
  const cookies = Array.isArray(setCookie) ? setCookie : [setCookie ?? '']
  return cookies.map((c) => c.split(';')[0]).join('; ')
}

let app: FastifyInstance

beforeAll(async () => {
  await prisma.organization.deleteMany({ where: { name: { contains: RUN } } })
  app = await buildApp()
})

beforeEach(() => {
  // Default: R2 not configured. Individual tests override as needed.
  mockGetR2Client.mockReturnValue(null)
  mockCreateLogoPresignedUrl.mockReset()
})

afterAll(async () => {
  await app.close()
  try {
    if (createdOrgIds.length > 0) {
      await prisma.organization.deleteMany({ where: { id: { in: createdOrgIds } } })
    }
  } finally {
    await prisma.$disconnect()
  }
})

// ─── GET /api/v1/org ──────────────────────────────────────────────────────────

describe('GET /api/v1/org', () => {
  it('returns 200 with org fields for authenticated owner', async () => {
    const { cookie, orgId } = await registerAndGetCookie(app, 'get-owner')

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/org',
      headers: { cookie },
    })

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.id).toBe(orgId)
    expect(typeof body.name).toBe('string')
    expect(typeof body.slug).toBe('string')
    expect(typeof body.plan).toBe('string')
    expect(typeof body.createdAt).toBe('string')
    expect(body.projectCount).toBe(0)
    // Prisma meta must not leak
    expect(body._count).toBeUndefined()
    // Sensitive fields must not leak
    expect(body.passwordHash).toBeUndefined()
    expect(body.stripeCustomerId).toBeUndefined()
  })

  it('returns 200 for authenticated editor', async () => {
    const { orgId } = await registerAndGetCookie(app, 'get-editor-org')
    const editorCookie = await createEditorCookie(app, orgId, 'get-editor')

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/org',
      headers: { cookie: editorCookie },
    })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).id).toBe(orgId)
  })

  it('returns 401 when unauthenticated', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/org' })
    expect(res.statusCode).toBe(401)
  })
})

// ─── PATCH /api/v1/org ────────────────────────────────────────────────────────

describe('PATCH /api/v1/org', () => {
  it('updates org name and returns updated org', async () => {
    const { cookie, orgId } = await registerAndGetCookie(app, 'patch-name')

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/org',
      headers: { cookie },
      payload: { name: 'Updated Name' },
    })

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.id).toBe(orgId)
    expect(body.name).toBe('Updated Name')
  })

  it('updates org slug and returns updated org', async () => {
    const { cookie, orgId } = await registerAndGetCookie(app, 'patch-slug')
    const newSlug = `new-slug-${RUN.slice(0, 8)}`

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/org',
      headers: { cookie },
      payload: { slug: newSlug },
    })

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.id).toBe(orgId)
    expect(body.slug).toBe(newSlug)
  })

  it('updates logoUrl and returns updated org', async () => {
    const { cookie } = await registerAndGetCookie(app, 'patch-logo')

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/org',
      headers: { cookie },
      payload: { logoUrl: 'https://cdn.example.com/logos/org.jpg' },
    })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).logoUrl).toBe('https://cdn.example.com/logos/org.jpg')
  })

  it('returns 422 for non-HTTPS logoUrl', async () => {
    const { cookie } = await registerAndGetCookie(app, 'patch-http-logo')

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/org',
      headers: { cookie },
      payload: { logoUrl: 'http://insecure.example.com/logo.jpg' },
    })

    expect(res.statusCode).toBe(422)
  })

  it('returns 422 for invalid logoUrl', async () => {
    const { cookie } = await registerAndGetCookie(app, 'patch-bad-logo')

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/org',
      headers: { cookie },
      payload: { logoUrl: 'not-a-url' },
    })

    expect(res.statusCode).toBe(422)
  })

  it('returns 409 when slug is already taken', async () => {
    const { cookie: cookie1 } = await registerAndGetCookie(app, 'conflict-1')
    const { cookie: cookie2 } = await registerAndGetCookie(app, 'conflict-2')

    // Set a deterministic slug on org1, then have org2 try to claim it.
    const targetSlug = `conflict-slug-${RUN.slice(0, 8)}`
    const setRes = await app.inject({
      method: 'PATCH',
      url: '/api/v1/org',
      headers: { cookie: cookie1 },
      payload: { slug: targetSlug },
    })
    expect(setRes.statusCode).toBe(200)

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/org',
      headers: { cookie: cookie2 },
      payload: { slug: targetSlug },
    })

    expect(res.statusCode).toBe(409)
    const body = JSON.parse(res.body)
    expect(body.statusCode).toBe(409)
    expect(body.error).toBe('Conflict')
  })

  it('returns 403 when editor tries to update', async () => {
    const { orgId } = await registerAndGetCookie(app, 'patch-editor-org')
    const editorCookie = await createEditorCookie(app, orgId, 'patch-editor')

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/org',
      headers: { cookie: editorCookie },
      payload: { name: 'Should Fail' },
    })

    expect(res.statusCode).toBe(403)
  })

  it('returns 422 for slug with invalid characters', async () => {
    const { cookie } = await registerAndGetCookie(app, 'patch-bad-slug')

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/org',
      headers: { cookie },
      payload: { slug: 'UPPER_CASE' },
    })

    expect(res.statusCode).toBe(422)
  })

  it('returns 200 for two-character slug', async () => {
    const { cookie, orgId } = await registerAndGetCookie(app, 'patch-2char-slug')

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/org',
      headers: { cookie },
      payload: { slug: 'ab' },
    })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).slug).toBe('ab')
    // Reset slug so cleanup doesn't collide with other tests
    await app.inject({ method: 'PATCH', url: '/api/v1/org', headers: { cookie }, payload: { slug: `reset-${orgId.slice(0, 8)}` } })
  })

  it('returns 422 for slug with leading hyphen', async () => {
    const { cookie } = await registerAndGetCookie(app, 'patch-lead-hyphen')

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/org',
      headers: { cookie },
      payload: { slug: '-bad-start' },
    })

    expect(res.statusCode).toBe(422)
  })

  it('returns 422 when body is empty', async () => {
    const { cookie } = await registerAndGetCookie(app, 'patch-empty')

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/org',
      headers: { cookie },
      payload: {},
    })

    expect(res.statusCode).toBe(422)
  })

  it('returns 401 when unauthenticated', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/org',
      payload: { name: 'No Auth' },
    })
    expect(res.statusCode).toBe(401)
  })

  it('persists name change to database', async () => {
    const { cookie, orgId } = await registerAndGetCookie(app, 'patch-persist')

    await app.inject({
      method: 'PATCH',
      url: '/api/v1/org',
      headers: { cookie },
      payload: { name: 'Persisted Name' },
    })

    const org = await prisma.organization.findUnique({ where: { id: orgId } })
    expect(org!.name).toBe('Persisted Name')
  })
})

// ─── POST /api/v1/org/logo-upload-url ────────────────────────────────────────

describe('POST /api/v1/org/logo-upload-url', () => {
  it('returns 503 when R2 is not configured', async () => {
    const { cookie } = await registerAndGetCookie(app, 'logo-no-r2')
    // mockGetR2Client returns null by default (set in beforeEach)

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/org/logo-upload-url',
      headers: { cookie },
    })

    expect(res.statusCode).toBe(503)
    expect(JSON.parse(res.body).message).toBe('Logo upload not configured')
  })

  it('returns 200 with presigned URL when R2 is configured', async () => {
    const { cookie } = await registerAndGetCookie(app, 'logo-r2-ok')
    mockGetR2Client.mockReturnValue({} as ReturnType<typeof import('../services/r2').getR2Client>)
    mockCreateLogoPresignedUrl.mockResolvedValue({
      uploadUrl: 'https://upload.r2.example.com/signed-url',
      publicUrl: 'https://cdn.example.com/logos/org/123.jpg',
      key: 'logos/org/123.jpg',
    })

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/org/logo-upload-url',
      headers: { cookie },
    })

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(typeof body.uploadUrl).toBe('string')
    expect(typeof body.publicUrl).toBe('string')
    expect(typeof body.key).toBe('string')
    expect(body.uploadUrl).toBe('https://upload.r2.example.com/signed-url')
    expect(body.publicUrl).toBe('https://cdn.example.com/logos/org/123.jpg')
  })

  it('returns 403 when editor requests upload URL', async () => {
    const { orgId } = await registerAndGetCookie(app, 'logo-editor-org')
    const editorCookie = await createEditorCookie(app, orgId, 'logo-editor')

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/org/logo-upload-url',
      headers: { cookie: editorCookie },
    })

    expect(res.statusCode).toBe(403)
  })

  it('returns 401 when unauthenticated', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/org/logo-upload-url' })
    expect(res.statusCode).toBe(401)
  })
})
