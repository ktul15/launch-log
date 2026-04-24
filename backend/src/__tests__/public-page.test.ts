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
): Promise<{ cookie: string; orgId: string; orgSlug: string }> {
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
  const cookie = cookies.map((c: string) => c.split(';')[0]).join('; ')
  return { cookie, orgId: body.org.id, orgSlug: body.org.slug }
}

async function createProject(
  app: FastifyInstance,
  cookie: string,
  label: string,
): Promise<{ id: string; slug: string; widgetKey: string }> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/projects',
    headers: { cookie },
    payload: { name: `Project ${label}`, slug: `proj-${label}-${RUN.slice(0, 8)}` },
  })
  expect(res.statusCode).toBe(201)
  const body = JSON.parse(res.body)
  return { id: body.id, slug: body.slug, widgetKey: body.widgetKey }
}

let app: FastifyInstance

beforeAll(async () => {
  await prisma.organization.deleteMany({ where: { name: { contains: RUN } } })
  app = await buildApp()
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

// ─── GET /api/v1/public/resolve/:orgSlug/:projectSlug ────────────────────────

describe('GET /api/v1/public/resolve/:orgSlug/:projectSlug', () => {
  it('returns project info for valid slugs', async () => {
    const { cookie, orgSlug } = await registerAndGetCookie(app, 'resolve-ok')
    const { slug: projectSlug } = await createProject(app, cookie, 'resolve-ok')

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/public/resolve/${orgSlug}/${projectSlug}`,
    })

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body).toMatchObject({
      name: expect.any(String),
      slug: projectSlug,
      widgetKey: expect.any(String),
      orgName: expect.any(String),
    })
    expect(body).not.toHaveProperty('id')
  })

  it('returns 404 for unknown org slug', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/public/resolve/does-not-exist-${RUN}/any-project`,
    })

    expect(res.statusCode).toBe(404)
  })

  it('returns 404 for unknown project slug within valid org', async () => {
    const { cookie, orgSlug } = await registerAndGetCookie(app, 'resolve-no-proj')
    await createProject(app, cookie, 'resolve-no-proj')

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/public/resolve/${orgSlug}/no-such-project-${RUN}`,
    })

    expect(res.statusCode).toBe(404)
  })

  it('returns 404 for oversized slug param', async () => {
    const long = 'a'.repeat(101)
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/public/resolve/${long}/project`,
    })

    expect(res.statusCode).toBe(404)
  })
})

// ─── GET /api/v1/public/:projectKey/changelog ────────────────────────────────

describe('GET /api/v1/public/:projectKey/changelog', () => {
  it('returns empty array when no entries', async () => {
    const { cookie } = await registerAndGetCookie(app, 'cl-empty')
    const { widgetKey } = await createProject(app, cookie, 'cl-empty')

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/public/${widgetKey}/changelog`,
    })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual([])
  })

  it('returns only published entries sorted by publishedAt desc', async () => {
    const { cookie, orgId } = await registerAndGetCookie(app, 'cl-pub')
    const { id: projectId, widgetKey } = await createProject(app, cookie, 'cl-pub')

    // published entry
    const pubRes = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/changelog`,
      headers: { cookie },
      payload: { title: 'Published Entry', content: { type: 'doc', content: [] } },
    })
    expect(pubRes.statusCode).toBe(201)
    const pubId = JSON.parse(pubRes.body).id

    await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/changelog/${pubId}/publish`,
      headers: { cookie },
    })

    // draft entry — should not appear
    await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/changelog`,
      headers: { cookie },
      payload: { title: 'Draft Entry', content: { type: 'doc', content: [] } },
    })

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/public/${widgetKey}/changelog`,
    })

    expect(res.statusCode).toBe(200)
    const entries = JSON.parse(res.body)
    expect(Array.isArray(entries)).toBe(true)
    expect(entries).toHaveLength(1)
    expect(entries[0].title).toBe('Published Entry')
    expect(entries[0]).toHaveProperty('id')
    expect(entries[0]).toHaveProperty('publishedAt')
    expect(entries[0]).not.toHaveProperty('content')
  })

  it('returns 404 for unknown project key', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/public/${crypto.randomUUID()}/changelog`,
    })

    expect(res.statusCode).toBe(404)
  })
})

// ─── GET /api/v1/public/:projectKey/roadmap ──────────────────────────────────

describe('GET /api/v1/public/:projectKey/roadmap', () => {
  it('returns empty array when no items', async () => {
    const { cookie } = await registerAndGetCookie(app, 'rm-empty')
    const { widgetKey } = await createProject(app, cookie, 'rm-empty')

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/public/${widgetKey}/roadmap`,
    })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual([])
  })

  it('returns roadmap items with correct shape', async () => {
    const { cookie } = await registerAndGetCookie(app, 'rm-items')
    const { id: projectId, widgetKey } = await createProject(app, cookie, 'rm-items')

    await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/roadmap`,
      headers: { cookie },
      payload: { title: 'SSO Support', description: 'Add SAML/SSO', status: 'planned' },
    })

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/public/${widgetKey}/roadmap`,
    })

    expect(res.statusCode).toBe(200)
    const items = JSON.parse(res.body)
    expect(Array.isArray(items)).toBe(true)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      id: expect.any(String),
      title: 'SSO Support',
      status: 'planned',
      displayOrder: expect.any(Number),
    })
  })

  it('returns 404 for unknown project key', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/public/${crypto.randomUUID()}/roadmap`,
    })

    expect(res.statusCode).toBe(404)
  })
})

// ─── GET /api/v1/public/:projectKey/features ─────────────────────────────────

describe('GET /api/v1/public/:projectKey/features', () => {
  it('returns empty array when no features', async () => {
    const { cookie } = await registerAndGetCookie(app, 'feat-empty')
    const { widgetKey } = await createProject(app, cookie, 'feat-empty')

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/public/${widgetKey}/features`,
    })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual([])
  })

  it('excludes closed and shipped features', async () => {
    const { cookie } = await registerAndGetCookie(app, 'feat-filter')
    const { id: projectId, widgetKey } = await createProject(app, cookie, 'feat-filter')

    // Create features with various statuses
    for (const status of ['open', 'planned', 'in_progress', 'shipped', 'closed'] as const) {
      await app.inject({
        method: 'POST',
        url: `/api/v1/projects/${projectId}/features`,
        headers: { cookie },
        payload: { title: `Feature ${status}`, status },
      })
    }

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/public/${widgetKey}/features`,
    })

    expect(res.statusCode).toBe(200)
    const features = JSON.parse(res.body)
    expect(Array.isArray(features)).toBe(true)
    const statuses = features.map((f: { status: string }) => f.status)
    expect(statuses).not.toContain('closed')
    expect(statuses).not.toContain('shipped')
    expect(features).toHaveLength(3)
  })

  it('sorts by voteCount descending', async () => {
    const { cookie } = await registerAndGetCookie(app, 'feat-sort')
    const { id: projectId, widgetKey } = await createProject(app, cookie, 'feat-sort')

    // Create two features then manually bump voteCount on one via prisma
    const f1Res = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/features`,
      headers: { cookie },
      payload: { title: 'Low votes' },
    })
    const f2Res = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/features`,
      headers: { cookie },
      payload: { title: 'High votes' },
    })
    const f2Id = JSON.parse(f2Res.body).id

    await prisma.featureRequest.update({
      where: { id: f2Id },
      data: { voteCount: 10 },
    })

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/public/${widgetKey}/features`,
    })

    expect(res.statusCode).toBe(200)
    const features = JSON.parse(res.body)
    expect(features[0].title).toBe('High votes')
    expect(features[0].voteCount).toBe(10)
  })

  it('returns 404 for unknown project key', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/public/${crypto.randomUUID()}/features`,
    })

    expect(res.statusCode).toBe(404)
  })
})
