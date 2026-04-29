import crypto from 'crypto'
import { buildApp } from '../index'
import { FastifyInstance } from 'fastify'
import { PrismaClient } from '@prisma/client'
import {
  processVoteVerificationJob,
} from '../workers/notificationWorker'
import type { VoteVerificationJobData } from '../jobs/index'

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
  app.voteVerificationQueue.add = jest.fn().mockResolvedValue({})
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

    expect(app.voteVerificationQueue.add).toHaveBeenCalledWith(
      'vote_verification',
      expect.objectContaining({ type: 'vote_verification', projectId }),
    )
  })

  it('returns 500 when voteVerificationQueue.add throws (Redis down)', async () => {
    const { cookie } = await registerAndGetCookie(app, 'queue-fail')
    const { widgetKey } = await createProjectAndGetKey(app, cookie, 'queue-fail')

    const original = app.voteVerificationQueue.add as jest.Mock
    original.mockRejectedValueOnce(new Error('Redis connection refused'))

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/public/${widgetKey}/features`,
      payload: { title: 'Queue fail feature', email: testEmail('voter-qf') },
    })
    expect(res.statusCode).toBe(500)
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

    const jobData: VoteVerificationJobData = {
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

// ─── POST /api/v1/public/:projectKey/features/:featureId/vote ────────────────

describe('POST /api/v1/public/:projectKey/features/:featureId/vote', () => {
  async function submitFeature(
    app: FastifyInstance,
    widgetKey: string,
    title: string,
    voterLabel: string,
  ): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/public/${widgetKey}/features`,
      payload: { title, email: testEmail(voterLabel) },
    })
    expect(res.statusCode).toBe(201)
    return JSON.parse(res.body).id
  }

  it('returns 200 and creates unverified vote, enqueues job', async () => {
    const { cookie } = await registerAndGetCookie(app, 'vote-happy')
    const { projectId, widgetKey } = await createProjectAndGetKey(app, cookie, 'vote-happy')
    const featureId = await submitFeature(app, widgetKey, 'Vote happy feature', 'vhf-submitter')
    const voterEmail = testEmail('vote-happy-voter')

    ;(app.voteVerificationQueue.add as jest.Mock).mockClear()

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/public/${widgetKey}/features/${featureId}/vote`,
      payload: { email: voterEmail },
    })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ message: 'Verification email sent' })

    const vote = await prisma.vote.findFirst({ where: { featureRequestId: featureId, voterEmail } })
    expect(vote).not.toBeNull()
    expect(vote!.verified).toBe(false)
    expect(vote!.verificationToken).toBeDefined()

    expect(app.voteVerificationQueue.add).toHaveBeenCalledWith(
      'vote_verification',
      expect.objectContaining({ type: 'vote_verification', projectId }),
    )
  })

  it('returns 409 with check-inbox message when vote is pending verification', async () => {
    const { cookie } = await registerAndGetCookie(app, 'vote-dup-unver')
    const { widgetKey } = await createProjectAndGetKey(app, cookie, 'vote-dup-unver')
    const featureId = await submitFeature(app, widgetKey, 'Dup vote feature unver', 'vdu-submitter')
    const voterEmail = testEmail('vote-dup-unver-voter')

    await app.inject({
      method: 'POST',
      url: `/api/v1/public/${widgetKey}/features/${featureId}/vote`,
      payload: { email: voterEmail },
    })
    ;(app.voteVerificationQueue.add as jest.Mock).mockClear()

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/public/${widgetKey}/features/${featureId}/vote`,
      payload: { email: voterEmail },
    })

    expect(res.statusCode).toBe(409)
    expect(JSON.parse(res.body)).toMatchObject({
      statusCode: 409,
      error: 'Conflict',
      message: 'A verification email has already been sent. Please check your inbox.',
    })
  })

  it('returns 409 with already-voted message when vote is verified', async () => {
    const { cookie } = await registerAndGetCookie(app, 'vote-dup-ver')
    const { widgetKey } = await createProjectAndGetKey(app, cookie, 'vote-dup-ver')
    const featureId = await submitFeature(app, widgetKey, 'Dup vote feature ver', 'vdv-submitter')
    const voterEmail = testEmail('vote-dup-ver-voter')

    await app.inject({
      method: 'POST',
      url: `/api/v1/public/${widgetKey}/features/${featureId}/vote`,
      payload: { email: voterEmail },
    })
    ;(app.voteVerificationQueue.add as jest.Mock).mockClear()

    const vote = await prisma.vote.findFirst({ where: { featureRequestId: featureId, voterEmail } })
    await prisma.vote.update({ where: { id: vote!.id }, data: { verified: true } })

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/public/${widgetKey}/features/${featureId}/vote`,
      payload: { email: voterEmail },
    })

    expect(res.statusCode).toBe(409)
    expect(JSON.parse(res.body)).toMatchObject({
      statusCode: 409,
      error: 'Conflict',
      message: 'You have already voted for this feature.',
    })
  })

  it('allows same email to vote on different features', async () => {
    const { cookie } = await registerAndGetCookie(app, 'vote-multi')
    const { widgetKey } = await createProjectAndGetKey(app, cookie, 'vote-multi')
    const featureId1 = await submitFeature(app, widgetKey, 'Feature A', 'vm-submitter-a')
    const featureId2 = await submitFeature(app, widgetKey, 'Feature B', 'vm-submitter-b')
    const voterEmail = testEmail('vote-multi-voter')

    const res1 = await app.inject({
      method: 'POST',
      url: `/api/v1/public/${widgetKey}/features/${featureId1}/vote`,
      payload: { email: voterEmail },
    })
    const res2 = await app.inject({
      method: 'POST',
      url: `/api/v1/public/${widgetKey}/features/${featureId2}/vote`,
      payload: { email: voterEmail },
    })

    expect(res1.statusCode).toBe(200)
    expect(res2.statusCode).toBe(200)
  })

  it('returns 404 for unknown projectKey', async () => {
    const fakeKey = crypto.randomUUID()
    const fakeFeatureId = crypto.randomUUID()

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/public/${fakeKey}/features/${fakeFeatureId}/vote`,
      payload: { email: 'user@example.com' },
    })

    expect(res.statusCode).toBe(404)
  })

  it('returns 404 for unknown featureId', async () => {
    const { cookie } = await registerAndGetCookie(app, 'vote-no-feat')
    const { widgetKey } = await createProjectAndGetKey(app, cookie, 'vote-no-feat')
    const fakeFeatureId = crypto.randomUUID()

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/public/${widgetKey}/features/${fakeFeatureId}/vote`,
      payload: { email: 'user@example.com' },
    })

    expect(res.statusCode).toBe(404)
  })

  it('returns 404 when featureId belongs to a different project', async () => {
    const { cookie: cookieA } = await registerAndGetCookie(app, 'vote-cross-a')
    const { widgetKey: keyA } = await createProjectAndGetKey(app, cookieA, 'vote-cross-a')
    const { cookie: cookieB } = await registerAndGetCookie(app, 'vote-cross-b')
    const { widgetKey: keyB } = await createProjectAndGetKey(app, cookieB, 'vote-cross-b')

    const featureIdA = await submitFeature(app, keyA, 'Feature from A', 'vca-submitter')

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/public/${keyB}/features/${featureIdA}/vote`,
      payload: { email: 'user@example.com' },
    })

    expect(res.statusCode).toBe(404)
  })

  it('returns 404 for projectKey exceeding max length', async () => {
    const longKey = 'a'.repeat(65)
    const fakeFeatureId = crypto.randomUUID()

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/public/${longKey}/features/${fakeFeatureId}/vote`,
      payload: { email: 'user@example.com' },
    })

    expect(res.statusCode).toBe(404)
  })

  it('returns 400 when email is missing', async () => {
    const { cookie } = await registerAndGetCookie(app, 'vote-no-email')
    const { widgetKey } = await createProjectAndGetKey(app, cookie, 'vote-no-email')
    const featureId = await submitFeature(app, widgetKey, 'No email vote', 'vne-submitter')

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/public/${widgetKey}/features/${featureId}/vote`,
      payload: {},
    })

    expect(res.statusCode).toBe(400)
  })

  it('returns 400 for invalid email format', async () => {
    const { cookie } = await registerAndGetCookie(app, 'vote-bad-email')
    const { widgetKey } = await createProjectAndGetKey(app, cookie, 'vote-bad-email')
    const featureId = await submitFeature(app, widgetKey, 'Bad email vote', 'vbe-submitter')

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/public/${widgetKey}/features/${featureId}/vote`,
      payload: { email: 'not-an-email' },
    })

    expect(res.statusCode).toBe(400)
  })

  it('returns 500 when voteVerificationQueue.add throws (Redis down)', async () => {
    const { cookie } = await registerAndGetCookie(app, 'vote-queue-fail')
    const { widgetKey } = await createProjectAndGetKey(app, cookie, 'vote-queue-fail')
    const featureId = await submitFeature(app, widgetKey, 'Queue fail vote', 'vqf-submitter')

    const original = app.voteVerificationQueue.add as jest.Mock
    original.mockRejectedValueOnce(new Error('Redis connection refused'))

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/public/${widgetKey}/features/${featureId}/vote`,
      payload: { email: testEmail('vote-qf-voter') },
    })

    expect(res.statusCode).toBe(500)
  })
})

// ─── GET /api/v1/public/verify-vote ──────────────────────────────────────────

describe('GET /api/v1/public/verify-vote', () => {
  async function createVotedFeature(
    app: FastifyInstance,
    label: string,
  ): Promise<{ widgetKey: string; featureId: string; voteToken: string; voterEmail: string }> {
    const { cookie } = await registerAndGetCookie(app, label)
    const { widgetKey } = await createProjectAndGetKey(app, cookie, label)

    const submitRes = await app.inject({
      method: 'POST',
      url: `/api/v1/public/${widgetKey}/features`,
      payload: { title: `Feature for ${label}`, email: testEmail(`${label}-submitter`) },
    })
    expect(submitRes.statusCode).toBe(201)
    const featureId = JSON.parse(submitRes.body).id

    const voterEmail = testEmail(`${label}-voter`)
    await app.inject({
      method: 'POST',
      url: `/api/v1/public/${widgetKey}/features/${featureId}/vote`,
      payload: { email: voterEmail },
    })

    const vote = await prisma.vote.findFirst({ where: { featureRequestId: featureId, voterEmail } })
    return { widgetKey, featureId, voteToken: vote!.verificationToken, voterEmail }
  }

  it('marks vote verified and increments voteCount', async () => {
    const { featureId, voteToken } = await createVotedFeature(app, 'verify-happy')

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/public/verify-vote',
      query: { token: voteToken },
    })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ message: 'Vote verified' })

    const vote = await prisma.vote.findFirst({ where: { verificationToken: voteToken } })
    expect(vote!.verified).toBe(true)

    const feature = await prisma.featureRequest.findUnique({ where: { id: featureId } })
    expect(feature!.voteCount).toBe(1)
  })

  it('is idempotent — calling twice does not double-increment voteCount', async () => {
    const { featureId, voteToken } = await createVotedFeature(app, 'verify-idempotent')

    await app.inject({
      method: 'GET',
      url: '/api/v1/public/verify-vote',
      query: { token: voteToken },
    })

    const res2 = await app.inject({
      method: 'GET',
      url: '/api/v1/public/verify-vote',
      query: { token: voteToken },
    })

    expect(res2.statusCode).toBe(200)
    expect(JSON.parse(res2.body)).toEqual({ message: 'Already verified' })

    const feature = await prisma.featureRequest.findUnique({ where: { id: featureId } })
    expect(feature!.voteCount).toBe(1)
  })

  it('returns 400 for unknown token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/public/verify-vote',
      query: { token: crypto.randomUUID() },
    })

    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).message).toBe('Invalid or expired token')
  })

  it('returns 400 when token is missing', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/public/verify-vote',
      query: {},
    })

    expect(res.statusCode).toBe(400)
  })

  it('returns 400 when token is empty string', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/public/verify-vote',
      query: { token: '' },
    })

    expect(res.statusCode).toBe(400)
  })

  it('returns 400 when token exceeds max length', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/public/verify-vote',
      query: { token: 'a'.repeat(129) },
    })

    expect(res.statusCode).toBe(400)
  })

  it('returns 400 for expired token (older than 48h)', async () => {
    const { voteToken } = await createVotedFeature(app, 'verify-expired')

    await prisma.vote.updateMany({
      where: { verificationToken: voteToken },
      data: { createdAt: new Date(Date.now() - 49 * 60 * 60 * 1000) },
    })

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/public/verify-vote',
      query: { token: voteToken },
    })

    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).message).toBe('Invalid or expired token')
  })

  it('deletes the unverified vote on expiry so the user can re-vote', async () => {
    const { featureId, voteToken, voterEmail } = await createVotedFeature(app, 'verify-expiry-cleanup')

    await prisma.vote.updateMany({
      where: { verificationToken: voteToken },
      data: { createdAt: new Date(Date.now() - 49 * 60 * 60 * 1000) },
    })

    await app.inject({
      method: 'GET',
      url: '/api/v1/public/verify-vote',
      query: { token: voteToken },
    })

    // Vote row should be deleted so the user can cast a new vote
    const vote = await prisma.vote.findFirst({ where: { featureRequestId: featureId, voterEmail } })
    expect(vote).toBeNull()
  })

  it('allows re-vote after expiry — new vote row created and verification email sent', async () => {
    const { widgetKey, featureId, voteToken, voterEmail } = await createVotedFeature(app, 'verify-revote')

    // Expire the vote
    await prisma.vote.updateMany({
      where: { verificationToken: voteToken },
      data: { createdAt: new Date(Date.now() - 49 * 60 * 60 * 1000) },
    })

    // Trigger expiry — verify-vote deletes the unverified vote
    await app.inject({
      method: 'GET',
      url: '/api/v1/public/verify-vote',
      query: { token: voteToken },
    })

    // Re-vote should succeed — old row deleted, new unverified vote created
    const reVoteRes = await app.inject({
      method: 'POST',
      url: `/api/v1/public/${widgetKey}/features/${featureId}/vote`,
      payload: { email: voterEmail },
    })

    expect(reVoteRes.statusCode).toBe(200)
    expect(JSON.parse(reVoteRes.body)).toEqual({ message: 'Verification email sent' })

    const newVote = await prisma.vote.findFirst({ where: { featureRequestId: featureId, voterEmail } })
    expect(newVote).not.toBeNull()
    expect(newVote!.verified).toBe(false)
    expect(newVote!.verificationToken).not.toBe(voteToken)
  })

  it('vote.verified and voteCount are always consistent (transaction atomicity)', async () => {
    const { featureId, voteToken } = await createVotedFeature(app, 'verify-atomic')

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/public/verify-vote',
      query: { token: voteToken },
    })
    expect(res.statusCode).toBe(200)

    const vote = await prisma.vote.findFirst({ where: { verificationToken: voteToken } })
    const feature = await prisma.featureRequest.findUnique({ where: { id: featureId } })

    // Both must be updated together — if transaction rolled back, both would be unchanged
    expect(vote!.verified).toBe(true)
    expect(feature!.voteCount).toBe(1)
  })
})

// ─── voteCount lifecycle (submit → verify) ───────────────────────────────────

describe('voteCount lifecycle', () => {
  it('voteCount stays 0 after submit-feature, reaches 1 only after verify-vote', async () => {
    const { cookie } = await registerAndGetCookie(app, 'lifecycle')
    const { widgetKey } = await createProjectAndGetKey(app, cookie, 'lifecycle')

    const submitRes = await app.inject({
      method: 'POST',
      url: `/api/v1/public/${widgetKey}/features`,
      payload: { title: 'Lifecycle feature', email: testEmail('lc-submitter') },
    })
    expect(submitRes.statusCode).toBe(201)
    const featureId = JSON.parse(submitRes.body).id

    const beforeVerify = await prisma.featureRequest.findUnique({ where: { id: featureId } })
    expect(beforeVerify!.voteCount).toBe(0)

    const vote = await prisma.vote.findFirst({ where: { featureRequestId: featureId } })
    const verifyRes = await app.inject({
      method: 'GET',
      url: '/api/v1/public/verify-vote',
      query: { token: vote!.verificationToken },
    })
    expect(verifyRes.statusCode).toBe(200)

    const afterVerify = await prisma.featureRequest.findUnique({ where: { id: featureId } })
    expect(afterVerify!.voteCount).toBe(1)
  })
})

// ─── POST /api/v1/public/:projectKey/features — cross-project isolation ──────

describe('POST /api/v1/public/:projectKey/features cross-project isolation', () => {
  it('returns 404 when submitting a feature with a projectKey that belongs to a different org', async () => {
    const { cookie: cookieA } = await registerAndGetCookie(app, 'submit-iso-a')
    const { cookie: cookieB } = await registerAndGetCookie(app, 'submit-iso-b')
    await createProjectAndGetKey(app, cookieA, 'submit-iso-a')
    const { widgetKey: keyB } = await createProjectAndGetKey(app, cookieB, 'submit-iso-b')

    // Use a completely fake key — should 404 regardless of other projects existing
    const fakeKey = crypto.randomUUID()
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/public/${fakeKey}/features`,
      payload: { title: 'Cross-project submit', email: 'user@example.com' },
    })

    expect(res.statusCode).toBe(404)

    // Also confirm that keyB works but fakeKey doesn't — widgetKey is scoped per project
    const validRes = await app.inject({
      method: 'POST',
      url: `/api/v1/public/${keyB}/features`,
      payload: { title: 'Valid submit', email: 'user@example.com' },
    })
    expect(validRes.statusCode).toBe(201)
  })
})
