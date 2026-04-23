import { processChangelogPublishedJob, handleWorkerFailedEvent } from '../workers/notificationWorker'
import { NotificationJobData } from '../jobs/index'
import { SendResult } from '../services/emailService'

type SendFn = (opts: { to: string; entryTitle: string; changelogUrl: string }) => Promise<SendResult>

function makeJob(overrides: Partial<NotificationJobData> = {}): NotificationJobData {
  return {
    type: 'changelog_published',
    referenceId: 'entry-uuid-1',
    projectId: 'project-uuid-1',
    ...overrides,
  }
}

function makeDeps(overrides: {
  findFirst?: jest.Mock
  findMany?: jest.Mock
  notificationLogFindMany?: jest.Mock
  createLog?: jest.Mock
  sendEmail?: jest.Mock
} = {}) {
  const findFirst = overrides.findFirst ?? jest.fn().mockResolvedValue({
    title: 'Test Entry',
    project: { slug: 'acme' },
  })

  const subscriberFindMany = overrides.findMany ?? jest.fn().mockResolvedValue([
    { id: 'sub-1', email: 'a@example.com' },
  ])

  const notificationLogFindMany = overrides.notificationLogFindMany ?? jest.fn().mockResolvedValue([])

  const createLog = overrides.createLog ?? jest.fn().mockResolvedValue({})

  const sendEmail: jest.Mock<Promise<SendResult>> =
    overrides.sendEmail ?? jest.fn().mockResolvedValue({ ok: true })

  const prisma = {
    changelogEntry: { findFirst },
    subscriber: { findMany: subscriberFindMany },
    notificationLog: {
      findMany: notificationLogFindMany,
      create: createLog,
    },
  } as unknown as Parameters<typeof processChangelogPublishedJob>[1]['prisma']

  const log = {
    warn: jest.fn(),
    info: jest.fn(),
    error: jest.fn(),
  } as unknown as Parameters<typeof processChangelogPublishedJob>[1]['log']

  return { prisma, log, sendEmail: sendEmail as SendFn, mocks: { findFirst, subscriberFindMany, notificationLogFindMany, createLog, sendEmail } }
}

describe('processChangelogPublishedJob', () => {
  it('returns early for non-changelog_published type', async () => {
    const { prisma, log, sendEmail, mocks } = makeDeps()
    await processChangelogPublishedJob(makeJob({ type: 'vote_verification' }), { prisma, log, sendEmail })
    expect(mocks.findFirst).not.toHaveBeenCalled()
  })

  it('returns early when entry not found', async () => {
    const { prisma, log, sendEmail, mocks } = makeDeps({
      findFirst: jest.fn().mockResolvedValue(null),
    })
    await processChangelogPublishedJob(makeJob(), { prisma, log, sendEmail })
    expect(mocks.subscriberFindMany).not.toHaveBeenCalled()
    expect(log.warn).toHaveBeenCalled()
  })

  it('returns early when no verified subscribers', async () => {
    const { prisma, log, sendEmail, mocks } = makeDeps({
      findMany: jest.fn().mockResolvedValue([]),
    })
    await processChangelogPublishedJob(makeJob(), { prisma, log, sendEmail })
    expect(mocks.sendEmail).not.toHaveBeenCalled()
  })

  it('skips already-notified subscribers', async () => {
    const { prisma, log, sendEmail, mocks } = makeDeps({
      findMany: jest.fn().mockResolvedValue([
        { id: 'sub-1', email: 'a@example.com' },
        { id: 'sub-2', email: 'b@example.com' },
      ]),
      notificationLogFindMany: jest.fn().mockResolvedValue([
        { subscriberId: 'sub-1' },
        { subscriberId: 'sub-2' },
      ]),
    })
    await processChangelogPublishedJob(makeJob(), { prisma, log, sendEmail })
    expect(mocks.sendEmail).not.toHaveBeenCalled()
    expect(log.info).toHaveBeenCalledWith(expect.objectContaining({ entryId: 'entry-uuid-1' }), expect.stringContaining('already notified'))
  })

  it('sends email only to unnotified subscribers', async () => {
    const { prisma, log, sendEmail, mocks } = makeDeps({
      findMany: jest.fn().mockResolvedValue([
        { id: 'sub-1', email: 'a@example.com' },
        { id: 'sub-2', email: 'b@example.com' },
      ]),
      notificationLogFindMany: jest.fn().mockResolvedValue([
        { subscriberId: 'sub-1' },
      ]),
    })
    await processChangelogPublishedJob(makeJob(), { prisma, log, sendEmail })
    expect(mocks.sendEmail).toHaveBeenCalledTimes(1)
    expect(mocks.sendEmail).toHaveBeenCalledWith(expect.objectContaining({ to: 'b@example.com' }))
  })

  it('creates notification log row on successful send', async () => {
    const { prisma, log, sendEmail, mocks } = makeDeps()
    await processChangelogPublishedJob(makeJob(), { prisma, log, sendEmail })
    expect(mocks.createLog).toHaveBeenCalledTimes(1)
    expect(mocks.createLog).toHaveBeenCalledWith({
      data: {
        subscriberId: 'sub-1',
        changelogEntryId: 'entry-uuid-1',
        type: 'changelog_published',
        referenceId: 'entry-uuid-1',
      },
    })
  })

  it('does not create log row when email send fails, continues to next subscriber', async () => {
    const { prisma, log, sendEmail, mocks } = makeDeps({
      findMany: jest.fn().mockResolvedValue([
        { id: 'sub-1', email: 'a@example.com' },
        { id: 'sub-2', email: 'b@example.com' },
      ]),
      sendEmail: jest.fn()
        .mockResolvedValueOnce({ ok: false, error: 'Bounced' })
        .mockResolvedValueOnce({ ok: true }),
    })
    await processChangelogPublishedJob(makeJob(), { prisma, log, sendEmail })

    // Only one log row — for the successful send
    expect(mocks.createLog).toHaveBeenCalledTimes(1)
    expect(mocks.createLog).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ subscriberId: 'sub-2' }),
    }))
    expect(log.warn).toHaveBeenCalled()
  })

  it('logs batch summary with correct counts', async () => {
    const { prisma, log, sendEmail } = makeDeps({
      findMany: jest.fn().mockResolvedValue([
        { id: 'sub-1', email: 'a@example.com' },
        { id: 'sub-2', email: 'b@example.com' },
      ]),
      sendEmail: jest.fn()
        .mockResolvedValueOnce({ ok: true })
        .mockResolvedValueOnce({ ok: false, error: 'Failed' }),
    })
    await processChangelogPublishedJob(makeJob(), { prisma, log, sendEmail })
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ total: 2, sent: 1 }),
      expect.stringContaining('batch complete'),
    )
  })

  it('logs error when notificationLog.create rejects after email sent (Issue 6 — duplicate risk)', async () => {
    const { prisma, log, sendEmail } = makeDeps({
      createLog: jest.fn().mockRejectedValue(new Error('DB deadlock')),
    })
    await processChangelogPublishedJob(makeJob(), { prisma, log, sendEmail })
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      expect.stringContaining('duplicate risk'),
    )
  })

  it('builds changelog URL using FRONTEND_URL and project slug', async () => {
    // env is resolved at import time — verify the URL shape using the default value
    const { prisma, log, sendEmail, mocks } = makeDeps({
      findFirst: jest.fn().mockResolvedValue({
        title: 'Entry',
        project: { slug: 'my-project' },
      }),
    })
    await processChangelogPublishedJob(makeJob(), { prisma, log, sendEmail })

    expect(mocks.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ changelogUrl: expect.stringContaining('/p/my-project/changelog') }),
    )
  })
})

describe('handleWorkerFailedEvent', () => {
  function makeLog() {
    return {
      warn: jest.fn(),
      info: jest.fn(),
      error: jest.fn(),
    } as unknown as Parameters<typeof handleWorkerFailedEvent>[2]
  }

  it('logs error when all retries exhausted', () => {
    const log = makeLog()
    handleWorkerFailedEvent(
      { id: 'job-1', attemptsMade: 3, opts: { attempts: 3 } },
      new Error('permanent failure'),
      log,
    )
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: 'job-1' }),
      expect.stringContaining('exhausted all retries'),
    )
    expect(log.warn).not.toHaveBeenCalled()
  })

  it('logs warn (not error) on intermediate failed attempt', () => {
    const log = makeLog()
    handleWorkerFailedEvent(
      { id: 'job-1', attemptsMade: 1, opts: { attempts: 3 } },
      new Error('transient'),
      log,
    )
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: 'job-1', attemptsMade: 1 }),
      expect.stringContaining('will retry'),
    )
    expect(log.error).not.toHaveBeenCalled()
  })

  it('handles undefined job gracefully', () => {
    const log = makeLog()
    expect(() => handleWorkerFailedEvent(undefined, new Error('crash'), log)).not.toThrow()
    expect(log.warn).toHaveBeenCalled()
  })
})
