import crypto from 'crypto'
import { buildApp } from '../index'
import { FastifyInstance } from 'fastify'
import { PrismaClient } from '@prisma/client'
import { processSubscribeVerificationJob } from '../workers/notificationWorker'
import type { SubscriptionVerificationJobData } from '../jobs/index'

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
): Promise<{ cookie: string; orgId: string }> {
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

// ─── POST /api/v1/public/:projectKey/subscribe ───────────────────────────────

describe('POST /api/v1/public/:projectKey/subscribe', () => {
  it('creates unverified subscriber and returns verification_sent', async () => {
    const { cookie } = await registerAndGetCookie(app, 'sub-happy')
    const { projectId, widgetKey } = await createProjectAndGetKey(app, cookie, 'sub-happy')
    const email = testEmail('sub-happy-user')

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/public/${widgetKey}/subscribe`,
      payload: { email },
    })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ status: 'verification_sent' })

    const subscriber = await prisma.subscriber.findUnique({
      where: { projectId_email: { projectId, email } },
    })
    expect(subscriber).not.toBeNull()
    expect(subscriber!.verified).toBe(false)
    expect(subscriber!.verificationToken).toBeDefined()
    expect(subscriber!.unsubscribeToken).toBeDefined()
  })

  it('enqueues subscribe_verification job', async () => {
    const { cookie } = await registerAndGetCookie(app, 'sub-queue')
    const { projectId, widgetKey } = await createProjectAndGetKey(app, cookie, 'sub-queue')

    ;(app.subscriptionVerificationQueue.add as jest.Mock).mockClear()

    await app.inject({
      method: 'POST',
      url: `/api/v1/public/${widgetKey}/subscribe`,
      payload: { email: testEmail('sub-queue-user') },
    })

    expect(app.subscriptionVerificationQueue.add).toHaveBeenCalledWith(
      'subscribe_verification',
      expect.objectContaining({ type: 'subscribe_verification', projectId }),
    )
  })

  it('returns already_subscribed when email is already verified', async () => {
    const { cookie } = await registerAndGetCookie(app, 'sub-already')
    const { projectId, widgetKey } = await createProjectAndGetKey(app, cookie, 'sub-already')
    const email = testEmail('sub-already-user')

    // First subscribe
    await app.inject({
      method: 'POST',
      url: `/api/v1/public/${widgetKey}/subscribe`,
      payload: { email },
    })

    // Manually verify the subscriber
    await prisma.subscriber.update({
      where: { projectId_email: { projectId, email } },
      data: { verified: true },
    })

    // Second subscribe attempt
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/public/${widgetKey}/subscribe`,
      payload: { email },
    })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ status: 'already_subscribed' })
  })

  it('resends verification email when email exists but is not yet verified', async () => {
    const { cookie } = await registerAndGetCookie(app, 'sub-resend')
    const { widgetKey } = await createProjectAndGetKey(app, cookie, 'sub-resend')
    const email = testEmail('sub-resend-user')

    await app.inject({
      method: 'POST',
      url: `/api/v1/public/${widgetKey}/subscribe`,
      payload: { email },
    })

    ;(app.subscriptionVerificationQueue.add as jest.Mock).mockClear()

    // Second subscribe attempt before verification
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/public/${widgetKey}/subscribe`,
      payload: { email },
    })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ status: 'verification_sent' })
    expect(app.subscriptionVerificationQueue.add).toHaveBeenCalledWith(
      'subscribe_verification',
      expect.objectContaining({ type: 'subscribe_verification' }),
    )
  })

  it('normalizes email to lowercase', async () => {
    const { cookie } = await registerAndGetCookie(app, 'sub-case')
    const { projectId, widgetKey } = await createProjectAndGetKey(app, cookie, 'sub-case')
    const email = testEmail('sub-case-user')

    await app.inject({
      method: 'POST',
      url: `/api/v1/public/${widgetKey}/subscribe`,
      payload: { email: email.toUpperCase() },
    })

    const subscriber = await prisma.subscriber.findUnique({
      where: { projectId_email: { projectId, email: email.toLowerCase() } },
    })
    expect(subscriber).not.toBeNull()
  })

  it('returns 404 for unknown projectKey', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/public/${crypto.randomUUID()}/subscribe`,
      payload: { email: 'user@example.com' },
    })
    expect(res.statusCode).toBe(404)
  })

  it('returns 400 for missing email', async () => {
    const { cookie } = await registerAndGetCookie(app, 'sub-no-email')
    const { widgetKey } = await createProjectAndGetKey(app, cookie, 'sub-no-email')

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/public/${widgetKey}/subscribe`,
      payload: {},
    })
    expect(res.statusCode).toBe(400)
  })

  it('returns 400 for invalid email format', async () => {
    const { cookie } = await registerAndGetCookie(app, 'sub-bad-email')
    const { widgetKey } = await createProjectAndGetKey(app, cookie, 'sub-bad-email')

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/public/${widgetKey}/subscribe`,
      payload: { email: 'not-an-email' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('returns 404 for inactive project', async () => {
    const { cookie } = await registerAndGetCookie(app, 'sub-inactive')
    const { projectId, widgetKey } = await createProjectAndGetKey(app, cookie, 'sub-inactive')

    await prisma.project.update({ where: { id: projectId }, data: { isActive: false } })

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/public/${widgetKey}/subscribe`,
      payload: { email: testEmail('sub-inactive-user') },
    })
    expect(res.statusCode).toBe(404)

    // Restore for cleanup
    await prisma.project.update({ where: { id: projectId }, data: { isActive: true } })
  })

  it('returns 500 when subscriptionVerificationQueue.add throws (Redis down)', async () => {
    const { cookie } = await registerAndGetCookie(app, 'sub-queue-fail')
    const { widgetKey } = await createProjectAndGetKey(app, cookie, 'sub-queue-fail')
    const email = testEmail('sub-qf-user')

    ;(app.subscriptionVerificationQueue.add as jest.Mock).mockRejectedValueOnce(new Error('Redis down'))

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/public/${widgetKey}/subscribe`,
      payload: { email },
    })

    expect(res.statusCode).toBe(500)
  })
})

// ─── GET /api/v1/public/verify-subscribe ─────────────────────────────────────

describe('GET /api/v1/public/verify-subscribe', () => {
  async function createSubscriber(
    app: FastifyInstance,
    label: string,
  ): Promise<{ projectId: string; widgetKey: string; email: string; token: string }> {
    const { cookie } = await registerAndGetCookie(app, label)
    const { projectId, widgetKey } = await createProjectAndGetKey(app, cookie, label)
    const email = testEmail(`${label}-user`)

    await app.inject({
      method: 'POST',
      url: `/api/v1/public/${widgetKey}/subscribe`,
      payload: { email },
    })

    const subscriber = await prisma.subscriber.findUnique({
      where: { projectId_email: { projectId, email } },
    })
    return { projectId, widgetKey, email, token: subscriber!.verificationToken }
  }

  it('marks subscriber verified and returns { verified: true }', async () => {
    const { projectId, email, token } = await createSubscriber(app, 'vsub-happy')

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/public/verify-subscribe',
      query: { token },
    })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ verified: true })

    const subscriber = await prisma.subscriber.findUnique({
      where: { projectId_email: { projectId, email } },
    })
    expect(subscriber!.verified).toBe(true)
  })

  it('is idempotent — calling twice still returns { verified: true }', async () => {
    const { token } = await createSubscriber(app, 'vsub-idempotent')

    await app.inject({ method: 'GET', url: '/api/v1/public/verify-subscribe', query: { token } })
    const res2 = await app.inject({ method: 'GET', url: '/api/v1/public/verify-subscribe', query: { token } })

    expect(res2.statusCode).toBe(200)
    expect(JSON.parse(res2.body)).toEqual({ verified: true })
  })

  it('returns 400 for unknown token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/public/verify-subscribe',
      query: { token: crypto.randomUUID() },
    })
    expect(res.statusCode).toBe(400)
  })

  it('returns 400 when token is missing', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/public/verify-subscribe',
      query: {},
    })
    expect(res.statusCode).toBe(400)
  })

  it('returns 400 when token exceeds max length', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/public/verify-subscribe',
      query: { token: 'a'.repeat(129) },
    })
    expect(res.statusCode).toBe(400)
  })
})

// ─── GET /api/v1/public/unsubscribe ──────────────────────────────────────────

describe('GET /api/v1/public/unsubscribe', () => {
  async function createVerifiedSubscriber(
    app: FastifyInstance,
    label: string,
  ): Promise<{ projectId: string; email: string; token: string }> {
    const { cookie } = await registerAndGetCookie(app, label)
    const { projectId, widgetKey } = await createProjectAndGetKey(app, cookie, label)
    const email = testEmail(`${label}-user`)

    await app.inject({
      method: 'POST',
      url: `/api/v1/public/${widgetKey}/subscribe`,
      payload: { email },
    })

    const subscriber = await prisma.subscriber.findUnique({
      where: { projectId_email: { projectId, email } },
    })

    // Verify so the subscriber is active
    await prisma.subscriber.update({
      where: { id: subscriber!.id },
      data: { verified: true },
    })

    return { projectId, email, token: subscriber!.unsubscribeToken }
  }

  it('soft-deletes subscriber and returns { unsubscribed: true }', async () => {
    const { projectId, email, token } = await createVerifiedSubscriber(app, 'unsub-happy')

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/public/unsubscribe',
      query: { token },
    })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ unsubscribed: true })

    const subscriber = await prisma.subscriber.findUnique({
      where: { projectId_email: { projectId, email } },
    })
    expect(subscriber).not.toBeNull()
    expect(subscriber!.unsubscribedAt).not.toBeNull()
    expect(subscriber!.verified).toBe(false)
  })

  it('returns 200 for non-UUID token (short-circuit, no DB query)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/public/unsubscribe',
      query: { token: 'not-a-uuid' },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ unsubscribed: true })
  })

  it('returns 200 for unknown token (treat as already-unsubscribed)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/public/unsubscribe',
      query: { token: crypto.randomUUID() },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ unsubscribed: true })
  })

  it('returns 400 when token is missing', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/public/unsubscribe',
      query: {},
    })
    expect(res.statusCode).toBe(400)
  })

  it('returns 400 when token exceeds max length', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/public/unsubscribe',
      query: { token: 'a'.repeat(129) },
    })
    expect(res.statusCode).toBe(400)
  })

  it('is idempotent — second click returns 200, not 400', async () => {
    const { token } = await createVerifiedSubscriber(app, 'unsub-idempotent')

    await app.inject({ method: 'GET', url: '/api/v1/public/unsubscribe', query: { token } })
    const res2 = await app.inject({ method: 'GET', url: '/api/v1/public/unsubscribe', query: { token } })

    expect(res2.statusCode).toBe(200)
    expect(JSON.parse(res2.body)).toEqual({ unsubscribed: true })
  })

  it('re-subscribe after unsubscribe clears unsubscribedAt and sends verification', async () => {
    const { cookie } = await registerAndGetCookie(app, 'unsub-resub')
    const { projectId, widgetKey } = await createProjectAndGetKey(app, cookie, 'unsub-resub')
    const email = testEmail('unsub-resub-user')

    await app.inject({ method: 'POST', url: `/api/v1/public/${widgetKey}/subscribe`, payload: { email } })
    const sub = await prisma.subscriber.findUnique({ where: { projectId_email: { projectId, email } } })
    await prisma.subscriber.update({ where: { id: sub!.id }, data: { verified: true } })

    // Unsubscribe
    await app.inject({ method: 'GET', url: '/api/v1/public/unsubscribe', query: { token: sub!.unsubscribeToken } })
    const afterUnsub = await prisma.subscriber.findUnique({ where: { projectId_email: { projectId, email } } })
    expect(afterUnsub!.unsubscribedAt).not.toBeNull()

    // Re-subscribe
    ;(app.subscriptionVerificationQueue.add as jest.Mock).mockClear()
    const res = await app.inject({ method: 'POST', url: `/api/v1/public/${widgetKey}/subscribe`, payload: { email } })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ status: 'verification_sent' })

    const afterResub = await prisma.subscriber.findUnique({ where: { projectId_email: { projectId, email } } })
    expect(afterResub!.id).toBe(sub!.id)
    expect(afterResub!.unsubscribedAt).toBeNull()
    // Token must be rotated so old verification links from prior cycles cannot be replayed
    expect(afterResub!.verificationToken).not.toBe(sub!.verificationToken)
  })
})

// ─── GET /api/v1/public/voter-unsubscribe ────────────────────────────────────

describe('GET /api/v1/public/voter-unsubscribe', () => {
  it('sets notifyOnStatusChange=false and returns { unsubscribed: true }', async () => {
    const { cookie } = await registerAndGetCookie(app, 'voter-unsub')
    const { widgetKey } = await createProjectAndGetKey(app, cookie, 'voter-unsub')
    const email = testEmail('voter-unsub-user')

    const featureRes = await app.inject({
      method: 'POST',
      url: `/api/v1/public/${widgetKey}/features`,
      payload: { title: 'Voter unsub feature', email },
    })
    const featureId = JSON.parse(featureRes.body).id

    const vote = await prisma.vote.findFirst({ where: { featureRequestId: featureId, voterEmail: email } })
    expect(vote).not.toBeNull()

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/public/voter-unsubscribe',
      query: { token: vote!.unsubscribeToken },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ unsubscribed: true })

    const updated = await prisma.vote.findFirst({ where: { id: vote!.id } })
    expect(updated!.notifyOnStatusChange).toBe(false)
  })

  it('is idempotent — second click still returns 200', async () => {
    const { cookie } = await registerAndGetCookie(app, 'voter-unsub-idem')
    const { widgetKey } = await createProjectAndGetKey(app, cookie, 'voter-unsub-idem')
    const email = testEmail('voter-unsub-idem-user')

    const featureRes = await app.inject({ method: 'POST', url: `/api/v1/public/${widgetKey}/features`, payload: { title: 'Idempotent feature', email } })
    const featureId = JSON.parse(featureRes.body).id
    const vote = await prisma.vote.findFirst({ where: { featureRequestId: featureId, voterEmail: email } })

    await app.inject({ method: 'GET', url: '/api/v1/public/voter-unsubscribe', query: { token: vote!.unsubscribeToken } })
    const res2 = await app.inject({ method: 'GET', url: '/api/v1/public/voter-unsubscribe', query: { token: vote!.unsubscribeToken } })
    expect(res2.statusCode).toBe(200)
    expect(JSON.parse(res2.body)).toEqual({ unsubscribed: true })
  })

  it('returns 200 for unknown token', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/public/voter-unsubscribe', query: { token: crypto.randomUUID() } })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ unsubscribed: true })
  })

  it('returns 400 when token is missing', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/public/voter-unsubscribe', query: {} })
    expect(res.statusCode).toBe(400)
  })
})

// ─── processSubscribeVerificationJob integration ──────────────────────────────

describe('processSubscribeVerificationJob (integration)', () => {
  it('sends verification email with correct verifyUrl and unsubscribeUrl', async () => {
    const { cookie } = await registerAndGetCookie(app, 'sub-worker-send')
    const { projectId, widgetKey } = await createProjectAndGetKey(app, cookie, 'sub-worker-send')
    const email = testEmail('sub-ws-user')

    await app.inject({
      method: 'POST',
      url: `/api/v1/public/${widgetKey}/subscribe`,
      payload: { email },
    })

    const subscriber = await prisma.subscriber.findFirst({ where: { projectId, email } })
    expect(subscriber).not.toBeNull()

    const mockSendEmail = jest.fn().mockResolvedValue({ ok: true })
    const mockLog = { warn: jest.fn(), info: jest.fn(), error: jest.fn() } as any

    const jobData: SubscriptionVerificationJobData = {
      type: 'subscribe_verification',
      referenceId: subscriber!.id,
      projectId,
    }

    await processSubscribeVerificationJob(jobData, { prisma, log: mockLog, sendEmail: mockSendEmail })

    expect(mockSendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: email,
        verifyUrl: expect.stringContaining(encodeURIComponent(subscriber!.verificationToken)),
        unsubscribeUrl: expect.stringContaining(encodeURIComponent(subscriber!.unsubscribeToken)),
      }),
    )
  })

  it('skips sending if subscriber already verified', async () => {
    const { cookie } = await registerAndGetCookie(app, 'sub-worker-skip')
    const { projectId, widgetKey } = await createProjectAndGetKey(app, cookie, 'sub-worker-skip')
    const email = testEmail('sub-skip-user')

    await app.inject({
      method: 'POST',
      url: `/api/v1/public/${widgetKey}/subscribe`,
      payload: { email },
    })

    const subscriber = await prisma.subscriber.findFirst({ where: { projectId, email } })
    await prisma.subscriber.update({ where: { id: subscriber!.id }, data: { verified: true } })

    const mockSendEmail = jest.fn()
    const mockLog = { warn: jest.fn(), info: jest.fn(), error: jest.fn() } as any

    await processSubscribeVerificationJob(
      { type: 'subscribe_verification', referenceId: subscriber!.id, projectId },
      { prisma, log: mockLog, sendEmail: mockSendEmail },
    )

    expect(mockSendEmail).not.toHaveBeenCalled()
    expect(mockLog.info).toHaveBeenCalledWith(
      expect.objectContaining({ subscriberId: subscriber!.id }),
      expect.stringContaining('already verified'),
    )
  })

  it('throws on email send failure so BullMQ can retry', async () => {
    const { cookie } = await registerAndGetCookie(app, 'sub-worker-throw')
    const { projectId, widgetKey } = await createProjectAndGetKey(app, cookie, 'sub-worker-throw')
    const email = testEmail('sub-throw-user')

    await app.inject({
      method: 'POST',
      url: `/api/v1/public/${widgetKey}/subscribe`,
      payload: { email },
    })

    const subscriber = await prisma.subscriber.findFirst({ where: { projectId, email } })

    const mockSendEmail = jest.fn().mockResolvedValue({ ok: false, error: 'SMTP error' })
    const mockLog = { warn: jest.fn(), info: jest.fn(), error: jest.fn() } as any

    await expect(
      processSubscribeVerificationJob(
        { type: 'subscribe_verification', referenceId: subscriber!.id, projectId },
        { prisma, log: mockLog, sendEmail: mockSendEmail },
      ),
    ).rejects.toThrow('SMTP error')
  })
})
