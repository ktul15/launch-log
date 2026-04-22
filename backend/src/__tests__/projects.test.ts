import crypto from 'crypto'
import { buildApp } from '../index'
import { FastifyInstance } from 'fastify'
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()
const RUN = crypto.randomUUID().replace(/-/g, '').slice(0, 12)

const createdOrgIds: string[] = []

function testEmail(label: string) {
  return `${RUN}-${label}@test.invalid`
}

function testOrgName(label: string) {
  return `Test Org ${RUN} ${label}`
}

function testSlug(label: string) {
  return `${label}-${RUN.slice(0, 8)}`
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

// ─── POST /api/v1/projects ────────────────────────────────────────────────────

describe('POST /api/v1/projects', () => {
  it('returns 201 with project shape on valid payload (owner)', async () => {
    const { cookie } = await registerAndGetCookie(app, 'create-ok')

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: { cookie },
      payload: { name: 'My Project', slug: testSlug('my-project') },
    })

    expect(res.statusCode).toBe(201)
    const body = JSON.parse(res.body)
    expect(typeof body.id).toBe('string')
    expect(body.name).toBe('My Project')
    expect(body.slug).toBe(testSlug('my-project'))
    expect(typeof body.widgetKey).toBe('string')
    expect(typeof body.createdAt).toBe('string')
  })

  it('persists project to database', async () => {
    const { cookie, orgId } = await registerAndGetCookie(app, 'create-persist')
    const slug = testSlug('persist-proj')

    await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: { cookie },
      payload: { name: 'Persist Test', slug },
    })

    const project = await prisma.project.findFirst({ where: { orgId, slug } })
    expect(project).not.toBeNull()
    expect(project!.name).toBe('Persist Test')
  })

  it('returns 403 when editor tries to create project', async () => {
    const { orgId } = await registerAndGetCookie(app, 'create-editor-org')
    const editorCookie = await createEditorCookie(app, orgId, 'create-editor')

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: { cookie: editorCookie },
      payload: { name: 'Editor Project', slug: testSlug('editor-proj') },
    })

    expect(res.statusCode).toBe(403)
  })

  it('returns 401 when unauthenticated', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      payload: { name: 'No Auth', slug: testSlug('no-auth') },
    })

    expect(res.statusCode).toBe(401)
  })

  it('returns 422 when name is missing', async () => {
    const { cookie } = await registerAndGetCookie(app, 'create-no-name')

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: { cookie },
      payload: { slug: testSlug('no-name') },
    })

    expect(res.statusCode).toBe(422)
  })

  it('returns 422 when slug is missing', async () => {
    const { cookie } = await registerAndGetCookie(app, 'create-no-slug')

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: { cookie },
      payload: { name: 'No Slug Project' },
    })

    expect(res.statusCode).toBe(422)
  })

  it('returns 422 for uppercase slug', async () => {
    const { cookie } = await registerAndGetCookie(app, 'create-upper-slug')

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: { cookie },
      payload: { name: 'Bad Slug', slug: 'UPPERCASE' },
    })

    expect(res.statusCode).toBe(422)
  })

  it('returns 422 for slug with leading hyphen', async () => {
    const { cookie } = await registerAndGetCookie(app, 'create-lead-hyphen')

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: { cookie },
      payload: { name: 'Bad Slug', slug: '-bad-start' },
    })

    expect(res.statusCode).toBe(422)
  })

  it('returns 201 for two-character slug', async () => {
    const { cookie } = await registerAndGetCookie(app, 'create-2char-slug')

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: { cookie },
      payload: { name: 'Short Slug', slug: 'ab' },
    })

    expect(res.statusCode).toBe(201)
    expect(JSON.parse(res.body).slug).toBe('ab')
  })

  it('returns 409 for duplicate slug within same org', async () => {
    const { cookie, orgId } = await registerAndGetCookie(app, 'create-dupe')
    // Bump to starter so the plan limit doesn't fire before the duplicate slug check.
    await prisma.organization.update({ where: { id: orgId }, data: { plan: 'starter' } })
    const slug = testSlug('dupe-slug')

    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: { cookie },
      payload: { name: 'First Project', slug },
    })
    expect(first.statusCode).toBe(201)

    const second = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: { cookie },
      payload: { name: 'Second Project', slug },
    })

    expect(second.statusCode).toBe(409)
    expect(JSON.parse(second.body).message).toContain('slug already exists')
  })

  it('returns 403 when free org already has 1 project (plan limit)', async () => {
    const { cookie } = await registerAndGetCookie(app, 'create-limit')

    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: { cookie },
      payload: { name: 'First Project', slug: testSlug('limit-first') },
    })
    expect(first.statusCode).toBe(201)

    const second = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: { cookie },
      payload: { name: 'Second Project', slug: testSlug('limit-second') },
    })

    expect(second.statusCode).toBe(403)
    expect(JSON.parse(second.body).message).toContain('Project limit reached')
  })
})

// ─── GET /api/v1/projects ─────────────────────────────────────────────────────

describe('GET /api/v1/projects', () => {
  it('returns empty array for new org', async () => {
    const { cookie } = await registerAndGetCookie(app, 'list-empty')

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/projects',
      headers: { cookie },
    })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual([])
  })

  it('returns created projects', async () => {
    const { cookie } = await registerAndGetCookie(app, 'list-with-projects')
    const slug = testSlug('list-proj')

    await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: { cookie },
      payload: { name: 'Listed Project', slug },
    })

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/projects',
      headers: { cookie },
    })

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(Array.isArray(body)).toBe(true)
    expect(body.length).toBe(1)
    expect(body[0].slug).toBe(slug)
  })

  it('returns 401 when unauthenticated', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/projects' })
    expect(res.statusCode).toBe(401)
  })
})
