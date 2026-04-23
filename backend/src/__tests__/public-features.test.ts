import crypto from 'crypto'
import { buildApp } from '../index'
import { FastifyInstance } from 'fastify'
import { PrismaClient } from '@prisma/client'
import {
  processVoteVerificationJob,
} from '../workers/notificationWorker'
import type { NotificationJobData } from '../jobs/index'

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

// ─── POST /api/v1/public/:projectKey/features ────────────────────────────────

describe('POST /api/v1/public/:projectKey/features', () => {
  it('creates feature and vote, returns 201 with correct shape', async () => {
    const { cookie } = await registerAndGetCookie(app, 'submit-happy')
    const { projectId, widgetKey } = await createProjectAndGetKey(app, cookie, 'submit-happy')

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/public/${widgetKey}/features`,
      payload: { title: 'Dark mode', description: 'Please add dark mode', email: testEmail('voter-1') },
    })

    expect(res.statusCode).toBe(201)
    const body = JSON.parse(res.body)
    expect(body).toMatchObject({
      title: 'Dark mode',
      description: 'Please add dark mode',
      status: 'open',
      voteCount: 0,
      projectId,
    })
    expect(body.id).toBeDefined()
    expect(body.createdAt).toBeDefined()
    expect(body.updatedAt).toBeDefined()
  })

  it('does not expose submitterEmail or verificationToken in response', async () => {
    const { cookie } = await registerAndGetCookie(app, 'no-pii')
    const { widgetKey } = await createProjectAndGetKey(app, cookie, 'no-pii')

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/public/${widgetKey}/features`,
      payload: { title: 'PII test', email: testEmail('voter-pii') },
    })
    expect(res.statusCode).toBe(201)
    const body = JSON.parse(res.body)
    expect(body.submitterEmail).toBeUndefined()
    expect(body.verificationToken).toBeUndefined()
  })

  it('creates an unverified vote row in the DB', async () => {
    const { cookie } = await registerAndGetCookie(app, 'vote-row')
    const { widgetKey } = await createProjectAndGetKey(app, cookie, 'vote-row')
    const voterEmail = testEmail('voter-vr')

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/public/${widgetKey}/features`,
      payload: { title: 'Better search', email: voterEmail },
    })
    expect(res.statusCode).toBe(201)
    const featureId = JSON.parse(res.body).id

    const vote = await prisma.vote.findFirst({ where: { featureRequestId: featureId, voterEmail } })
    expect(vote).not.toBeNull()
    expect(vote!.verified).toBe(false)
    expect(vote!.verificationToken).toBeDefined()
  })

  it('queues a vote_verification job', async () => {
    const { cookie } = await registerAndGetCookie(app, 'queue-job')
    const { projectId, widgetKey } = await createProjectAndGetKey(app, cookie, 'queue-job')

    await app.inject({
      method: 'POST',
      url: `/api/v1/public/${widgetKey}/features`,
      payload: { title: 'Webhooks', email: testEmail('voter-qj') },
    })

    expect(app.notificationQueue.add).toHaveBeenCalledWith(
      'vote_verification',
      expect.objectContaining({ type: 'vote_verification', projectId }),
    )
  })

  it('still returns 201 when notificationQueue.add throws', async () => {
    const { cookie } = await registerAndGetCookie(app, 'queue-fail')
    const { widgetKey } = await createProjectAndGetKey(app, cookie, 'queue-fail')

    const original = app.notificationQueue.add as jest.Mock
    original.mockRejectedValueOnce(new Error('Redis connection refused'))

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/public/${widgetKey}/features`,
      payload: { title: 'Queue fail feature', email: testEmail('voter-qf') },
    })
    expect(res.statusCode).toBe(201)

    // Vote is still committed to DB despite queue failure
    const featureId = JSON.parse(res.body).id
    const vote = await prisma.vote.findFirst({ where: { featureRequestId: featureId } })
    expect(vote).not.toBeNull()
  })

  it('works without description (optional field)', async () => {
    const { cookie } = await registerAndGetCookie(app, 'no-desc')
    const { widgetKey } = await createProjectAndGetKey(app, cookie, 'no-desc')

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/public/${widgetKey}/features`,
      payload: { title: 'Minimal request', email: testEmail('voter-nd') },
    })
    expect(res.statusCode).toBe(201)
    expect(JSON.parse(res.body).description).toBeNull()
  })

  it('accepts title at max length (200 chars)', async () => {
    const { cookie } = await registerAndGetCookie(app, 'title-max')
    const { widgetKey } = await createProjectAndGetKey(app, cookie, 'title-max')

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/public/${widgetKey}/features`,
      payload: { title: 'a'.repeat(200), email: testEmail('voter-tm') },
    })
    expect(res.statusCode).toBe(201)
  })

  it('rejects title over max length (201 chars)', async () => {
    const { cookie } = await registerAndGetCookie(app, 'title-over')
    const { widgetKey } = await createProjectAndGetKey(app, cookie, 'title-over')

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/public/${widgetKey}/features`,
      payload: { title: 'a'.repeat(201), email: testEmail('voter-to') },
    })
    expect(res.statusCode).toBe(400)
  })

  it('accepts description at max length (1000 chars)', async () => {
    const { cookie } = await registerAndGetCookie(app, 'desc-max')
    const { widgetKey } = await createProjectAndGetKey(app, cookie, 'desc-max')

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/public/${widgetKey}/features`,
      payload: { title: 'Desc max', description: 'b'.repeat(1000), email: testEmail('voter-dm') },
    })
    expect(res.statusCode).toBe(201)
  })

  it('rejects description over max length (1001 chars)', async () => {
    const { cookie } = await registerAndGetCookie(app, 'desc-over')
    const { widgetKey } = await createProjectAndGetKey(app, cookie, 'desc-over')

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/public/${widgetKey}/features`,
      payload: { title: 'Desc over', description: 'b'.repeat(1001), email: testEmail('voter-do') },
    })
    expect(res.statusCode).toBe(400)
  })

  it('returns 404 for unknown projectKey', async () => {
    const fakeKey = crypto.randomUUID()
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/public/${fakeKey}/features`,
      payload: { title: 'Ghost feature', email: 'user@example.com' },
    })
    expect(res.statusCode).toBe(404)
  })

  it('returns 404 for projectKey exceeding max length', async () => {
    const longKey = 'a'.repeat(65)
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/public/${longKey}/features`,
      payload: { title: 'Long key', email: 'user@example.com' },
    })
    expect(res.statusCode).toBe(404)
  })

  it('returns 400 when title is missing', async () => {
    const { cookie } = await registerAndGetCookie(app, 'no-title')
    const { widgetKey } = await createProjectAndGetKey(app, cookie, 'no-title')

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/public/${widgetKey}/features`,
      payload: { email: 'user@example.com' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('returns 400 when email is missing', async () => {
    const { cookie } = await registerAndGetCookie(app, 'no-email')
    const { widgetKey } = await createProjectAndGetKey(app, cookie, 'no-email')

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/public/${widgetKey}/features`,
      payload: { title: 'No email feature' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('returns 400 for invalid email format', async () => {
    const { cookie } = await registerAndGetCookie(app, 'bad-email')
    const { widgetKey } = await createProjectAndGetKey(app, cookie, 'bad-email')

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/public/${widgetKey}/features`,
      payload: { title: 'Bad email feature', email: 'not-an-email' },
    })
    expect(res.statusCode).toBe(400)
  })
})

// ─── processVoteVerificationJob ──────────────────────────────────────────────

describe('processVoteVerificationJob', () => {
  it('sends verification email with correct verifyUrl', async () => {
    const { cookie } = await registerAndGetCookie(app, 'worker-send')
    const { projectId, widgetKey } = await createProjectAndGetKey(app, cookie, 'worker-send')

    const submitRes = await app.inject({
      method: 'POST',
      url: `/api/v1/public/${widgetKey}/features`,
      payload: { title: 'Worker test feature', email: testEmail('voter-ws') },
    })
    expect(submitRes.statusCode).toBe(201)
    const featureId = JSON.parse(submitRes.body).id

    const vote = await prisma.vote.findFirst({ where: { featureRequestId: featureId } })
    expect(vote).not.toBeNull()

    const mockSendEmail = jest.fn().mockResolvedValue({ ok: true })
    const mockLog = { warn: jest.fn(), info: jest.fn(), error: jest.fn() } as any

    const jobData: NotificationJobData = {
      type: 'vote_verification',
      referenceId: vote!.id,
      projectId,
    }

    await processVoteVerificationJob(jobData, { prisma, log: mockLog, sendEmail: mockSendEmail })

    expect(mockSendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: testEmail('voter-ws'),
        featureTitle: 'Worker test feature',
        verifyUrl: expect.stringContaining(encodeURIComponent(vote!.verificationToken)),
      }),
    )
  })

  it('skips sending if vote already verified', async () => {
    const { cookie } = await registerAndGetCookie(app, 'worker-skip')
    const { projectId, widgetKey } = await createProjectAndGetKey(app, cookie, 'worker-skip')

    const submitRes = await app.inject({
      method: 'POST',
      url: `/api/v1/public/${widgetKey}/features`,
      payload: { title: 'Already verified feature', email: testEmail('voter-skip') },
    })
    expect(submitRes.statusCode).toBe(201)
    const featureId = JSON.parse(submitRes.body).id

    const vote = await prisma.vote.findFirst({ where: { featureRequestId: featureId } })
    await prisma.vote.update({ where: { id: vote!.id }, data: { verified: true } })

    const mockSendEmail = jest.fn().mockResolvedValue({ ok: true })
    const mockLog = { warn: jest.fn(), info: jest.fn(), error: jest.fn() } as any

    await processVoteVerificationJob(
      { type: 'vote_verification', referenceId: vote!.id, projectId },
      { prisma, log: mockLog, sendEmail: mockSendEmail },
    )

    expect(mockSendEmail).not.toHaveBeenCalled()
    expect(mockLog.info).toHaveBeenCalledWith(
      expect.objectContaining({ voteId: vote!.id }),
      expect.stringContaining('already verified'),
    )
  })

  it('skips if vote not found', async () => {
    const fakeVoteId = crypto.randomUUID()
    const fakeProjectId = crypto.randomUUID()
    const mockSendEmail = jest.fn()
    const mockLog = { warn: jest.fn(), info: jest.fn(), error: jest.fn() } as any

    await processVoteVerificationJob(
      { type: 'vote_verification', referenceId: fakeVoteId, projectId: fakeProjectId },
      { prisma, log: mockLog, sendEmail: mockSendEmail },
    )

    expect(mockSendEmail).not.toHaveBeenCalled()
    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({ voteId: fakeVoteId }),
      expect.stringContaining('not found'),
    )
  })

  it('throws on email send failure so BullMQ can retry', async () => {
    const { cookie } = await registerAndGetCookie(app, 'worker-throw')
    const { projectId, widgetKey } = await createProjectAndGetKey(app, cookie, 'worker-throw')

    const submitRes = await app.inject({
      method: 'POST',
      url: `/api/v1/public/${widgetKey}/features`,
      payload: { title: 'Throw on failure', email: testEmail('voter-throw') },
    })
    expect(submitRes.statusCode).toBe(201)
    const featureId = JSON.parse(submitRes.body).id
    const vote = await prisma.vote.findFirst({ where: { featureRequestId: featureId } })

    const mockSendEmail = jest.fn().mockResolvedValue({ ok: false, error: 'SMTP timeout' })
    const mockLog = { warn: jest.fn(), info: jest.fn(), error: jest.fn() } as any

    await expect(
      processVoteVerificationJob(
        { type: 'vote_verification', referenceId: vote!.id, projectId },
        { prisma, log: mockLog, sendEmail: mockSendEmail },
      ),
    ).rejects.toThrow('SMTP timeout')
  })
})
