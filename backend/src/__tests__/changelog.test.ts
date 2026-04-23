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
  return `__TEST__ ${RUN} ${label}`
}

const CONTENT = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello' }] }] }

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
    data: { orgId, email: testEmail(label), passwordHash: hash, name: 'Editor', role: 'editor' },
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

async function createProject(
  app: FastifyInstance,
  cookie: string,
  label: string,
): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/projects',
    headers: { cookie },
    payload: { name: `Project ${label}`, slug: `${label}-${RUN.slice(0, 8)}` },
  })
  expect(res.statusCode).toBe(201)
  return JSON.parse(res.body).id
}

let app: FastifyInstance

beforeAll(async () => {
  await prisma.organization.deleteMany({ where: { name: { contains: RUN } } })
  app = await buildApp()
  // Stub out queue so tests don't write to Redis and can assert job enqueueing
  app.notificationQueue.add = jest.fn().mockResolvedValue({})
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

// ─── GET /api/v1/projects/:projectId/changelog ────────────────────────────────

describe('GET /api/v1/projects/:projectId/changelog', () => {
  it('returns empty array for new project', async () => {
    const { cookie } = await registerAndGetCookie(app, 'list-empty')
    const projectId = await createProject(app, cookie, 'list-empty')

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${projectId}/changelog`,
      headers: { cookie },
    })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual([])
  })

  it('returns entries with expected shape', async () => {
    const { cookie } = await registerAndGetCookie(app, 'list-shape')
    const projectId = await createProject(app, cookie, 'list-shape')

    await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/changelog`,
      headers: { cookie },
      payload: { title: 'My Entry', content: CONTENT },
    })

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${projectId}/changelog`,
      headers: { cookie },
    })

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(Array.isArray(body)).toBe(true)
    expect(body.length).toBe(1)
    expect(body[0].title).toBe('My Entry')
    expect(body[0].status).toBe('draft')
    expect(body[0].publishedAt).toBeNull()
    expect(typeof body[0].id).toBe('string')
    expect(typeof body[0].createdAt).toBe('string')
  })

  it('filters by status=draft', async () => {
    const { cookie } = await registerAndGetCookie(app, 'list-filter-draft')
    const projectId = await createProject(app, cookie, 'list-filter-draft')

    const e1 = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/changelog`,
      headers: { cookie },
      payload: { title: 'Draft Entry', content: CONTENT },
    })
    const entryId = JSON.parse(e1.body).id

    await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/changelog/${entryId}/publish`,
      headers: { cookie },
    })

    await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/changelog`,
      headers: { cookie },
      payload: { title: 'Still Draft', content: CONTENT },
    })

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${projectId}/changelog?status=draft`,
      headers: { cookie },
    })

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.length).toBe(1)
    expect(body[0].title).toBe('Still Draft')
  })

  it('filters by status=published', async () => {
    const { cookie } = await registerAndGetCookie(app, 'list-filter-pub')
    const projectId = await createProject(app, cookie, 'list-filter-pub')

    const e1 = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/changelog`,
      headers: { cookie },
      payload: { title: 'Published Entry', content: CONTENT },
    })
    const entryId = JSON.parse(e1.body).id

    await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/changelog/${entryId}/publish`,
      headers: { cookie },
    })

    await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/changelog`,
      headers: { cookie },
      payload: { title: 'Draft Only', content: CONTENT },
    })

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${projectId}/changelog?status=published`,
      headers: { cookie },
    })

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.length).toBe(1)
    expect(body[0].title).toBe('Published Entry')
  })

  it('returns 404 for unknown project', async () => {
    const { cookie } = await registerAndGetCookie(app, 'list-404-proj')

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/projects/00000000-0000-0000-0000-000000000000/changelog',
      headers: { cookie },
    })

    expect(res.statusCode).toBe(404)
  })

  it('returns 404 for project belonging to another org (isolation)', async () => {
    const { cookie: cookieA } = await registerAndGetCookie(app, 'list-iso-a')
    const { cookie: cookieB } = await registerAndGetCookie(app, 'list-iso-b')
    const projectId = await createProject(app, cookieA, 'list-iso')

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${projectId}/changelog`,
      headers: { cookie: cookieB },
    })

    expect(res.statusCode).toBe(404)
  })

  it('returns 401 when unauthenticated', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/projects/00000000-0000-0000-0000-000000000000/changelog',
    })
    expect(res.statusCode).toBe(401)
  })
})

// ─── POST /api/v1/projects/:projectId/changelog ───────────────────────────────

describe('POST /api/v1/projects/:projectId/changelog', () => {
  it('returns 201 with entry shape (owner)', async () => {
    const { cookie, userId } = await registerAndGetCookie(app, 'create-ok')
    const projectId = await createProject(app, cookie, 'create-ok')

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/changelog`,
      headers: { cookie },
      payload: { title: 'v1.0 Release', content: CONTENT, version: '1.0.0' },
    })

    expect(res.statusCode).toBe(201)
    const body = JSON.parse(res.body)
    expect(typeof body.id).toBe('string')
    expect(body.title).toBe('v1.0 Release')
    expect(body.version).toBe('1.0.0')
    expect(body.status).toBe('draft')
    expect(body.publishedAt).toBeNull()
    expect(body.authorId).toBe(userId)
    expect(body.projectId).toBe(projectId)
  })

  it('persists entry to database', async () => {
    const { cookie } = await registerAndGetCookie(app, 'create-persist')
    const projectId = await createProject(app, cookie, 'create-persist')

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/changelog`,
      headers: { cookie },
      payload: { title: 'Persisted', content: CONTENT },
    })
    const { id } = JSON.parse(res.body)

    const row = await prisma.changelogEntry.findUnique({ where: { id } })
    expect(row).not.toBeNull()
    expect(row!.title).toBe('Persisted')
    expect(row!.status).toBe('draft')
  })

  it('returns 403 when editor tries to create', async () => {
    const { cookie: ownerCookie, orgId } = await registerAndGetCookie(app, 'create-editor-org')
    const editorCookie = await createEditorCookie(app, orgId, 'create-editor')
    const projectId = await createProject(app, ownerCookie, 'create-editor')

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/changelog`,
      headers: { cookie: editorCookie },
      payload: { title: 'Editor Entry', content: CONTENT },
    })

    expect(res.statusCode).toBe(403)
  })

  it('returns 422 when title is missing', async () => {
    const { cookie } = await registerAndGetCookie(app, 'create-no-title')
    const projectId = await createProject(app, cookie, 'create-no-title')

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/changelog`,
      headers: { cookie },
      payload: { content: CONTENT },
    })

    expect(res.statusCode).toBe(422)
  })

  it('returns 422 for invalid categoryId (not a UUID)', async () => {
    const { cookie } = await registerAndGetCookie(app, 'create-bad-cat')
    const projectId = await createProject(app, cookie, 'create-bad-cat')

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/changelog`,
      headers: { cookie },
      payload: { title: 'Bad Cat', content: CONTENT, categoryId: 'not-a-uuid' },
    })

    expect(res.statusCode).toBe(422)
  })

  it('returns 404 for unknown project', async () => {
    const { cookie } = await registerAndGetCookie(app, 'create-404-proj')

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/00000000-0000-0000-0000-000000000000/changelog',
      headers: { cookie },
      payload: { title: 'Ghost Entry', content: CONTENT },
    })

    expect(res.statusCode).toBe(404)
  })

  it('returns 401 when unauthenticated', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/00000000-0000-0000-0000-000000000000/changelog',
      payload: { title: 'No Auth', content: CONTENT },
    })
    expect(res.statusCode).toBe(401)
  })
})

// ─── GET /api/v1/projects/:projectId/changelog/:entryId ──────────────────────

describe('GET /api/v1/projects/:projectId/changelog/:entryId', () => {
  it('returns 200 with entry detail (owner)', async () => {
    const { cookie } = await registerAndGetCookie(app, 'get-detail-owner')
    const projectId = await createProject(app, cookie, 'get-detail-owner')

    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/changelog`,
      headers: { cookie },
      payload: { title: 'Detail Entry', content: CONTENT },
    })
    const { id } = JSON.parse(created.body)

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${projectId}/changelog/${id}`,
      headers: { cookie },
    })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).title).toBe('Detail Entry')
  })

  it('returns 200 for editor (read-only access)', async () => {
    const { cookie: ownerCookie, orgId } = await registerAndGetCookie(app, 'get-detail-editor-org')
    const editorCookie = await createEditorCookie(app, orgId, 'get-detail-editor')
    const projectId = await createProject(app, ownerCookie, 'get-detail-editor')

    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/changelog`,
      headers: { cookie: ownerCookie },
      payload: { title: 'Editor Read', content: CONTENT },
    })
    const { id } = JSON.parse(created.body)

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${projectId}/changelog/${id}`,
      headers: { cookie: editorCookie },
    })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).title).toBe('Editor Read')
  })

  it('returns 404 for unknown entry', async () => {
    const { cookie } = await registerAndGetCookie(app, 'get-404-entry')
    const projectId = await createProject(app, cookie, 'get-404-entry')

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${projectId}/changelog/00000000-0000-0000-0000-000000000000`,
      headers: { cookie },
    })

    expect(res.statusCode).toBe(404)
  })

  it('returns 404 for project belonging to another org (isolation)', async () => {
    const { cookie: cookieA } = await registerAndGetCookie(app, 'get-iso-a')
    const { cookie: cookieB } = await registerAndGetCookie(app, 'get-iso-b')
    const projectId = await createProject(app, cookieA, 'get-iso')

    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/changelog`,
      headers: { cookie: cookieA },
      payload: { title: 'Org A Entry', content: CONTENT },
    })
    const { id } = JSON.parse(created.body)

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${projectId}/changelog/${id}`,
      headers: { cookie: cookieB },
    })

    expect(res.statusCode).toBe(404)
  })

  it('returns 401 when unauthenticated', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/projects/00000000-0000-0000-0000-000000000000/changelog/00000000-0000-0000-0000-000000000000',
    })
    expect(res.statusCode).toBe(401)
  })
})

// ─── PATCH /api/v1/projects/:projectId/changelog/:entryId ────────────────────

describe('PATCH /api/v1/projects/:projectId/changelog/:entryId', () => {
  it('returns 200 with updated title', async () => {
    const { cookie } = await registerAndGetCookie(app, 'patch-title')
    const projectId = await createProject(app, cookie, 'patch-title')

    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/changelog`,
      headers: { cookie },
      payload: { title: 'Original Title', content: CONTENT },
    })
    const { id } = JSON.parse(created.body)

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/projects/${projectId}/changelog/${id}`,
      headers: { cookie },
      payload: { title: 'Updated Title' },
    })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).title).toBe('Updated Title')
  })

  it('can null out version field', async () => {
    const { cookie } = await registerAndGetCookie(app, 'patch-null-version')
    const projectId = await createProject(app, cookie, 'patch-null-version')

    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/changelog`,
      headers: { cookie },
      payload: { title: 'Versioned', content: CONTENT, version: '2.0' },
    })
    const { id } = JSON.parse(created.body)

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/projects/${projectId}/changelog/${id}`,
      headers: { cookie },
      payload: { version: null },
    })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).version).toBeNull()
  })

  it('returns 422 for empty body', async () => {
    const { cookie } = await registerAndGetCookie(app, 'patch-empty')
    const projectId = await createProject(app, cookie, 'patch-empty')

    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/changelog`,
      headers: { cookie },
      payload: { title: 'Patch Target', content: CONTENT },
    })
    const { id } = JSON.parse(created.body)

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/projects/${projectId}/changelog/${id}`,
      headers: { cookie },
      payload: {},
    })

    expect(res.statusCode).toBe(422)
    expect(JSON.parse(res.body).message).toContain('At least one field must be provided')
  })

  it('returns 403 when editor tries to patch', async () => {
    const { cookie: ownerCookie, orgId } = await registerAndGetCookie(app, 'patch-editor-org')
    const editorCookie = await createEditorCookie(app, orgId, 'patch-editor')
    const projectId = await createProject(app, ownerCookie, 'patch-editor')

    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/changelog`,
      headers: { cookie: ownerCookie },
      payload: { title: 'Editor Cannot Patch', content: CONTENT },
    })
    const { id } = JSON.parse(created.body)

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/projects/${projectId}/changelog/${id}`,
      headers: { cookie: editorCookie },
      payload: { title: 'Hijacked' },
    })

    expect(res.statusCode).toBe(403)
  })

  it('returns 404 for unknown entry', async () => {
    const { cookie } = await registerAndGetCookie(app, 'patch-404')
    const projectId = await createProject(app, cookie, 'patch-404')

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/projects/${projectId}/changelog/00000000-0000-0000-0000-000000000000`,
      headers: { cookie },
      payload: { title: 'Ghost' },
    })

    expect(res.statusCode).toBe(404)
  })

  it('returns 404 for entry belonging to another org', async () => {
    const { cookie: cookieA } = await registerAndGetCookie(app, 'patch-iso-a')
    const { cookie: cookieB } = await registerAndGetCookie(app, 'patch-iso-b')
    const projectId = await createProject(app, cookieA, 'patch-iso')

    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/changelog`,
      headers: { cookie: cookieA },
      payload: { title: 'Org A Entry', content: CONTENT },
    })
    const { id } = JSON.parse(created.body)

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/projects/${projectId}/changelog/${id}`,
      headers: { cookie: cookieB },
      payload: { title: 'Hijacked' },
    })

    expect(res.statusCode).toBe(404)
  })
})

// ─── DELETE /api/v1/projects/:projectId/changelog/:entryId ───────────────────

describe('DELETE /api/v1/projects/:projectId/changelog/:entryId', () => {
  it('returns 204 and removes entry from database', async () => {
    const { cookie } = await registerAndGetCookie(app, 'delete-ok')
    const projectId = await createProject(app, cookie, 'delete-ok')

    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/changelog`,
      headers: { cookie },
      payload: { title: 'Delete Me', content: CONTENT },
    })
    const { id } = JSON.parse(created.body)

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/projects/${projectId}/changelog/${id}`,
      headers: { cookie },
    })

    expect(res.statusCode).toBe(204)
    const gone = await prisma.changelogEntry.findUnique({ where: { id } })
    expect(gone).toBeNull()
  })

  it('returns 403 when editor tries to delete', async () => {
    const { cookie: ownerCookie, orgId } = await registerAndGetCookie(app, 'delete-editor-org')
    const editorCookie = await createEditorCookie(app, orgId, 'delete-editor')
    const projectId = await createProject(app, ownerCookie, 'delete-editor')

    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/changelog`,
      headers: { cookie: ownerCookie },
      payload: { title: 'Editor Cannot Delete', content: CONTENT },
    })
    const { id } = JSON.parse(created.body)

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/projects/${projectId}/changelog/${id}`,
      headers: { cookie: editorCookie },
    })

    expect(res.statusCode).toBe(403)
  })

  it('returns 404 for unknown entry', async () => {
    const { cookie } = await registerAndGetCookie(app, 'delete-404')
    const projectId = await createProject(app, cookie, 'delete-404')

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/projects/${projectId}/changelog/00000000-0000-0000-0000-000000000000`,
      headers: { cookie },
    })

    expect(res.statusCode).toBe(404)
  })

  it('returns 404 for entry belonging to another org (isolation)', async () => {
    const { cookie: cookieA } = await registerAndGetCookie(app, 'delete-iso-a')
    const { cookie: cookieB } = await registerAndGetCookie(app, 'delete-iso-b')
    const projectId = await createProject(app, cookieA, 'delete-iso')

    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/changelog`,
      headers: { cookie: cookieA },
      payload: { title: 'Org A Entry', content: CONTENT },
    })
    const { id } = JSON.parse(created.body)

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/projects/${projectId}/changelog/${id}`,
      headers: { cookie: cookieB },
    })

    expect(res.statusCode).toBe(404)
  })
})

// ─── POST .../publish ─────────────────────────────────────────────────────────

describe('POST /api/v1/projects/:projectId/changelog/:entryId/publish', () => {
  it('sets status=published and publishedAt', async () => {
    const { cookie } = await registerAndGetCookie(app, 'publish-ok')
    const projectId = await createProject(app, cookie, 'publish-ok')

    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/changelog`,
      headers: { cookie },
      payload: { title: 'To Publish', content: CONTENT },
    })
    const { id } = JSON.parse(created.body)

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/changelog/${id}/publish`,
      headers: { cookie },
    })

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.status).toBe('published')
    expect(body.publishedAt).not.toBeNull()
  })

  it('is idempotent — republishing preserves original publishedAt', async () => {
    const { cookie } = await registerAndGetCookie(app, 'publish-idempotent')
    const projectId = await createProject(app, cookie, 'publish-idempotent')

    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/changelog`,
      headers: { cookie },
      payload: { title: 'Republish', content: CONTENT },
    })
    const { id } = JSON.parse(created.body)

    const first = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/changelog/${id}/publish`,
      headers: { cookie },
    })
    const firstPublishedAt = JSON.parse(first.body).publishedAt

    // Small delay to ensure any clock-based re-publish would produce a different timestamp
    await new Promise((r) => setTimeout(r, 10))

    const second = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/changelog/${id}/publish`,
      headers: { cookie },
    })

    expect(second.statusCode).toBe(200)
    expect(JSON.parse(second.body).status).toBe('published')
    // publishedAt must not be overwritten — RSS feeds and notification workers key on this value
    expect(JSON.parse(second.body).publishedAt).toBe(firstPublishedAt)
  })

  it('persists published state to database', async () => {
    const { cookie } = await registerAndGetCookie(app, 'publish-persist')
    const projectId = await createProject(app, cookie, 'publish-persist')

    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/changelog`,
      headers: { cookie },
      payload: { title: 'DB Publish', content: CONTENT },
    })
    const { id } = JSON.parse(created.body)

    await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/changelog/${id}/publish`,
      headers: { cookie },
    })

    const row = await prisma.changelogEntry.findUnique({ where: { id } })
    expect(row!.status).toBe('published')
    expect(row!.publishedAt).not.toBeNull()
  })

  it('returns 403 when editor tries to publish', async () => {
    const { cookie: ownerCookie, orgId } = await registerAndGetCookie(app, 'publish-editor-org')
    const editorCookie = await createEditorCookie(app, orgId, 'publish-editor')
    const projectId = await createProject(app, ownerCookie, 'publish-editor')

    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/changelog`,
      headers: { cookie: ownerCookie },
      payload: { title: 'Editor Cannot Publish', content: CONTENT },
    })
    const { id } = JSON.parse(created.body)

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/changelog/${id}/publish`,
      headers: { cookie: editorCookie },
    })

    expect(res.statusCode).toBe(403)
  })

  it('returns 404 for unknown entry', async () => {
    const { cookie } = await registerAndGetCookie(app, 'publish-404')
    const projectId = await createProject(app, cookie, 'publish-404')

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/changelog/00000000-0000-0000-0000-000000000000/publish`,
      headers: { cookie },
    })

    expect(res.statusCode).toBe(404)
  })

  it('returns 404 for entry belonging to another org (isolation)', async () => {
    const { cookie: cookieA } = await registerAndGetCookie(app, 'publish-iso-a')
    const { cookie: cookieB } = await registerAndGetCookie(app, 'publish-iso-b')
    const projectId = await createProject(app, cookieA, 'publish-iso')

    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/changelog`,
      headers: { cookie: cookieA },
      payload: { title: 'Org A Entry', content: CONTENT },
    })
    const { id } = JSON.parse(created.body)

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/changelog/${id}/publish`,
      headers: { cookie: cookieB },
    })

    expect(res.statusCode).toBe(404)
  })

  it('returns 401 when unauthenticated', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/00000000-0000-0000-0000-000000000000/changelog/00000000-0000-0000-0000-000000000000/publish',
    })
    expect(res.statusCode).toBe(401)
  })

  it('enqueues changelog_published job on first publish', async () => {
    const { cookie } = await registerAndGetCookie(app, 'publish-queue-first')
    const projectId = await createProject(app, cookie, 'publish-queue-first')

    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/changelog`,
      headers: { cookie },
      payload: { title: 'Queue Test', content: CONTENT },
    })
    const { id } = JSON.parse(created.body)

    const addSpy = app.notificationQueue.add as jest.Mock
    addSpy.mockClear()

    await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/changelog/${id}/publish`,
      headers: { cookie },
    })

    expect(addSpy).toHaveBeenCalledTimes(1)
    expect(addSpy).toHaveBeenCalledWith('changelog_published', {
      type: 'changelog_published',
      referenceId: id,
      projectId,
    })
  })

  it('does not enqueue job on re-publish of already-published entry', async () => {
    const { cookie } = await registerAndGetCookie(app, 'publish-queue-idempotent')
    const projectId = await createProject(app, cookie, 'publish-queue-idempotent')

    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/changelog`,
      headers: { cookie },
      payload: { title: 'Idempotent Queue', content: CONTENT },
    })
    const { id } = JSON.parse(created.body)

    // First publish
    await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/changelog/${id}/publish`,
      headers: { cookie },
    })

    const addSpy = app.notificationQueue.add as jest.Mock
    addSpy.mockClear()

    // Second publish — entry already published, no job
    await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/changelog/${id}/publish`,
      headers: { cookie },
    })

    expect(addSpy).not.toHaveBeenCalled()
  })

  it('re-enqueues job after unpublish then republish (worker dedup handles duplicates)', async () => {
    const { cookie } = await registerAndGetCookie(app, 'publish-queue-requeue')
    const projectId = await createProject(app, cookie, 'publish-queue-requeue')

    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/changelog`,
      headers: { cookie },
      payload: { title: 'Requeue Test', content: CONTENT },
    })
    const { id } = JSON.parse(created.body)

    // First publish — enqueues
    await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/changelog/${id}/publish`,
      headers: { cookie },
    })

    // Unpublish — clears publishedAt
    await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/changelog/${id}/unpublish`,
      headers: { cookie },
    })

    const addSpy = app.notificationQueue.add as jest.Mock
    addSpy.mockClear()

    // Re-publish — publishedAt was null, so job is enqueued again
    // Worker dedup (notification_logs check) prevents actual duplicate email delivery
    await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/changelog/${id}/publish`,
      headers: { cookie },
    })

    expect(addSpy).toHaveBeenCalledTimes(1)
    expect(addSpy).toHaveBeenCalledWith('changelog_published', {
      type: 'changelog_published',
      referenceId: id,
      projectId,
    })
  })
})

// ─── POST .../unpublish ───────────────────────────────────────────────────────

describe('POST /api/v1/projects/:projectId/changelog/:entryId/unpublish', () => {
  it('reverts status to draft and nulls publishedAt', async () => {
    const { cookie } = await registerAndGetCookie(app, 'unpublish-ok')
    const projectId = await createProject(app, cookie, 'unpublish-ok')

    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/changelog`,
      headers: { cookie },
      payload: { title: 'Unpublish Me', content: CONTENT },
    })
    const { id } = JSON.parse(created.body)

    await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/changelog/${id}/publish`,
      headers: { cookie },
    })

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/changelog/${id}/unpublish`,
      headers: { cookie },
    })

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.status).toBe('draft')
    expect(body.publishedAt).toBeNull()
  })

  it('is idempotent — unpublishing a draft returns 200', async () => {
    const { cookie } = await registerAndGetCookie(app, 'unpublish-idempotent')
    const projectId = await createProject(app, cookie, 'unpublish-idempotent')

    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/changelog`,
      headers: { cookie },
      payload: { title: 'Already Draft', content: CONTENT },
    })
    const { id } = JSON.parse(created.body)

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/changelog/${id}/unpublish`,
      headers: { cookie },
    })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).status).toBe('draft')
  })

  it('persists draft state to database', async () => {
    const { cookie } = await registerAndGetCookie(app, 'unpublish-persist')
    const projectId = await createProject(app, cookie, 'unpublish-persist')

    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/changelog`,
      headers: { cookie },
      payload: { title: 'DB Unpublish', content: CONTENT },
    })
    const { id } = JSON.parse(created.body)

    await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/changelog/${id}/publish`,
      headers: { cookie },
    })
    await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/changelog/${id}/unpublish`,
      headers: { cookie },
    })

    const row = await prisma.changelogEntry.findUnique({ where: { id } })
    expect(row!.status).toBe('draft')
    expect(row!.publishedAt).toBeNull()
  })

  it('returns 403 when editor tries to unpublish', async () => {
    const { cookie: ownerCookie, orgId } = await registerAndGetCookie(app, 'unpublish-editor-org')
    const editorCookie = await createEditorCookie(app, orgId, 'unpublish-editor')
    const projectId = await createProject(app, ownerCookie, 'unpublish-editor')

    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/changelog`,
      headers: { cookie: ownerCookie },
      payload: { title: 'Editor Cannot Unpublish', content: CONTENT },
    })
    const { id } = JSON.parse(created.body)

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/changelog/${id}/unpublish`,
      headers: { cookie: editorCookie },
    })

    expect(res.statusCode).toBe(403)
  })

  it('returns 404 for unknown entry', async () => {
    const { cookie } = await registerAndGetCookie(app, 'unpublish-404')
    const projectId = await createProject(app, cookie, 'unpublish-404')

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/changelog/00000000-0000-0000-0000-000000000000/unpublish`,
      headers: { cookie },
    })

    expect(res.statusCode).toBe(404)
  })

  it('returns 404 for entry belonging to another org (isolation)', async () => {
    const { cookie: cookieA } = await registerAndGetCookie(app, 'unpublish-iso-a')
    const { cookie: cookieB } = await registerAndGetCookie(app, 'unpublish-iso-b')
    const projectId = await createProject(app, cookieA, 'unpublish-iso')

    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/changelog`,
      headers: { cookie: cookieA },
      payload: { title: 'Org A Entry', content: CONTENT },
    })
    const { id } = JSON.parse(created.body)

    await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/changelog/${id}/publish`,
      headers: { cookie: cookieA },
    })

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/changelog/${id}/unpublish`,
      headers: { cookie: cookieB },
    })

    expect(res.statusCode).toBe(404)
  })

  it('returns 401 when unauthenticated', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/00000000-0000-0000-0000-000000000000/changelog/00000000-0000-0000-0000-000000000000/unpublish',
    })
    expect(res.statusCode).toBe(401)
  })
})

// ─── Content / version / categoryId validation ────────────────────────────────

describe('content schema validation', () => {
  it('returns 422 for content missing type:doc', async () => {
    const { cookie } = await registerAndGetCookie(app, 'content-no-type')
    const projectId = await createProject(app, cookie, 'content-no-type')

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/changelog`,
      headers: { cookie },
      payload: { title: 'Bad Content', content: { foo: 'bar' } },
    })

    expect(res.statusCode).toBe(422)
    expect(JSON.parse(res.body).message).toContain('TipTap doc node')
  })

  it('returns 422 for empty content object', async () => {
    const { cookie } = await registerAndGetCookie(app, 'content-empty')
    const projectId = await createProject(app, cookie, 'content-empty')

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/changelog`,
      headers: { cookie },
      payload: { title: 'Empty Content', content: {} },
    })

    expect(res.statusCode).toBe(422)
  })

  it('returns 422 for empty version string on create', async () => {
    const { cookie } = await registerAndGetCookie(app, 'version-empty-create')
    const projectId = await createProject(app, cookie, 'version-empty-create')

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/changelog`,
      headers: { cookie },
      payload: { title: 'Empty Version', content: CONTENT, version: '' },
    })

    expect(res.statusCode).toBe(422)
    expect(JSON.parse(res.body).message).toContain('Version cannot be empty')
  })

  it('returns 422 for empty version string on patch', async () => {
    const { cookie } = await registerAndGetCookie(app, 'version-empty-patch')
    const projectId = await createProject(app, cookie, 'version-empty-patch')

    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/changelog`,
      headers: { cookie },
      payload: { title: 'Entry', content: CONTENT },
    })
    const { id } = JSON.parse(created.body)

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/projects/${projectId}/changelog/${id}`,
      headers: { cookie },
      payload: { version: '' },
    })

    expect(res.statusCode).toBe(422)
    expect(JSON.parse(res.body).message).toContain('Version cannot be empty')
  })
})

// ─── Cross-project categoryId validation ─────────────────────────────────────

describe('categoryId cross-project validation', () => {
  it('returns 422 on create when categoryId belongs to a different project', async () => {
    const { cookie, orgId } = await registerAndGetCookie(app, 'cat-iso-create')
    await prisma.organization.update({ where: { id: orgId }, data: { plan: 'starter' } })
    const projectA = await createProject(app, cookie, 'cat-iso-a')
    const projectB = await createProject(app, cookie, 'cat-iso-b')

    const cat = await prisma.changelogCategory.create({
      data: { projectId: projectB, name: 'Cat B', slug: `cat-b-${RUN.slice(0, 6)}`, color: '#000000' },
    })

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectA}/changelog`,
      headers: { cookie },
      payload: { title: 'Cross Cat Entry', content: CONTENT, categoryId: cat.id },
    })

    expect(res.statusCode).toBe(422)
    expect(JSON.parse(res.body).message).toContain('Category not found in this project')
  })

  it('returns 422 on patch when categoryId belongs to a different project', async () => {
    const { cookie, orgId } = await registerAndGetCookie(app, 'cat-iso-patch')
    await prisma.organization.update({ where: { id: orgId }, data: { plan: 'starter' } })
    const projectA = await createProject(app, cookie, 'cat-iso-patch-a')
    const projectB = await createProject(app, cookie, 'cat-iso-patch-b')

    const cat = await prisma.changelogCategory.create({
      data: { projectId: projectB, name: 'Cat B Patch', slug: `cat-bp-${RUN.slice(0, 6)}`, color: '#ffffff' },
    })

    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectA}/changelog`,
      headers: { cookie },
      payload: { title: 'Entry', content: CONTENT },
    })
    const { id } = JSON.parse(created.body)

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/projects/${projectA}/changelog/${id}`,
      headers: { cookie },
      payload: { categoryId: cat.id },
    })

    expect(res.statusCode).toBe(422)
    expect(JSON.parse(res.body).message).toContain('Category not found in this project')
  })
})

// ─── Archived entry guard ─────────────────────────────────────────────────────

describe('archived entry guard', () => {
  it('returns 409 when patching an archived entry', async () => {
    const { cookie } = await registerAndGetCookie(app, 'patch-archived')
    const projectId = await createProject(app, cookie, 'patch-archived')

    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/changelog`,
      headers: { cookie },
      payload: { title: 'To Archive', content: CONTENT },
    })
    const { id } = JSON.parse(created.body)

    await prisma.changelogEntry.update({ where: { id }, data: { status: 'archived' } })

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/projects/${projectId}/changelog/${id}`,
      headers: { cookie },
      payload: { title: 'Edit Archived' },
    })

    expect(res.statusCode).toBe(409)
    expect(JSON.parse(res.body).message).toContain('Archived entries cannot be edited')
  })
})
