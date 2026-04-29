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

async function createFeature(
  app: FastifyInstance,
  cookie: string,
  projectId: string,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: `/api/v1/projects/${projectId}/features`,
    headers: { cookie },
    payload: { title: 'My Feature Request', ...overrides },
  })
  expect(res.statusCode).toBe(201)
  return JSON.parse(res.body).id
}

let app: FastifyInstance

beforeAll(async () => {
  await prisma.organization.deleteMany({ where: { name: { contains: RUN } } })
  app = await buildApp()
  app.emailNotificationsQueue.add = jest.fn().mockResolvedValue({})
  app.voteVerificationQueue.add = jest.fn().mockResolvedValue({})
  app.subscriptionVerificationQueue.add = jest.fn().mockResolvedValue({})
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

// ─── GET /api/v1/projects/:projectId/features ────────────────────────────────

describe('GET /api/v1/projects/:projectId/features', () => {
  it('returns empty array for new project', async () => {
    const { cookie } = await registerAndGetCookie(app, 'get-empty')
    const projectId = await createProject(app, cookie, 'get-empty')

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${projectId}/features`,
      headers: { cookie },
    })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual([])
  })

  it('returns features with expected shape', async () => {
    const { cookie } = await registerAndGetCookie(app, 'get-shape')
    const projectId = await createProject(app, cookie, 'get-shape')
    await createFeature(app, cookie, projectId, { title: 'Dark Mode', description: 'Add dark theme' })

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${projectId}/features`,
      headers: { cookie },
    })

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(Array.isArray(body)).toBe(true)
    expect(body.length).toBe(1)
    expect(body[0].title).toBe('Dark Mode')
    expect(body[0].description).toBe('Add dark theme')
    expect(body[0].status).toBe('open')
    expect(body[0].voteCount).toBe(0)
    expect(typeof body[0].id).toBe('string')
    expect(typeof body[0].projectId).toBe('string')
    expect(typeof body[0].createdAt).toBe('string')
  })

  it('filters by status', async () => {
    const { cookie } = await registerAndGetCookie(app, 'get-filter')
    const projectId = await createProject(app, cookie, 'get-filter')
    await createFeature(app, cookie, projectId, { title: 'Open Item', status: 'open' })
    await createFeature(app, cookie, projectId, { title: 'Planned Item', status: 'planned' })

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${projectId}/features?status=planned`,
      headers: { cookie },
    })

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.length).toBe(1)
    expect(body[0].title).toBe('Planned Item')
  })

  it('returns submitterEmail to owner but not to editor', async () => {
    const { cookie, orgId } = await registerAndGetCookie(app, 'get-pii')
    const projectId = await createProject(app, cookie, 'get-pii')
    await createFeature(app, cookie, projectId)
    const editorCookie = await createEditorCookie(app, orgId, 'get-pii-editor')

    const ownerRes = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${projectId}/features`,
      headers: { cookie },
    })
    const editorRes = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${projectId}/features`,
      headers: { cookie: editorCookie },
    })

    expect(ownerRes.statusCode).toBe(200)
    expect(editorRes.statusCode).toBe(200)
    expect('submitterEmail' in JSON.parse(ownerRes.body)[0]).toBe(true)
    expect('submitterEmail' in JSON.parse(editorRes.body)[0]).toBe(false)
  })

  it('returns 401 when unauthenticated', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${crypto.randomUUID()}/features`,
    })
    expect(res.statusCode).toBe(401)
  })

  it('returns 404 for project belonging to another org', async () => {
    const { cookie: cookieA } = await registerAndGetCookie(app, 'get-xorg-a')
    const { cookie: cookieB } = await registerAndGetCookie(app, 'get-xorg-b')
    const projectId = await createProject(app, cookieA, 'get-xorg-a')

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${projectId}/features`,
      headers: { cookie: cookieB },
    })
    expect(res.statusCode).toBe(404)
  })
})

// ─── GET /api/v1/projects/:projectId/features/:featureId ─────────────────────

describe('GET /api/v1/projects/:projectId/features/:featureId', () => {
  it('returns feature with expected shape', async () => {
    const { cookie } = await registerAndGetCookie(app, 'get-detail-shape')
    const projectId = await createProject(app, cookie, 'get-detail-shape')
    const featureId = await createFeature(app, cookie, projectId, { title: 'Detail Feature', description: 'Some desc' })

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${projectId}/features/${featureId}`,
      headers: { cookie },
    })

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.id).toBe(featureId)
    expect(body.title).toBe('Detail Feature')
    expect(body.description).toBe('Some desc')
    expect(body.status).toBe('open')
    expect(body.projectId).toBe(projectId)
    expect(body.voteCount).toBe(0)
  })

  it('returns submitterEmail to owner but not to editor', async () => {
    const { cookie, orgId } = await registerAndGetCookie(app, 'get-detail-pii')
    const projectId = await createProject(app, cookie, 'get-detail-pii')
    const featureId = await createFeature(app, cookie, projectId)
    const editorCookie = await createEditorCookie(app, orgId, 'get-detail-pii-editor')

    const ownerRes = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${projectId}/features/${featureId}`,
      headers: { cookie },
    })
    const editorRes = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${projectId}/features/${featureId}`,
      headers: { cookie: editorCookie },
    })

    expect(ownerRes.statusCode).toBe(200)
    expect(editorRes.statusCode).toBe(200)
    expect('submitterEmail' in JSON.parse(ownerRes.body)).toBe(true)
    expect('submitterEmail' in JSON.parse(editorRes.body)).toBe(false)
  })

  it('returns 404 for non-existent feature', async () => {
    const { cookie } = await registerAndGetCookie(app, 'get-detail-404')
    const projectId = await createProject(app, cookie, 'get-detail-404')

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${projectId}/features/${crypto.randomUUID()}`,
      headers: { cookie },
    })
    expect(res.statusCode).toBe(404)
  })

  it('returns 404 for non-UUID featureId', async () => {
    const { cookie } = await registerAndGetCookie(app, 'get-detail-bad-uuid')
    const projectId = await createProject(app, cookie, 'get-detail-bad-uuid')

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${projectId}/features/not-a-uuid`,
      headers: { cookie },
    })
    expect(res.statusCode).toBe(404)
  })

  it('returns 404 for feature belonging to another project', async () => {
    const { cookie, orgId } = await registerAndGetCookie(app, 'get-detail-xproject')
    await prisma.organization.update({ where: { id: orgId }, data: { plan: 'starter' } })
    const projectA = await createProject(app, cookie, 'get-detail-xproject-a')
    const projectB = await createProject(app, cookie, 'get-detail-xproject-b')
    const featureId = await createFeature(app, cookie, projectA)

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${projectB}/features/${featureId}`,
      headers: { cookie },
    })
    expect(res.statusCode).toBe(404)
  })

  it('returns 401 when unauthenticated', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${crypto.randomUUID()}/features/${crypto.randomUUID()}`,
    })
    expect(res.statusCode).toBe(401)
  })
})

// ─── POST /api/v1/projects/:projectId/features ───────────────────────────────

describe('POST /api/v1/projects/:projectId/features', () => {
  it('creates feature and returns 201 with expected shape', async () => {
    const { cookie } = await registerAndGetCookie(app, 'post-create')
    const projectId = await createProject(app, cookie, 'post-create')

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/features`,
      headers: { cookie },
      payload: { title: 'New Feature', description: 'Details here', status: 'planned' },
    })

    expect(res.statusCode).toBe(201)
    const body = JSON.parse(res.body)
    expect(body.title).toBe('New Feature')
    expect(body.description).toBe('Details here')
    expect(body.status).toBe('planned')
    expect(body.voteCount).toBe(0)
    expect(body.projectId).toBe(projectId)
    expect(typeof body.id).toBe('string')
  })

  it('defaults status to open when omitted', async () => {
    const { cookie } = await registerAndGetCookie(app, 'post-default-status')
    const projectId = await createProject(app, cookie, 'post-default-status')

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/features`,
      headers: { cookie },
      payload: { title: 'No Status' },
    })

    expect(res.statusCode).toBe(201)
    expect(JSON.parse(res.body).status).toBe('open')
  })

  it('returns 401 when unauthenticated', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${crypto.randomUUID()}/features`,
      payload: { title: 'Sneaky' },
    })
    expect(res.statusCode).toBe(401)
  })

  it('returns 403 for editor', async () => {
    const { cookie, orgId } = await registerAndGetCookie(app, 'post-editor')
    const projectId = await createProject(app, cookie, 'post-editor')
    const editorCookie = await createEditorCookie(app, orgId, 'post-editor-e')

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/features`,
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
      url: `/api/v1/projects/${projectId}/features`,
      headers: { cookie },
      payload: { description: 'No title here' },
    })
    expect(res.statusCode).toBe(422)
  })

  it('returns 422 when title exceeds 200 characters', async () => {
    const { cookie } = await registerAndGetCookie(app, 'post-long-title')
    const projectId = await createProject(app, cookie, 'post-long-title')

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/features`,
      headers: { cookie },
      payload: { title: 'x'.repeat(201) },
    })
    expect(res.statusCode).toBe(422)
  })

  it('returns 422 when status is invalid', async () => {
    const { cookie } = await registerAndGetCookie(app, 'post-bad-status')
    const projectId = await createProject(app, cookie, 'post-bad-status')

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/features`,
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
      url: `/api/v1/projects/${projectId}/features`,
      headers: { cookie: cookieB },
      payload: { title: 'Cross-org' },
    })
    expect(res.statusCode).toBe(404)
  })
})

// ─── PATCH /api/v1/projects/:projectId/features/:featureId ───────────────────

describe('PATCH /api/v1/projects/:projectId/features/:featureId', () => {
  it('updates title only', async () => {
    const { cookie } = await registerAndGetCookie(app, 'patch-title')
    const projectId = await createProject(app, cookie, 'patch-title')
    const featureId = await createFeature(app, cookie, projectId)

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/projects/${projectId}/features/${featureId}`,
      headers: { cookie },
      payload: { title: 'Updated Title' },
    })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).title).toBe('Updated Title')
  })

  it('updates status only', async () => {
    const { cookie } = await registerAndGetCookie(app, 'patch-status')
    const projectId = await createProject(app, cookie, 'patch-status')
    const featureId = await createFeature(app, cookie, projectId)

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/projects/${projectId}/features/${featureId}`,
      headers: { cookie },
      payload: { status: 'in_progress' },
    })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).status).toBe('in_progress')
  })

  it('sets description to null (verifies before and after state)', async () => {
    const { cookie } = await registerAndGetCookie(app, 'patch-null-desc')
    const projectId = await createProject(app, cookie, 'patch-null-desc')
    const featureId = await createFeature(app, cookie, projectId, { description: 'Old description' })

    // Verify before-state
    const before = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${projectId}/features/${featureId}`,
      headers: { cookie },
    })
    expect(JSON.parse(before.body).description).toBe('Old description')

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/projects/${projectId}/features/${featureId}`,
      headers: { cookie },
      payload: { description: null },
    })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).description).toBeNull()
  })

  it('returns 401 when unauthenticated', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/projects/${crypto.randomUUID()}/features/${crypto.randomUUID()}`,
      payload: { title: 'Sneaky' },
    })
    expect(res.statusCode).toBe(401)
  })

  it('returns 422 when body is empty', async () => {
    const { cookie } = await registerAndGetCookie(app, 'patch-empty')
    const projectId = await createProject(app, cookie, 'patch-empty')
    const featureId = await createFeature(app, cookie, projectId)

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/projects/${projectId}/features/${featureId}`,
      headers: { cookie },
      payload: {},
    })
    expect(res.statusCode).toBe(422)
  })

  it('returns 422 when title exceeds 200 characters', async () => {
    const { cookie } = await registerAndGetCookie(app, 'patch-long-title')
    const projectId = await createProject(app, cookie, 'patch-long-title')
    const featureId = await createFeature(app, cookie, projectId)

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/projects/${projectId}/features/${featureId}`,
      headers: { cookie },
      payload: { title: 'x'.repeat(201) },
    })
    expect(res.statusCode).toBe(422)
  })

  it('returns 404 for non-UUID featureId', async () => {
    const { cookie } = await registerAndGetCookie(app, 'patch-bad-uuid')
    const projectId = await createProject(app, cookie, 'patch-bad-uuid')

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/projects/${projectId}/features/not-a-uuid`,
      headers: { cookie },
      payload: { title: 'X' },
    })
    expect(res.statusCode).toBe(404)
  })

  it('returns 404 for feature belonging to another project', async () => {
    const { cookie, orgId } = await registerAndGetCookie(app, 'patch-xproject')
    await prisma.organization.update({ where: { id: orgId }, data: { plan: 'starter' } })
    const projectA = await createProject(app, cookie, 'patch-xproject-a')
    const projectB = await createProject(app, cookie, 'patch-xproject-b')
    const featureId = await createFeature(app, cookie, projectA)

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/projects/${projectB}/features/${featureId}`,
      headers: { cookie },
      payload: { title: 'Cross-project' },
    })
    expect(res.statusCode).toBe(404)
  })

  it('returns 403 for editor', async () => {
    const { cookie, orgId } = await registerAndGetCookie(app, 'patch-editor')
    const projectId = await createProject(app, cookie, 'patch-editor')
    const featureId = await createFeature(app, cookie, projectId)
    const editorCookie = await createEditorCookie(app, orgId, 'patch-editor-e')

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/projects/${projectId}/features/${featureId}`,
      headers: { cookie: editorCookie },
      payload: { title: 'Not allowed' },
    })
    expect(res.statusCode).toBe(403)
  })
})

// ─── DELETE /api/v1/projects/:projectId/features/:featureId ──────────────────

describe('DELETE /api/v1/projects/:projectId/features/:featureId', () => {
  it('deletes feature and returns 204', async () => {
    const { cookie } = await registerAndGetCookie(app, 'del-ok')
    const projectId = await createProject(app, cookie, 'del-ok')
    const featureId = await createFeature(app, cookie, projectId)

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/projects/${projectId}/features/${featureId}`,
      headers: { cookie },
    })
    expect(res.statusCode).toBe(204)
  })

  it('returns 404 on second delete (idempotency)', async () => {
    const { cookie } = await registerAndGetCookie(app, 'del-idem')
    const projectId = await createProject(app, cookie, 'del-idem')
    const featureId = await createFeature(app, cookie, projectId)

    await app.inject({ method: 'DELETE', url: `/api/v1/projects/${projectId}/features/${featureId}`, headers: { cookie } })
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/projects/${projectId}/features/${featureId}`,
      headers: { cookie },
    })
    expect(res.statusCode).toBe(404)
  })

  it('returns 403 for editor', async () => {
    const { cookie, orgId } = await registerAndGetCookie(app, 'del-editor')
    const projectId = await createProject(app, cookie, 'del-editor')
    const featureId = await createFeature(app, cookie, projectId)
    const editorCookie = await createEditorCookie(app, orgId, 'del-editor-e')

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/projects/${projectId}/features/${featureId}`,
      headers: { cookie: editorCookie },
    })
    expect(res.statusCode).toBe(403)
  })

  it('returns 404 for feature belonging to another org', async () => {
    const { cookie: cookieA } = await registerAndGetCookie(app, 'del-xorg-a')
    const { cookie: cookieB } = await registerAndGetCookie(app, 'del-xorg-b')
    const projectId = await createProject(app, cookieA, 'del-xorg-a')
    const featureId = await createFeature(app, cookieA, projectId)

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/projects/${projectId}/features/${featureId}`,
      headers: { cookie: cookieB },
    })
    expect(res.statusCode).toBe(404)
  })

  it('returns 404 for feature belonging to another project', async () => {
    const { cookie, orgId } = await registerAndGetCookie(app, 'del-xproject')
    await prisma.organization.update({ where: { id: orgId }, data: { plan: 'starter' } })
    const projectA = await createProject(app, cookie, 'del-xproject-a')
    const projectB = await createProject(app, cookie, 'del-xproject-b')
    const featureId = await createFeature(app, cookie, projectA)

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/projects/${projectB}/features/${featureId}`,
      headers: { cookie },
    })
    expect(res.statusCode).toBe(404)
  })
})
