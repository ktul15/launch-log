import crypto from 'crypto'
import { buildApp } from '../index'
import { FastifyInstance } from 'fastify'
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()
const RUN = crypto.randomUUID().replace(/-/g, '').slice(0, 12)

const createdOrgIds: string[] = []

function testOrgName(label: string) {
  return `__TEST__ ${RUN} ${label}`
}

async function registerAndGetCookie(
  app: FastifyInstance,
  label: string,
): Promise<{ cookie: string; orgId: string }> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: {
      orgName: testOrgName(label),
      name: 'TestUser',
      email: `${RUN}-${label}@test.invalid`,
      password: 'password123',
    },
  })
  expect(res.statusCode).toBe(201)
  const body = JSON.parse(res.body)
  createdOrgIds.push(body.org.id)
  const setCookie = res.headers['set-cookie']
  const cookies = Array.isArray(setCookie) ? setCookie : [setCookie ?? '']
  const cookie = cookies.map((c: string) => c.split(';')[0]).join('; ')
  return { cookie, orgId: body.org.id }
}

async function createProjectAndGetKey(
  app: FastifyInstance,
  cookie: string,
  label: string,
): Promise<{ projectId: string; widgetKey: string }> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/projects',
    headers: { cookie },
    payload: { name: `Project ${label}`, slug: `${label}-${RUN.slice(0, 8)}` },
  })
  expect(res.statusCode).toBe(201)
  const body = JSON.parse(res.body)
  return { projectId: body.id, widgetKey: body.widgetKey }
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

describe('POST /api/v1/public/:projectKey/events', () => {
  it('returns 204 and creates a widget_impression event', async () => {
    const { cookie } = await registerAndGetCookie(app, 'imp')
    const { projectId, widgetKey } = await createProjectAndGetKey(app, cookie, 'imp')

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/public/${widgetKey}/events`,
      payload: { type: 'widget_impression' },
    })

    expect(res.statusCode).toBe(204)

    const event = await prisma.analyticsEvent.findFirst({
      where: { projectId, type: 'widget_impression' },
    })
    expect(event).not.toBeNull()
    expect(event?.type).toBe('widget_impression')
    // inject() uses 127.0.0.1 — hashIp returns a non-null HMAC hex string
    expect(typeof event?.ipHash).toBe('string')
  })

  it('returns 204 and creates a powered_by_click event', async () => {
    const { cookie } = await registerAndGetCookie(app, 'pbc')
    const { projectId, widgetKey } = await createProjectAndGetKey(app, cookie, 'pbc')

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/public/${widgetKey}/events`,
      payload: { type: 'powered_by_click' },
    })

    expect(res.statusCode).toBe(204)

    const event = await prisma.analyticsEvent.findFirst({
      where: { projectId, type: 'powered_by_click' },
    })
    expect(event).not.toBeNull()
    expect(typeof event?.ipHash).toBe('string')
  })

  it('returns 400 for unknown event type', async () => {
    const { cookie } = await registerAndGetCookie(app, 'bad-type')
    const { widgetKey } = await createProjectAndGetKey(app, cookie, 'bad-type')

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/public/${widgetKey}/events`,
      payload: { type: 'unknown_event' },
    })

    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).message).toContain('Invalid enum value')
  })

  it('returns 400 when type field is missing', async () => {
    const { cookie } = await registerAndGetCookie(app, 'no-type')
    const { widgetKey } = await createProjectAndGetKey(app, cookie, 'no-type')

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/public/${widgetKey}/events`,
      payload: {},
    })

    expect(res.statusCode).toBe(400)
  })

  it('returns 404 for unknown project key', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/public/${crypto.randomUUID()}/events`,
      payload: { type: 'widget_impression' },
    })

    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body).message).toBe('Project not found')
  })

  it('returns 404 for an inactive project', async () => {
    const { cookie } = await registerAndGetCookie(app, 'inactive')
    const { projectId, widgetKey } = await createProjectAndGetKey(app, cookie, 'inactive')
    await prisma.project.update({ where: { id: projectId }, data: { isActive: false } })

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/public/${widgetKey}/events`,
      payload: { type: 'widget_impression' },
    })

    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body).message).toBe('Project not found')
  })

  it('stores metadata when provided', async () => {
    const { cookie } = await registerAndGetCookie(app, 'meta')
    const { projectId, widgetKey } = await createProjectAndGetKey(app, cookie, 'meta')

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/public/${widgetKey}/events`,
      payload: { type: 'widget_impression', metadata: { referrer: 'https://example.com' } },
    })

    expect(res.statusCode).toBe(204)

    const event = await prisma.analyticsEvent.findFirst({
      where: { projectId, type: 'widget_impression' },
      orderBy: { createdAt: 'desc' },
    })
    expect(event?.metadata).toMatchObject({ referrer: 'https://example.com' })
  })

  it('returns 400 for metadata with oversized value', async () => {
    const { cookie } = await registerAndGetCookie(app, 'big-meta')
    const { widgetKey } = await createProjectAndGetKey(app, cookie, 'big-meta')

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/public/${widgetKey}/events`,
      payload: { type: 'widget_impression', metadata: { x: 'A'.repeat(1000) } },
    })

    expect(res.statusCode).toBe(400)
  })

  it('returns 400 for metadata with too many keys', async () => {
    const { cookie } = await registerAndGetCookie(app, 'many-keys')
    const { widgetKey } = await createProjectAndGetKey(app, cookie, 'many-keys')

    const metadata = Object.fromEntries(
      Array.from({ length: 11 }, (_, i) => [`key${i}`, 'value']),
    )

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/public/${widgetKey}/events`,
      payload: { type: 'widget_impression', metadata },
    })

    expect(res.statusCode).toBe(400)
  })
})
