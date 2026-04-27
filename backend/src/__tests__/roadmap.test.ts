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

async function createItem(
  app: FastifyInstance,
  cookie: string,
  projectId: string,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: `/api/v1/projects/${projectId}/roadmap`,
    headers: { cookie },
    payload: { title: 'My Feature', ...overrides },
  })
  expect(res.statusCode).toBe(201)
  return JSON.parse(res.body).id
}

let app: FastifyInstance

beforeAll(async () => {
  await prisma.organization.deleteMany({ where: { name: { contains: RUN } } })
  app = await buildApp()
  // Stub queue so tests don't write to Redis
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

// ─── GET /api/v1/projects/:projectId/roadmap ──────────────────────────────────

describe('GET /api/v1/projects/:projectId/roadmap', () => {
  it('returns empty array for new project', async () => {
    const { cookie } = await registerAndGetCookie(app, 'get-empty')
    const projectId = await createProject(app, cookie, 'get-empty')

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${projectId}/roadmap`,
      headers: { cookie },
    })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual([])
  })

  it('returns items with expected shape', async () => {
    const { cookie } = await registerAndGetCookie(app, 'get-shape')
    const projectId = await createProject(app, cookie, 'get-shape')
    await createItem(app, cookie, projectId, { title: 'Dark Mode', description: 'Add dark theme' })

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${projectId}/roadmap`,
      headers: { cookie },
    })

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(Array.isArray(body)).toBe(true)
    expect(body.length).toBe(1)
    expect(body[0].title).toBe('Dark Mode')
    expect(body[0].description).toBe('Add dark theme')
    expect(body[0].status).toBe('planned')
    expect(body[0].displayOrder).toBe(0)
    expect(typeof body[0].id).toBe('string')
    expect(typeof body[0].projectId).toBe('string')
    expect(typeof body[0].createdAt).toBe('string')
  })

  it('filters by status', async () => {
    const { cookie } = await registerAndGetCookie(app, 'get-filter')
    const projectId = await createProject(app, cookie, 'get-filter')
    await createItem(app, cookie, projectId, { title: 'Planned Item', status: 'planned' })
    await createItem(app, cookie, projectId, { title: 'Shipped Item', status: 'shipped' })

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${projectId}/roadmap?status=shipped`,
      headers: { cookie },
    })

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.length).toBe(1)
    expect(body[0].title).toBe('Shipped Item')
  })

  it('returns 401 when unauthenticated', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${crypto.randomUUID()}/roadmap`,
    })
    expect(res.statusCode).toBe(401)
  })

  it('returns 404 for project belonging to another org', async () => {
    const { cookie: cookieA } = await registerAndGetCookie(app, 'get-xorg-a')
    const { cookie: cookieB } = await registerAndGetCookie(app, 'get-xorg-b')
    const projectId = await createProject(app, cookieA, 'get-xorg-a')

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${projectId}/roadmap`,
      headers: { cookie: cookieB },
    })
    expect(res.statusCode).toBe(404)
  })
})

// ─── GET /api/v1/projects/:projectId/roadmap/:itemId ─────────────────────────

describe('GET /api/v1/projects/:projectId/roadmap/:itemId', () => {
  it('returns item with expected shape', async () => {
    const { cookie } = await registerAndGetCookie(app, 'get-detail-shape')
    const projectId = await createProject(app, cookie, 'get-detail-shape')
    const itemId = await createItem(app, cookie, projectId, { title: 'Detail Item', description: 'Some desc' })

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${projectId}/roadmap/${itemId}`,
      headers: { cookie },
    })

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.id).toBe(itemId)
    expect(body.title).toBe('Detail Item')
    expect(body.description).toBe('Some desc')
    expect(body.status).toBe('planned')
    expect(body.projectId).toBe(projectId)
  })

  it('returns 404 for non-existent item', async () => {
    const { cookie } = await registerAndGetCookie(app, 'get-detail-404')
    const projectId = await createProject(app, cookie, 'get-detail-404')

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${projectId}/roadmap/${crypto.randomUUID()}`,
      headers: { cookie },
    })
    expect(res.statusCode).toBe(404)
  })

  it('returns 404 for non-UUID itemId', async () => {
    const { cookie } = await registerAndGetCookie(app, 'get-detail-bad-uuid')
    const projectId = await createProject(app, cookie, 'get-detail-bad-uuid')

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${projectId}/roadmap/not-a-uuid`,
      headers: { cookie },
    })
    expect(res.statusCode).toBe(404)
  })

  it('returns 404 for item belonging to another project', async () => {
    const { cookie, orgId } = await registerAndGetCookie(app, 'get-detail-xproject')
    await prisma.organization.update({ where: { id: orgId }, data: { plan: 'starter' } })
    const projectA = await createProject(app, cookie, 'get-detail-xproject-a')
    const projectB = await createProject(app, cookie, 'get-detail-xproject-b')
    const itemId = await createItem(app, cookie, projectA)

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${projectB}/roadmap/${itemId}`,
      headers: { cookie },
    })
    expect(res.statusCode).toBe(404)
  })

  it('returns 401 when unauthenticated', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${crypto.randomUUID()}/roadmap/${crypto.randomUUID()}`,
    })
    expect(res.statusCode).toBe(401)
  })
})

// ─── POST /api/v1/projects/:projectId/roadmap ─────────────────────────────────

describe('POST /api/v1/projects/:projectId/roadmap', () => {
  it('creates item and returns 201 with expected shape', async () => {
    const { cookie } = await registerAndGetCookie(app, 'post-create')
    const projectId = await createProject(app, cookie, 'post-create')

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/roadmap`,
      headers: { cookie },
      payload: { title: 'New Feature', description: 'Details here', status: 'in_progress' },
    })

    expect(res.statusCode).toBe(201)
    const body = JSON.parse(res.body)
    expect(body.title).toBe('New Feature')
    expect(body.description).toBe('Details here')
    expect(body.status).toBe('in_progress')
    expect(body.displayOrder).toBe(0)
    expect(body.projectId).toBe(projectId)
  })

  it('defaults status to planned when omitted', async () => {
    const { cookie } = await registerAndGetCookie(app, 'post-default-status')
    const projectId = await createProject(app, cookie, 'post-default-status')

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/roadmap`,
      headers: { cookie },
      payload: { title: 'No Status' },
    })

    expect(res.statusCode).toBe(201)
    expect(JSON.parse(res.body).status).toBe('planned')
  })

  it('increments displayOrder for each new item', async () => {
    const { cookie } = await registerAndGetCookie(app, 'post-order')
    const projectId = await createProject(app, cookie, 'post-order')

    const r1 = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/roadmap`,
      headers: { cookie },
      payload: { title: 'First' },
    })
    const r2 = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/roadmap`,
      headers: { cookie },
      payload: { title: 'Second' },
    })
    const r3 = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/roadmap`,
      headers: { cookie },
      payload: { title: 'Third' },
    })

    expect(JSON.parse(r1.body).displayOrder).toBe(0)
    expect(JSON.parse(r2.body).displayOrder).toBe(1)
    expect(JSON.parse(r3.body).displayOrder).toBe(2)
  })

  it('returns 403 for editor', async () => {
    const { cookie, orgId } = await registerAndGetCookie(app, 'post-editor')
    const projectId = await createProject(app, cookie, 'post-editor')
    const editorCookie = await createEditorCookie(app, orgId, 'post-editor-e')

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/roadmap`,
      headers: { cookie: editorCookie },
      payload: { title: 'Not Allowed' },
    })
    expect(res.statusCode).toBe(403)
  })

  it('returns 422 when title is missing', async () => {
    const { cookie } = await registerAndGetCookie(app, 'post-no-title')
    const projectId = await createProject(app, cookie, 'post-no-title')

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/roadmap`,
      headers: { cookie },
      payload: { description: 'No title here' },
    })
    expect(res.statusCode).toBe(422)
  })

  it('returns 422 when status is invalid', async () => {
    const { cookie } = await registerAndGetCookie(app, 'post-bad-status')
    const projectId = await createProject(app, cookie, 'post-bad-status')

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/roadmap`,
      headers: { cookie },
      payload: { title: 'Oops', status: 'unknown' },
    })
    expect(res.statusCode).toBe(422)
  })

  it('returns 404 for project belonging to another org', async () => {
    const { cookie: cookieA } = await registerAndGetCookie(app, 'post-xorg-a')
    const { cookie: cookieB } = await registerAndGetCookie(app, 'post-xorg-b')
    const projectId = await createProject(app, cookieA, 'post-xorg-a')

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/roadmap`,
      headers: { cookie: cookieB },
      payload: { title: 'Cross-org' },
    })
    expect(res.statusCode).toBe(404)
  })
})

// ─── PATCH /api/v1/projects/:projectId/roadmap/:itemId ───────────────────────

describe('PATCH /api/v1/projects/:projectId/roadmap/:itemId', () => {
  it('updates title only', async () => {
    const { cookie } = await registerAndGetCookie(app, 'patch-title')
    const projectId = await createProject(app, cookie, 'patch-title')
    const itemId = await createItem(app, cookie, projectId)

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/projects/${projectId}/roadmap/${itemId}`,
      headers: { cookie },
      payload: { title: 'Updated Title' },
    })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).title).toBe('Updated Title')
  })

  it('updates status only', async () => {
    const { cookie } = await registerAndGetCookie(app, 'patch-status')
    const projectId = await createProject(app, cookie, 'patch-status')
    const itemId = await createItem(app, cookie, projectId)

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/projects/${projectId}/roadmap/${itemId}`,
      headers: { cookie },
      payload: { status: 'shipped' },
    })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).status).toBe('shipped')
  })

  it('sets description to null', async () => {
    const { cookie } = await registerAndGetCookie(app, 'patch-null-desc')
    const projectId = await createProject(app, cookie, 'patch-null-desc')
    const itemId = await createItem(app, cookie, projectId, { description: 'Old description' })

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/projects/${projectId}/roadmap/${itemId}`,
      headers: { cookie },
      payload: { description: null },
    })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).description).toBeNull()
  })

  it('returns 422 when body is empty', async () => {
    const { cookie } = await registerAndGetCookie(app, 'patch-empty')
    const projectId = await createProject(app, cookie, 'patch-empty')
    const itemId = await createItem(app, cookie, projectId)

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/projects/${projectId}/roadmap/${itemId}`,
      headers: { cookie },
      payload: {},
    })
    expect(res.statusCode).toBe(422)
  })

  it('returns 404 for non-UUID itemId', async () => {
    const { cookie } = await registerAndGetCookie(app, 'patch-bad-uuid')
    const projectId = await createProject(app, cookie, 'patch-bad-uuid')

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/projects/${projectId}/roadmap/not-a-uuid`,
      headers: { cookie },
      payload: { title: 'X' },
    })
    expect(res.statusCode).toBe(404)
  })

  it('returns 404 for item belonging to another project', async () => {
    const { cookie, orgId } = await registerAndGetCookie(app, 'patch-xproject')
    // Upgrade to starter so the org can hold 2 projects
    await prisma.organization.update({ where: { id: orgId }, data: { plan: 'starter' } })
    const projectA = await createProject(app, cookie, 'patch-xproject-a')
    const projectB = await createProject(app, cookie, 'patch-xproject-b')
    const itemId = await createItem(app, cookie, projectA)

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/projects/${projectB}/roadmap/${itemId}`,
      headers: { cookie },
      payload: { title: 'Cross-project' },
    })
    expect(res.statusCode).toBe(404)
  })

  it('returns 403 for editor', async () => {
    const { cookie, orgId } = await registerAndGetCookie(app, 'patch-editor')
    const projectId = await createProject(app, cookie, 'patch-editor')
    const itemId = await createItem(app, cookie, projectId)
    const editorCookie = await createEditorCookie(app, orgId, 'patch-editor-e')

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/projects/${projectId}/roadmap/${itemId}`,
      headers: { cookie: editorCookie },
      payload: { title: 'Not allowed' },
    })
    expect(res.statusCode).toBe(403)
  })
})

// ─── DELETE /api/v1/projects/:projectId/roadmap/:itemId ──────────────────────

describe('DELETE /api/v1/projects/:projectId/roadmap/:itemId', () => {
  it('deletes item and returns 204', async () => {
    const { cookie } = await registerAndGetCookie(app, 'del-ok')
    const projectId = await createProject(app, cookie, 'del-ok')
    const itemId = await createItem(app, cookie, projectId)

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/projects/${projectId}/roadmap/${itemId}`,
      headers: { cookie },
    })
    expect(res.statusCode).toBe(204)
  })

  it('returns 404 on second delete (idempotency)', async () => {
    const { cookie } = await registerAndGetCookie(app, 'del-idem')
    const projectId = await createProject(app, cookie, 'del-idem')
    const itemId = await createItem(app, cookie, projectId)

    await app.inject({ method: 'DELETE', url: `/api/v1/projects/${projectId}/roadmap/${itemId}`, headers: { cookie } })
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/projects/${projectId}/roadmap/${itemId}`,
      headers: { cookie },
    })
    expect(res.statusCode).toBe(404)
  })

  it('returns 403 for editor', async () => {
    const { cookie, orgId } = await registerAndGetCookie(app, 'del-editor')
    const projectId = await createProject(app, cookie, 'del-editor')
    const itemId = await createItem(app, cookie, projectId)
    const editorCookie = await createEditorCookie(app, orgId, 'del-editor-e')

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/projects/${projectId}/roadmap/${itemId}`,
      headers: { cookie: editorCookie },
    })
    expect(res.statusCode).toBe(403)
  })

  it('returns 404 for item belonging to another org', async () => {
    const { cookie: cookieA } = await registerAndGetCookie(app, 'del-xorg-a')
    const { cookie: cookieB } = await registerAndGetCookie(app, 'del-xorg-b')
    const projectId = await createProject(app, cookieA, 'del-xorg-a')
    const itemId = await createItem(app, cookieA, projectId)

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/projects/${projectId}/roadmap/${itemId}`,
      headers: { cookie: cookieB },
    })
    expect(res.statusCode).toBe(404)
  })
})

// ─── PATCH /api/v1/projects/:projectId/roadmap/reorder ───────────────────────

describe('PATCH /api/v1/projects/:projectId/roadmap/reorder', () => {
  it('persists new displayOrder values', async () => {
    const { cookie } = await registerAndGetCookie(app, 'reorder-ok')
    const projectId = await createProject(app, cookie, 'reorder-ok')
    const idA = await createItem(app, cookie, projectId, { title: 'A' })
    const idB = await createItem(app, cookie, projectId, { title: 'B' })

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/projects/${projectId}/roadmap/reorder`,
      headers: { cookie },
      payload: {
        items: [
          { id: idA, displayOrder: 10 },
          { id: idB, displayOrder: 5 },
        ],
      },
    })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).updated).toBe(2)

    // Verify persistence
    const list = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${projectId}/roadmap`,
      headers: { cookie },
    })
    const items = JSON.parse(list.body)
    // Ordered by displayOrder asc, so B (5) comes first
    expect(items[0].id).toBe(idB)
    expect(items[1].id).toBe(idA)
  })

  it('returns 422 for empty items array', async () => {
    const { cookie } = await registerAndGetCookie(app, 'reorder-empty')
    const projectId = await createProject(app, cookie, 'reorder-empty')

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/projects/${projectId}/roadmap/reorder`,
      headers: { cookie },
      payload: { items: [] },
    })
    expect(res.statusCode).toBe(422)
  })

  it('returns 422 for invalid item ID', async () => {
    const { cookie } = await registerAndGetCookie(app, 'reorder-bad-id')
    const projectId = await createProject(app, cookie, 'reorder-bad-id')

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/projects/${projectId}/roadmap/reorder`,
      headers: { cookie },
      payload: { items: [{ id: 'not-a-uuid', displayOrder: 0 }] },
    })
    expect(res.statusCode).toBe(422)
  })

  it('returns 403 for editor', async () => {
    const { cookie, orgId } = await registerAndGetCookie(app, 'reorder-editor')
    const projectId = await createProject(app, cookie, 'reorder-editor')
    const editorCookie = await createEditorCookie(app, orgId, 'reorder-editor-e')

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/projects/${projectId}/roadmap/reorder`,
      headers: { cookie: editorCookie },
      payload: { items: [{ id: crypto.randomUUID(), displayOrder: 0 }] },
    })
    expect(res.statusCode).toBe(403)
  })

  it('returns 422 when displayOrder exceeds 32-bit int max', async () => {
    const { cookie } = await registerAndGetCookie(app, 'reorder-overflow')
    const projectId = await createProject(app, cookie, 'reorder-overflow')
    const itemId = await createItem(app, cookie, projectId)

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/projects/${projectId}/roadmap/reorder`,
      headers: { cookie },
      payload: { items: [{ id: itemId, displayOrder: 9999999999 }] },
    })
    expect(res.statusCode).toBe(422)
  })

  it('silently skips items from another project (count reflects only matched)', async () => {
    const { cookie, orgId } = await registerAndGetCookie(app, 'reorder-xproject')
    // Upgrade to starter so the org can hold 2 projects
    await prisma.organization.update({ where: { id: orgId }, data: { plan: 'starter' } })
    const projectA = await createProject(app, cookie, 'reorder-xproject-a')
    const projectB = await createProject(app, cookie, 'reorder-xproject-b')
    const itemInA = await createItem(app, cookie, projectA)

    // Attempt to reorder itemInA via projectB — should not match
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/projects/${projectB}/roadmap/reorder`,
      headers: { cookie },
      payload: { items: [{ id: itemInA, displayOrder: 99 }] },
    })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).updated).toBe(0)

    // Item in project A must be unchanged
    const item = await prisma.roadmapItem.findUnique({ where: { id: itemInA } })
    expect(item?.displayOrder).toBe(0)
  })
})

// ─── Notification job enqueueing on status → shipped ─────────────────────────

describe('PATCH roadmap item — feature_shipped job enqueuing', () => {
  beforeEach(() => {
    ;(app.notificationQueue.add as jest.Mock).mockClear()
  })

  it('enqueues feature_shipped job when status transitions in_progress → shipped', async () => {
    const { cookie } = await registerAndGetCookie(app, 'enqueue-in-progress')
    const projectId = await createProject(app, cookie, 'enqueue-in-progress')
    const itemId = await createItem(app, cookie, projectId, { status: 'in_progress' })

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/projects/${projectId}/roadmap/${itemId}`,
      headers: { cookie },
      payload: { status: 'shipped' },
    })

    expect(res.statusCode).toBe(200)
    expect(app.notificationQueue.add).toHaveBeenCalledTimes(1)
    expect(app.notificationQueue.add).toHaveBeenCalledWith('feature_shipped', {
      type: 'feature_shipped',
      referenceId: itemId,
      projectId,
    })
  })

  it('enqueues feature_shipped job when status transitions planned → shipped', async () => {
    const { cookie } = await registerAndGetCookie(app, 'enqueue-planned')
    const projectId = await createProject(app, cookie, 'enqueue-planned')
    const itemId = await createItem(app, cookie, projectId)

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/projects/${projectId}/roadmap/${itemId}`,
      headers: { cookie },
      payload: { status: 'shipped' },
    })

    expect(res.statusCode).toBe(200)
    expect(app.notificationQueue.add).toHaveBeenCalledTimes(1)
  })

  it('does not enqueue when item is already shipped', async () => {
    const { cookie } = await registerAndGetCookie(app, 'enqueue-already-shipped')
    const projectId = await createProject(app, cookie, 'enqueue-already-shipped')
    const itemId = await createItem(app, cookie, projectId, { status: 'shipped' })

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/projects/${projectId}/roadmap/${itemId}`,
      headers: { cookie },
      payload: { status: 'shipped' },
    })

    expect(res.statusCode).toBe(200)
    expect(app.notificationQueue.add).not.toHaveBeenCalled()
  })

  it('does not enqueue when status changes to in_progress', async () => {
    const { cookie } = await registerAndGetCookie(app, 'enqueue-not-shipped')
    const projectId = await createProject(app, cookie, 'enqueue-not-shipped')
    const itemId = await createItem(app, cookie, projectId)

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/projects/${projectId}/roadmap/${itemId}`,
      headers: { cookie },
      payload: { status: 'in_progress' },
    })

    expect(res.statusCode).toBe(200)
    expect(app.notificationQueue.add).not.toHaveBeenCalled()
  })

  it('does not enqueue when only title is updated', async () => {
    const { cookie } = await registerAndGetCookie(app, 'enqueue-title-only')
    const projectId = await createProject(app, cookie, 'enqueue-title-only')
    const itemId = await createItem(app, cookie, projectId)

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/projects/${projectId}/roadmap/${itemId}`,
      headers: { cookie },
      payload: { title: 'Updated title' },
    })

    expect(res.statusCode).toBe(200)
    expect(app.notificationQueue.add).not.toHaveBeenCalled()
  })

  it('does not enqueue on second PATCH to shipped (planned → shipped → shipped)', async () => {
    const { cookie } = await registerAndGetCookie(app, 'enqueue-double-shipped')
    const projectId = await createProject(app, cookie, 'enqueue-double-shipped')
    const itemId = await createItem(app, cookie, projectId)

    // First PATCH: planned → shipped — must enqueue
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/projects/${projectId}/roadmap/${itemId}`,
      headers: { cookie },
      payload: { status: 'shipped' },
    })
    expect(app.notificationQueue.add).toHaveBeenCalledTimes(1)

    ;(app.notificationQueue.add as jest.Mock).mockClear()

    // Second PATCH: shipped → shipped — must not enqueue again
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/projects/${projectId}/roadmap/${itemId}`,
      headers: { cookie },
      payload: { status: 'shipped' },
    })

    expect(res.statusCode).toBe(200)
    expect(app.notificationQueue.add).not.toHaveBeenCalled()
  })
})
