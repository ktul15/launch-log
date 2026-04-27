import crypto from 'crypto'
import { buildApp } from '../index'
import { FastifyInstance } from 'fastify'
import { PrismaClient } from '@prisma/client'
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/library'

const prisma = new PrismaClient()
const RUN = crypto.randomUUID().replace(/-/g, '').slice(0, 12)

const createdOrgIds: string[] = []

function testEmail(label: string) {
  return `${RUN}-${label}@test.invalid`
}

// __TEST__ prefix makes test orgs identifiable in DB inspection on shared environments.
function testOrgName(label: string) {
  return `__TEST__ ${RUN} ${label}`
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

// Editor users are cleaned up via org cascade delete in afterAll — they don't need
// separate tracking in createdOrgIds.
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

  it('returns 201 with auto-generated slug when slug field is absent', async () => {
    const { cookie } = await registerAndGetCookie(app, 'create-auto-slug')

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: { cookie },
      payload: { name: 'Auto Slug Project' },
    })

    expect(res.statusCode).toBe(201)
    const { slug } = JSON.parse(res.body)
    // Slug must be valid (lowercase alphanumeric/hyphen) and derived from the name.
    expect(slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/)
    expect(slug).toContain('auto')
  })

  it('auto-generated slug is derived from project name', async () => {
    const { cookie } = await registerAndGetCookie(app, 'create-slug-derive')

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: { cookie },
      payload: { name: 'Hello World App' },
    })

    expect(res.statusCode).toBe(201)
    const { slug } = JSON.parse(res.body)
    expect(slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/)
    expect(slug).toContain('hello')
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

  it('allows project creation after soft-deleting the only project (isActive filter)', async () => {
    const { cookie } = await registerAndGetCookie(app, 'create-after-inactive')

    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: { cookie },
      payload: { name: 'To Deactivate', slug: testSlug('after-inactive-1') },
    })
    expect(first.statusCode).toBe(201)
    const { id } = JSON.parse(first.body)

    await prisma.project.update({ where: { id }, data: { isActive: false } })

    const second = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: { cookie },
      payload: { name: 'After Inactive', slug: testSlug('after-inactive-2') },
    })
    expect(second.statusCode).toBe(201)
  })

  it('returns 403 on 4th project when starter org already has 3 (plan limit)', async () => {
    const { cookie, orgId } = await registerAndGetCookie(app, 'create-starter-limit')
    await prisma.organization.update({ where: { id: orgId }, data: { plan: 'starter' } })

    for (let i = 1; i <= 3; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/projects',
        headers: { cookie },
        payload: { name: `Starter Project ${i}`, slug: testSlug(`starter-limit-${i}`) },
      })
      expect(res.statusCode).toBe(201)
    }

    const fourth = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: { cookie },
      payload: { name: 'Over Limit', slug: testSlug('starter-limit-4') },
    })
    expect(fourth.statusCode).toBe(403)
    expect(JSON.parse(fourth.body).message).toContain('Project limit reached')
  })

  it('never blocks project creation for pro plan', async () => {
    const { cookie, orgId } = await registerAndGetCookie(app, 'create-pro-unlimited')
    await prisma.organization.update({ where: { id: orgId }, data: { plan: 'pro' } })

    for (let i = 1; i <= 5; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/projects',
        headers: { cookie },
        payload: { name: `Pro Project ${i}`, slug: testSlug(`pro-unlimited-${i}`) },
      })
      expect(res.statusCode).toBe(201)
    }
  })

  it('returns 409 when transaction hits serialization failure (P2034)', async () => {
    const { cookie } = await registerAndGetCookie(app, 'p2034')

    const p2034 = new PrismaClientKnownRequestError('Serialization failure', {
      code: 'P2034',
      clientVersion: '0.0.0',
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const spy = jest.spyOn((app as any).prisma, '$transaction').mockRejectedValueOnce(p2034)

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: { cookie },
      payload: { name: 'Conflict Project', slug: testSlug('p2034') },
    })

    spy.mockRestore()
    expect(res.statusCode).toBe(409)
    expect(JSON.parse(res.body).message).toContain('conflicted')
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
    expect(body[0].description).toBeNull()
    expect(body[0]._count).toEqual({ changelogEntries: 0, roadmapItems: 0 })
  })

  it('excludes inactive projects from list', async () => {
    const { cookie } = await registerAndGetCookie(app, 'list-inactive')

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: { cookie },
      payload: { name: 'Inactive Project', slug: testSlug('inactive-list') },
    })
    const { id } = JSON.parse(created.body)

    await prisma.project.update({ where: { id }, data: { isActive: false } })

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/projects',
      headers: { cookie },
    })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual([])
  })

  it('returns 401 when unauthenticated', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/projects' })
    expect(res.statusCode).toBe(401)
  })
})

// ─── GET /api/v1/projects/:id ─────────────────────────────────────────────────

describe('GET /api/v1/projects/:id', () => {
  it('returns 200 with full project detail for owner', async () => {
    const { cookie } = await registerAndGetCookie(app, 'get-owner')

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: { cookie },
      payload: { name: 'Detail Project', slug: testSlug('detail-proj') },
    })
    const { id } = JSON.parse(created.body)

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${id}`,
      headers: { cookie },
    })

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.id).toBe(id)
    expect(body.name).toBe('Detail Project')
    expect(typeof body.widgetKey).toBe('string')
    expect(typeof body.widgetSettings).toBe('object')
    expect(typeof body.themeSettings).toBe('object')
    expect(typeof body.isActive).toBe('boolean')
    expect(typeof body.createdAt).toBe('string')
    expect(typeof body.updatedAt).toBe('string')
  })

  it('returns 200 with project detail for editor', async () => {
    const { cookie: ownerCookie, orgId } = await registerAndGetCookie(app, 'get-editor-org')
    const editorCookie = await createEditorCookie(app, orgId, 'get-editor')

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: { cookie: ownerCookie },
      payload: { name: 'Editor View Project', slug: testSlug('editor-view') },
    })
    const { id } = JSON.parse(created.body)

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${id}`,
      headers: { cookie: editorCookie },
    })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).id).toBe(id)
  })

  it('returns 404 for unknown project id', async () => {
    const { cookie } = await registerAndGetCookie(app, 'get-404')

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/00000000-0000-0000-0000-000000000000`,
      headers: { cookie },
    })

    expect(res.statusCode).toBe(404)
  })

  it('returns 404 for inactive project (isActive: false)', async () => {
    const { cookie } = await registerAndGetCookie(app, 'get-inactive')

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: { cookie },
      payload: { name: 'Inactive Detail', slug: testSlug('inactive-detail') },
    })
    const { id } = JSON.parse(created.body)

    await prisma.project.update({ where: { id }, data: { isActive: false } })

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${id}`,
      headers: { cookie },
    })

    expect(res.statusCode).toBe(404)
  })

  it('returns 404 for project belonging to another org (isolation)', async () => {
    const { cookie: cookieA } = await registerAndGetCookie(app, 'get-iso-a')
    const { cookie: cookieB } = await registerAndGetCookie(app, 'get-iso-b')

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: { cookie: cookieA },
      payload: { name: 'Org A Project', slug: testSlug('iso-a-proj') },
    })
    const { id } = JSON.parse(created.body)

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${id}`,
      headers: { cookie: cookieB },
    })

    expect(res.statusCode).toBe(404)
  })

  it('returns 401 when unauthenticated', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/projects/00000000-0000-0000-0000-000000000000',
    })
    expect(res.statusCode).toBe(401)
  })
})

// ─── PATCH /api/v1/projects/:id ───────────────────────────────────────────────

describe('PATCH /api/v1/projects/:id', () => {
  it('returns 200 with updated name', async () => {
    const { cookie } = await registerAndGetCookie(app, 'patch-name')

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: { cookie },
      payload: { name: 'Original Name', slug: testSlug('patch-orig') },
    })
    const { id } = JSON.parse(created.body)

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/projects/${id}`,
      headers: { cookie },
      payload: { name: 'Updated Name' },
    })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).name).toBe('Updated Name')
  })

  it('returns 200 with updated slug', async () => {
    const { cookie } = await registerAndGetCookie(app, 'patch-slug')
    const newSlug = testSlug('patch-new-slug')

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: { cookie },
      payload: { name: 'Slug Test', slug: testSlug('patch-old-slug') },
    })
    const { id } = JSON.parse(created.body)

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/projects/${id}`,
      headers: { cookie },
      payload: { slug: newSlug },
    })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).slug).toBe(newSlug)
  })

  it('returns 200 with updated description', async () => {
    const { cookie } = await registerAndGetCookie(app, 'patch-desc')

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: { cookie },
      payload: { name: 'Desc Test', slug: testSlug('patch-desc') },
    })
    const { id } = JSON.parse(created.body)

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/projects/${id}`,
      headers: { cookie },
      payload: { description: 'A great project' },
    })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).description).toBe('A great project')
  })

  it('returns 422 for empty body', async () => {
    const { cookie } = await registerAndGetCookie(app, 'patch-empty')

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: { cookie },
      payload: { name: 'Empty Patch Target', slug: testSlug('patch-empty') },
    })
    const { id } = JSON.parse(created.body)

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/projects/${id}`,
      headers: { cookie },
      payload: {},
    })

    expect(res.statusCode).toBe(422)
    expect(JSON.parse(res.body).message).toContain('At least one field must be provided')
  })

  it('returns 409 for duplicate slug on patch', async () => {
    const { cookie, orgId } = await registerAndGetCookie(app, 'patch-dupe')
    await prisma.organization.update({ where: { id: orgId }, data: { plan: 'starter' } })

    const slugA = testSlug('patch-dupe-a')
    const slugB = testSlug('patch-dupe-b')

    await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: { cookie },
      payload: { name: 'Project A', slug: slugA },
    })

    const projB = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: { cookie },
      payload: { name: 'Project B', slug: slugB },
    })
    const { id: idB } = JSON.parse(projB.body)

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/projects/${idB}`,
      headers: { cookie },
      payload: { slug: slugA },
    })

    expect(res.statusCode).toBe(409)
    expect(JSON.parse(res.body).message).toContain('slug already exists')
  })

  it('returns 403 when editor tries to patch', async () => {
    const { cookie: ownerCookie, orgId } = await registerAndGetCookie(app, 'patch-editor-org')
    const editorCookie = await createEditorCookie(app, orgId, 'patch-editor')

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: { cookie: ownerCookie },
      payload: { name: 'Editor Patch', slug: testSlug('editor-patch') },
    })
    const { id } = JSON.parse(created.body)

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/projects/${id}`,
      headers: { cookie: editorCookie },
      payload: { name: 'Attempted Update' },
    })

    expect(res.statusCode).toBe(403)
  })

  it('returns 404 for unknown project id', async () => {
    const { cookie } = await registerAndGetCookie(app, 'patch-404')

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/projects/00000000-0000-0000-0000-000000000000',
      headers: { cookie },
      payload: { name: 'Ghost Update' },
    })

    expect(res.statusCode).toBe(404)
  })

  it('returns 404 for project belonging to another org', async () => {
    const { cookie: cookieA } = await registerAndGetCookie(app, 'patch-iso-a')
    const { cookie: cookieB } = await registerAndGetCookie(app, 'patch-iso-b')

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: { cookie: cookieA },
      payload: { name: 'Org A Project', slug: testSlug('patch-iso-a') },
    })
    const { id } = JSON.parse(created.body)

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/projects/${id}`,
      headers: { cookie: cookieB },
      payload: { name: 'Hijacked' },
    })

    expect(res.statusCode).toBe(404)
  })

  it('returns 401 when unauthenticated', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/projects/00000000-0000-0000-0000-000000000000',
      payload: { name: 'No Auth' },
    })
    expect(res.statusCode).toBe(401)
  })
})

// ─── PATCH /api/v1/projects/:id — widgetSettings ─────────────────────────────

const VALID_WIDGET_SETTINGS = {
  showChangelog: true,
  showRoadmap: false,
  showFeatures: true,
  buttonPosition: 'bottom-left',
  primaryColor: '#ff0000',
  backgroundColor: '#ffffff',
}

describe('PATCH /api/v1/projects/:id — widgetSettings', () => {
  it('saves valid widgetSettings and returns 200', async () => {
    const { cookie } = await registerAndGetCookie(app, 'ws-save')
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: { cookie },
      payload: { name: 'WS Save', slug: testSlug('ws-save') },
    })
    const { id } = JSON.parse(created.body)

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/projects/${id}`,
      headers: { cookie },
      payload: { widgetSettings: VALID_WIDGET_SETTINGS },
    })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).widgetSettings).toEqual(VALID_WIDGET_SETTINGS)
  })

  it('persists widgetSettings to DB', async () => {
    const { cookie, orgId } = await registerAndGetCookie(app, 'ws-persist')
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: { cookie },
      payload: { name: 'WS Persist', slug: testSlug('ws-persist') },
    })
    const { id } = JSON.parse(created.body)

    await app.inject({
      method: 'PATCH',
      url: `/api/v1/projects/${id}`,
      headers: { cookie },
      payload: { widgetSettings: VALID_WIDGET_SETTINGS },
    })

    const project = await prisma.project.findFirst({ where: { id, orgId } })
    expect(project!.widgetSettings).toEqual(VALID_WIDGET_SETTINGS)
  })

  it('GET returns updated widgetSettings after PATCH', async () => {
    const { cookie } = await registerAndGetCookie(app, 'ws-get-after-patch')
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: { cookie },
      payload: { name: 'WS Get', slug: testSlug('ws-get') },
    })
    const { id } = JSON.parse(created.body)

    await app.inject({
      method: 'PATCH',
      url: `/api/v1/projects/${id}`,
      headers: { cookie },
      payload: { widgetSettings: VALID_WIDGET_SETTINGS },
    })

    const getRes = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${id}`,
      headers: { cookie },
    })
    expect(getRes.statusCode).toBe(200)
    expect(JSON.parse(getRes.body).widgetSettings).toEqual(VALID_WIDGET_SETTINGS)
  })

  it('returns 422 for partial widgetSettings (missing fields)', async () => {
    const { cookie } = await registerAndGetCookie(app, 'ws-partial')
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: { cookie },
      payload: { name: 'WS Partial', slug: testSlug('ws-partial') },
    })
    const { id } = JSON.parse(created.body)

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/projects/${id}`,
      headers: { cookie },
      payload: { widgetSettings: { showChangelog: true } },
    })

    expect(res.statusCode).toBe(422)
  })

  it('returns 422 for invalid hex primaryColor', async () => {
    const { cookie } = await registerAndGetCookie(app, 'ws-bad-color')
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: { cookie },
      payload: { name: 'WS Bad Color', slug: testSlug('ws-bad-color') },
    })
    const { id } = JSON.parse(created.body)

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/projects/${id}`,
      headers: { cookie },
      payload: {
        widgetSettings: { ...VALID_WIDGET_SETTINGS, primaryColor: 'not-a-hex' },
      },
    })

    expect(res.statusCode).toBe(422)
  })

  it('returns 422 for invalid buttonPosition', async () => {
    const { cookie } = await registerAndGetCookie(app, 'ws-bad-pos')
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: { cookie },
      payload: { name: 'WS Bad Pos', slug: testSlug('ws-bad-pos') },
    })
    const { id } = JSON.parse(created.body)

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/projects/${id}`,
      headers: { cookie },
      payload: {
        widgetSettings: { ...VALID_WIDGET_SETTINGS, buttonPosition: 'middle-center' },
      },
    })

    expect(res.statusCode).toBe(422)
  })
})

// ─── DELETE /api/v1/projects/:id ──────────────────────────────────────────────

describe('DELETE /api/v1/projects/:id', () => {
  it('returns 204 and removes project from database', async () => {
    const { cookie, orgId } = await registerAndGetCookie(app, 'delete-ok')

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: { cookie },
      payload: { name: 'Delete Me', slug: testSlug('delete-me') },
    })
    const { id } = JSON.parse(created.body)

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/projects/${id}`,
      headers: { cookie },
    })

    expect(res.statusCode).toBe(204)
    const gone = await prisma.project.findFirst({ where: { id, orgId } })
    expect(gone).toBeNull()
  })

  it('returns 403 when editor tries to delete', async () => {
    const { cookie: ownerCookie, orgId } = await registerAndGetCookie(app, 'delete-editor-org')
    const editorCookie = await createEditorCookie(app, orgId, 'delete-editor')

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: { cookie: ownerCookie },
      payload: { name: 'Editor Delete', slug: testSlug('editor-delete') },
    })
    const { id } = JSON.parse(created.body)

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/projects/${id}`,
      headers: { cookie: editorCookie },
    })

    expect(res.statusCode).toBe(403)
  })

  it('returns 404 for unknown project id', async () => {
    const { cookie } = await registerAndGetCookie(app, 'delete-404')

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/v1/projects/00000000-0000-0000-0000-000000000000',
      headers: { cookie },
    })

    expect(res.statusCode).toBe(404)
  })

  it('returns 404 for project belonging to another org', async () => {
    const { cookie: cookieA } = await registerAndGetCookie(app, 'delete-iso-a')
    const { cookie: cookieB } = await registerAndGetCookie(app, 'delete-iso-b')

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: { cookie: cookieA },
      payload: { name: 'Org A Project', slug: testSlug('delete-iso-a') },
    })
    const { id } = JSON.parse(created.body)

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/projects/${id}`,
      headers: { cookie: cookieB },
    })

    expect(res.statusCode).toBe(404)
  })

  it('returns 401 when unauthenticated', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/v1/projects/00000000-0000-0000-0000-000000000000',
    })
    expect(res.statusCode).toBe(401)
  })
})
