import { processChangelogPublishedJob, processFeatureShippedJob, processVoteVerificationJob, handleWorkerFailedEvent } from '../workers/notificationWorker'
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

type ShippedSendFn = (opts: { to: string; itemTitle: string; roadmapUrl: string }) => Promise<SendResult>

function makeShippedJob(overrides: Partial<NotificationJobData> = {}): NotificationJobData {
  return {
    type: 'feature_shipped',
    referenceId: 'item-uuid-1',
    projectId: 'project-uuid-1',
    ...overrides,
  }
}

function makeShippedDeps(overrides: {
  findFirst?: jest.Mock
  findMany?: jest.Mock
  notificationLogFindMany?: jest.Mock
  createLog?: jest.Mock
  sendEmail?: jest.Mock
} = {}) {
  const findFirst = overrides.findFirst ?? jest.fn().mockResolvedValue({
    title: 'Dark mode',
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
    roadmapItem: { findFirst },
    subscriber: { findMany: subscriberFindMany },
    notificationLog: {
      findMany: notificationLogFindMany,
      create: createLog,
    },
  } as unknown as Parameters<typeof processFeatureShippedJob>[1]['prisma']

  const log = {
    warn: jest.fn(),
    info: jest.fn(),
    error: jest.fn(),
  } as unknown as Parameters<typeof processFeatureShippedJob>[1]['log']

  return { prisma, log, sendEmail: sendEmail as ShippedSendFn, mocks: { findFirst, subscriberFindMany, notificationLogFindMany, createLog, sendEmail } }
}

describe('processFeatureShippedJob', () => {
  it('returns early for non-feature_shipped type', async () => {
    const { prisma, log, sendEmail, mocks } = makeShippedDeps()
    await processFeatureShippedJob(makeShippedJob({ type: 'changelog_published' }), { prisma, log, sendEmail })
    expect(mocks.findFirst).not.toHaveBeenCalled()
    expect(mocks.subscriberFindMany).not.toHaveBeenCalled()
  })

  it('returns early + warns when roadmap item not found or no longer shipped', async () => {
    const { prisma, log, sendEmail, mocks } = makeShippedDeps({
      findFirst: jest.fn().mockResolvedValue(null),
    })
    await processFeatureShippedJob(makeShippedJob(), { prisma, log, sendEmail })
    expect(mocks.subscriberFindMany).not.toHaveBeenCalled()
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ itemId: 'item-uuid-1' }),
      expect.stringContaining('no longer shipped'),
    )
  })

  it('returns early when no verified subscribers', async () => {
    const { prisma, log, sendEmail, mocks } = makeShippedDeps({
      findMany: jest.fn().mockResolvedValue([]),
    })
    await processFeatureShippedJob(makeShippedJob(), { prisma, log, sendEmail })
    expect(mocks.sendEmail).not.toHaveBeenCalled()
  })

  it('skips already-notified subscribers', async () => {
    const { prisma, log, sendEmail, mocks } = makeShippedDeps({
      findMany: jest.fn().mockResolvedValue([
        { id: 'sub-1', email: 'a@example.com' },
        { id: 'sub-2', email: 'b@example.com' },
      ]),
      notificationLogFindMany: jest.fn().mockResolvedValue([
        { subscriberId: 'sub-1' },
        { subscriberId: 'sub-2' },
      ]),
    })
    await processFeatureShippedJob(makeShippedJob(), { prisma, log, sendEmail })
    expect(mocks.sendEmail).not.toHaveBeenCalled()
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ itemId: 'item-uuid-1' }),
      expect.stringContaining('already notified'),
    )
  })

  it('sends only to unnotified subscribers', async () => {
    const { prisma, log, sendEmail, mocks } = makeShippedDeps({
      findMany: jest.fn().mockResolvedValue([
        { id: 'sub-1', email: 'a@example.com' },
        { id: 'sub-2', email: 'b@example.com' },
      ]),
      notificationLogFindMany: jest.fn().mockResolvedValue([
        { subscriberId: 'sub-1' },
      ]),
    })
    await processFeatureShippedJob(makeShippedJob(), { prisma, log, sendEmail })
    expect(mocks.sendEmail).toHaveBeenCalledTimes(1)
    expect(mocks.sendEmail).toHaveBeenCalledWith(expect.objectContaining({ to: 'b@example.com' }))
  })

  it('creates notification log row on successful send', async () => {
    const { prisma, log, sendEmail, mocks } = makeShippedDeps()
    await processFeatureShippedJob(makeShippedJob(), { prisma, log, sendEmail })
    expect(mocks.createLog).toHaveBeenCalledTimes(1)
    expect(mocks.createLog).toHaveBeenCalledWith({
      data: {
        subscriberId: 'sub-1',
        type: 'feature_shipped',
        referenceId: 'item-uuid-1',
      },
    })
  })

  it('does not create log row when send fails, continues to next subscriber', async () => {
    const { prisma, log, sendEmail, mocks } = makeShippedDeps({
      findMany: jest.fn().mockResolvedValue([
        { id: 'sub-1', email: 'a@example.com' },
        { id: 'sub-2', email: 'b@example.com' },
      ]),
      sendEmail: jest.fn()
        .mockResolvedValueOnce({ ok: false, error: 'Bounced' })
        .mockResolvedValueOnce({ ok: true }),
    })
    await processFeatureShippedJob(makeShippedJob(), { prisma, log, sendEmail })
    expect(mocks.createLog).toHaveBeenCalledTimes(1)
    expect(mocks.createLog).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ subscriberId: 'sub-2' }),
    }))
    expect(log.warn).toHaveBeenCalled()
  })

  it('logs error when notificationLog.create rejects after email sent (duplicate risk)', async () => {
    const { prisma, log, sendEmail } = makeShippedDeps({
      createLog: jest.fn().mockRejectedValue(new Error('DB deadlock')),
    })
    await processFeatureShippedJob(makeShippedJob(), { prisma, log, sendEmail })
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      expect.stringContaining('duplicate risk'),
    )
  })

  it('builds roadmap URL using FRONTEND_URL and project slug', async () => {
    const { prisma, log, sendEmail, mocks } = makeShippedDeps({
      findFirst: jest.fn().mockResolvedValue({
        title: 'Dark mode',
        project: { slug: 'my-project' },
      }),
    })
    await processFeatureShippedJob(makeShippedJob(), { prisma, log, sendEmail })
    expect(mocks.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ roadmapUrl: expect.stringContaining('/p/my-project/roadmap') }),
    )
  })

  it('logs batch summary with correct counts', async () => {
    const { prisma, log, sendEmail } = makeShippedDeps({
      findMany: jest.fn().mockResolvedValue([
        { id: 'sub-1', email: 'a@example.com' },
        { id: 'sub-2', email: 'b@example.com' },
      ]),
      sendEmail: jest.fn()
        .mockResolvedValueOnce({ ok: true })
        .mockResolvedValueOnce({ ok: false, error: 'Failed' }),
    })
    await processFeatureShippedJob(makeShippedJob(), { prisma, log, sendEmail })
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ total: 2, sent: 1 }),
      expect.stringContaining('batch complete'),
    )
  })
})

type VoteVerifySendFn = (opts: { to: string; featureTitle: string; verifyUrl: string }) => Promise<SendResult>

function makeVoteJob(overrides: Partial<NotificationJobData> = {}): NotificationJobData {
  return {
    type: 'vote_verification',
    referenceId: 'vote-uuid-1',
    projectId: 'project-uuid-1',
    ...overrides,
  }
}

function makeVoteDeps(overrides: {
  voteFindFirst?: jest.Mock
  logFindFirst?: jest.Mock
  logCreate?: jest.Mock
  sendEmail?: jest.Mock
} = {}) {
  const voteFindFirst = overrides.voteFindFirst ?? jest.fn().mockResolvedValue({
    verified: false,
    voterEmail: 'voter@example.com',
    verificationToken: 'token-abc-123',
    featureRequest: { title: 'Dark mode' },
  })

  const logFindFirst = overrides.logFindFirst ?? jest.fn().mockResolvedValue(null)
  const logCreate = overrides.logCreate ?? jest.fn().mockResolvedValue({})

  const sendEmail: jest.Mock<Promise<SendResult>> =
    overrides.sendEmail ?? jest.fn().mockResolvedValue({ ok: true })

  const prisma = {
    vote: { findFirst: voteFindFirst },
    notificationLog: { findFirst: logFindFirst, create: logCreate },
  } as unknown as Parameters<typeof processVoteVerificationJob>[1]['prisma']

  const log = {
    warn: jest.fn(),
    info: jest.fn(),
    error: jest.fn(),
  } as unknown as Parameters<typeof processVoteVerificationJob>[1]['log']

  return { prisma, log, sendEmail: sendEmail as VoteVerifySendFn, mocks: { voteFindFirst, logFindFirst, logCreate, sendEmail } }
}

describe('processVoteVerificationJob', () => {
  it('returns early for non-vote_verification type', async () => {
    const { prisma, log, sendEmail, mocks } = makeVoteDeps()
    await processVoteVerificationJob(makeVoteJob({ type: 'changelog_published' }), { prisma, log, sendEmail })
    expect(mocks.voteFindFirst).not.toHaveBeenCalled()
  })

  it('returns early + warns when vote not found', async () => {
    const { prisma, log, sendEmail, mocks } = makeVoteDeps({
      voteFindFirst: jest.fn().mockResolvedValue(null),
    })
    await processVoteVerificationJob(makeVoteJob(), { prisma, log, sendEmail })
    expect(mocks.sendEmail).not.toHaveBeenCalled()
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ voteId: 'vote-uuid-1' }),
      expect.stringContaining('not found'),
    )
  })

  it('returns early + logs info when vote already verified', async () => {
    const { prisma, log, sendEmail, mocks } = makeVoteDeps({
      voteFindFirst: jest.fn().mockResolvedValue({
        verified: true,
        voterEmail: 'voter@example.com',
        verificationToken: 'token-abc-123',
        featureRequest: { title: 'Dark mode' },
      }),
    })
    await processVoteVerificationJob(makeVoteJob(), { prisma, log, sendEmail })
    expect(mocks.sendEmail).not.toHaveBeenCalled()
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ voteId: 'vote-uuid-1' }),
      expect.stringContaining('already verified'),
    )
  })

  it('skips send when notificationLog entry already exists (dedup on retry)', async () => {
    const { prisma, log, sendEmail, mocks } = makeVoteDeps({
      logFindFirst: jest.fn().mockResolvedValue({ id: 'log-uuid-1' }),
    })
    await processVoteVerificationJob(makeVoteJob(), { prisma, log, sendEmail })
    expect(mocks.sendEmail).not.toHaveBeenCalled()
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ voteId: 'vote-uuid-1' }),
      expect.stringContaining('already sent'),
    )
  })

  it('sends email with correct to, featureTitle, and verifyUrl containing base URL', async () => {
    const { prisma, log, sendEmail, mocks } = makeVoteDeps()
    await processVoteVerificationJob(makeVoteJob(), { prisma, log, sendEmail })
    expect(mocks.sendEmail).toHaveBeenCalledTimes(1)
    const call = mocks.sendEmail.mock.calls[0][0] as { to: string; featureTitle: string; verifyUrl: string }
    expect(call.to).toBe('voter@example.com')
    expect(call.featureTitle).toBe('Dark mode')
    // verifyUrl must be an absolute URL containing the path and token
    expect(() => new URL(call.verifyUrl)).not.toThrow()
    expect(call.verifyUrl).toContain('/verify/vote')
    expect(call.verifyUrl).toContain('token=token-abc-123')
  })

  it('creates notificationLog row after successful send', async () => {
    const { prisma, log, sendEmail, mocks } = makeVoteDeps()
    await processVoteVerificationJob(makeVoteJob(), { prisma, log, sendEmail })
    expect(mocks.logCreate).toHaveBeenCalledWith({
      data: { type: 'vote_verification', referenceId: 'vote-uuid-1' },
    })
  })

  it('logs error when notificationLog.create fails after email sent (duplicate risk)', async () => {
    const { prisma, log, sendEmail } = makeVoteDeps({
      logCreate: jest.fn().mockRejectedValue(new Error('DB deadlock')),
    })
    await processVoteVerificationJob(makeVoteJob(), { prisma, log, sendEmail })
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      expect.stringContaining('duplicate risk'),
    )
  })

  it('throws when email send fails so BullMQ retries', async () => {
    const { prisma, log, sendEmail } = makeVoteDeps({
      sendEmail: jest.fn().mockResolvedValue({ ok: false, error: 'SMTP timeout' }),
    })
    await expect(
      processVoteVerificationJob(makeVoteJob(), { prisma, log, sendEmail }),
    ).rejects.toThrow('vote verification email failed')
  })
})
