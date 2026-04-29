import { processChangelogPublishedJob, processFeatureShippedJob, processFeatureStatusChangedJob, processVoteVerificationJob, processSubscribeVerificationJob, handleWorkerFailedEvent, dispatchEmailNotificationJob, extractExcerpt } from '../workers/notificationWorker'
import { EmailNotificationJobData, VoteVerificationJobData, SubscriptionVerificationJobData } from '../jobs/index'
import { SendResult } from '../services/emailService'

type SendFn = (opts: { to: string; entryTitle: string; version?: string | null; excerpt?: string; changelogUrl: string; unsubscribeUrl: string }) => Promise<SendResult>

function makeJob(overrides: Partial<Extract<EmailNotificationJobData, { type: 'changelog_published' }>> = {}): EmailNotificationJobData {
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
    version: 'v2.1',
    content: {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'This is the entry body.' }] },
      ],
    },
    project: { slug: 'acme' },
  })

  const subscriberFindMany = overrides.findMany ?? jest.fn().mockResolvedValue([
    { id: 'sub-1', email: 'a@example.com', verificationToken: 'tok-sub-1' },
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
    await processChangelogPublishedJob(makeJob({ type: 'vote_verification' as never }), { prisma, log, sendEmail })
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

  it('does not create log row when email send fails, continues to next subscriber, then throws for retry', async () => {
    const { prisma, log, sendEmail, mocks } = makeDeps({
      findMany: jest.fn().mockResolvedValue([
        { id: 'sub-1', email: 'a@example.com' },
        { id: 'sub-2', email: 'b@example.com' },
      ]),
      sendEmail: jest.fn()
        .mockResolvedValueOnce({ ok: false, error: 'Bounced' })
        .mockResolvedValueOnce({ ok: true }),
    })
    await expect(processChangelogPublishedJob(makeJob(), { prisma, log, sendEmail })).rejects.toThrow('email sends failed')

    // Only one log row — for the successful send
    expect(mocks.createLog).toHaveBeenCalledTimes(1)
    expect(mocks.createLog).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ subscriberId: 'sub-2' }),
    }))
    expect(log.warn).toHaveBeenCalled()
  })

  it('logs batch summary with correct counts, then throws when any send failed', async () => {
    const { prisma, log, sendEmail } = makeDeps({
      findMany: jest.fn().mockResolvedValue([
        { id: 'sub-1', email: 'a@example.com' },
        { id: 'sub-2', email: 'b@example.com' },
      ]),
      sendEmail: jest.fn()
        .mockResolvedValueOnce({ ok: true })
        .mockResolvedValueOnce({ ok: false, error: 'Failed' }),
    })
    await expect(processChangelogPublishedJob(makeJob(), { prisma, log, sendEmail })).rejects.toThrow('email sends failed')
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
        version: null,
        content: { type: 'doc', content: [] },
        project: { slug: 'my-project' },
      }),
    })
    await processChangelogPublishedJob(makeJob(), { prisma, log, sendEmail })

    expect(mocks.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ changelogUrl: expect.stringContaining('/p/my-project/changelog') }),
    )
  })

  it('includes per-subscriber unsubscribeUrl containing verificationToken', async () => {
    const { prisma, log, sendEmail, mocks } = makeDeps()
    await processChangelogPublishedJob(makeJob(), { prisma, log, sendEmail })

    expect(mocks.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        unsubscribeUrl: expect.stringContaining('tok-sub-1'),
      }),
    )
    const call = mocks.sendEmail.mock.calls[0][0] as { unsubscribeUrl: string }
    expect(() => new URL(call.unsubscribeUrl)).not.toThrow()
  })

  it('passes version and excerpt to sendEmail', async () => {
    const { prisma, log, sendEmail, mocks } = makeDeps()
    await processChangelogPublishedJob(makeJob(), { prisma, log, sendEmail })
    expect(mocks.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        version: 'v2.1',
        excerpt: 'This is the entry body.',
      }),
    )
  })

  it('passes null version when entry has no version', async () => {
    const { prisma, log, sendEmail, mocks } = makeDeps({
      findFirst: jest.fn().mockResolvedValue({
        title: 'No Version Entry',
        version: null,
        content: { type: 'doc', content: [] },
        project: { slug: 'acme' },
      }),
    })
    await processChangelogPublishedJob(makeJob(), { prisma, log, sendEmail })
    expect(mocks.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ version: null }),
    )
  })
})

describe('extractExcerpt', () => {
  it('extracts text from a simple paragraph', () => {
    const content = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Hello world' }] },
      ],
    }
    expect(extractExcerpt(content)).toBe('Hello world')
  })

  it('joins text from multiple nodes with spaces', () => {
    const content = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'First.' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'Second.' }] },
      ],
    }
    expect(extractExcerpt(content)).toBe('First. Second.')
  })

  it('truncates to maxLen and appends ellipsis', () => {
    const longText = 'a'.repeat(250)
    const content = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: longText }] }],
    }
    const result = extractExcerpt(content, 200)
    expect(result.endsWith('…')).toBe(true)
    expect(result.length).toBeLessThanOrEqual(201)
  })

  it('returns empty string for null input', () => {
    expect(extractExcerpt(null)).toBe('')
  })

  it('returns empty string for empty doc', () => {
    expect(extractExcerpt({ type: 'doc', content: [] })).toBe('')
  })

  it('handles malformed input without throwing', () => {
    expect(() => extractExcerpt({ not: 'valid' })).not.toThrow()
    expect(() => extractExcerpt(42)).not.toThrow()
    expect(() => extractExcerpt(undefined)).not.toThrow()
  })

  it('collapses CRLF within text nodes into a single space', () => {
    const content = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'line1\r\nline2' }] }],
    }
    expect(extractExcerpt(content)).toBe('line1 line2')
  })

  it('returns HTML-special chars verbatim (escaping is emailService responsibility)', () => {
    const content = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a < b & c' }] }],
    }
    expect(extractExcerpt(content)).toBe('a < b & c')
  })

  it('handles non-array content property on a node without throwing', () => {
    expect(() => extractExcerpt({ type: 'doc', content: null })).not.toThrow()
    expect(() => extractExcerpt({ type: 'doc', content: 'string' })).not.toThrow()
    expect(extractExcerpt({ type: 'doc', content: null })).toBe('')
  })

  it('separates adjacent block-level items with a space', () => {
    const content = {
      type: 'doc',
      content: [
        {
          type: 'bulletList',
          content: [
            { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Feature A' }] }] },
            { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Feature B' }] }] },
          ],
        },
      ],
    }
    const result = extractExcerpt(content)
    expect(result).toContain('Feature A')
    expect(result).toContain('Feature B')
    // items must not be concatenated without any separator
    expect(result).not.toContain('Feature AFeature B')
  })

  it('truncation is Unicode-safe — does not split surrogate pairs', () => {
    // Each emoji is 2 UTF-16 code units but 1 code point. Place one at position 200.
    const prefix = 'a'.repeat(199)
    const content = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: prefix + '🚀 more text' }] }],
    }
    const result = extractExcerpt(content, 200)
    // Result must be valid — every char in [...result] must be a complete code point
    expect(() => JSON.stringify(result)).not.toThrow()
    expect(result.endsWith('…')).toBe(true)
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

type ShippedSendFn = (opts: { to: string; itemTitle: string; roadmapUrl: string; unsubscribeUrl: string }) => Promise<SendResult>

function makeShippedJob(overrides: Partial<Extract<EmailNotificationJobData, { type: 'feature_shipped' }>> = {}): EmailNotificationJobData {
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
    { id: 'sub-1', email: 'a@example.com', verificationToken: 'tok-sub-1' },
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
    await processFeatureShippedJob(makeShippedJob({ type: 'changelog_published' as never }), { prisma, log, sendEmail })
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

  it('does not create log row when send fails, continues to next subscriber, then throws for retry', async () => {
    const { prisma, log, sendEmail, mocks } = makeShippedDeps({
      findMany: jest.fn().mockResolvedValue([
        { id: 'sub-1', email: 'a@example.com' },
        { id: 'sub-2', email: 'b@example.com' },
      ]),
      sendEmail: jest.fn()
        .mockResolvedValueOnce({ ok: false, error: 'Bounced' })
        .mockResolvedValueOnce({ ok: true }),
    })
    await expect(processFeatureShippedJob(makeShippedJob(), { prisma, log, sendEmail })).rejects.toThrow('email sends failed')
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

  it('includes per-subscriber unsubscribeUrl containing verificationToken', async () => {
    const { prisma, log, sendEmail, mocks } = makeShippedDeps()
    await processFeatureShippedJob(makeShippedJob(), { prisma, log, sendEmail })

    expect(mocks.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        unsubscribeUrl: expect.stringContaining('tok-sub-1'),
      }),
    )
    const call = mocks.sendEmail.mock.calls[0][0] as { unsubscribeUrl: string }
    expect(() => new URL(call.unsubscribeUrl)).not.toThrow()
  })

  it('logs batch summary with correct counts, then throws when any send failed', async () => {
    const { prisma, log, sendEmail } = makeShippedDeps({
      findMany: jest.fn().mockResolvedValue([
        { id: 'sub-1', email: 'a@example.com' },
        { id: 'sub-2', email: 'b@example.com' },
      ]),
      sendEmail: jest.fn()
        .mockResolvedValueOnce({ ok: true })
        .mockResolvedValueOnce({ ok: false, error: 'Failed' }),
    })
    await expect(processFeatureShippedJob(makeShippedJob(), { prisma, log, sendEmail })).rejects.toThrow('email sends failed')
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ total: 2, sent: 1 }),
      expect.stringContaining('batch complete'),
    )
  })
})

type VoteVerifySendFn = (opts: { to: string; featureTitle: string; verifyUrl: string }) => Promise<SendResult>

function makeVoteJob(overrides: Partial<VoteVerificationJobData> = {}): VoteVerificationJobData {
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
    await processVoteVerificationJob(makeVoteJob({ type: 'changelog_published' as never }), { prisma, log, sendEmail })
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

type SubVerifySendFn = (opts: { to: string; projectName: string; verifyUrl: string; unsubscribeUrl: string }) => Promise<SendResult>

function makeSubVerifyJob(overrides: Partial<SubscriptionVerificationJobData> = {}): SubscriptionVerificationJobData {
  return {
    type: 'subscribe_verification',
    referenceId: 'sub-uuid-1',
    projectId: 'project-uuid-1',
    ...overrides,
  }
}

function makeSubVerifyDeps(overrides: {
  subscriberFindFirst?: jest.Mock
  logFindFirst?: jest.Mock
  logCreate?: jest.Mock
  sendEmail?: jest.Mock
} = {}) {
  const subscriberFindFirst = overrides.subscriberFindFirst ?? jest.fn().mockResolvedValue({
    verified: false,
    email: 'subscriber@example.com',
    verificationToken: 'sub-token-abc',
    project: { name: 'Acme App' },
  })

  const logFindFirst = overrides.logFindFirst ?? jest.fn().mockResolvedValue(null)
  const logCreate = overrides.logCreate ?? jest.fn().mockResolvedValue({})

  const sendEmail: jest.Mock<Promise<SendResult>> =
    overrides.sendEmail ?? jest.fn().mockResolvedValue({ ok: true })

  const prisma = {
    subscriber: { findFirst: subscriberFindFirst },
    notificationLog: { findFirst: logFindFirst, create: logCreate },
  } as unknown as Parameters<typeof processSubscribeVerificationJob>[1]['prisma']

  const log = {
    warn: jest.fn(),
    info: jest.fn(),
    error: jest.fn(),
  } as unknown as Parameters<typeof processSubscribeVerificationJob>[1]['log']

  return { prisma, log, sendEmail: sendEmail as SubVerifySendFn, mocks: { subscriberFindFirst, logFindFirst, logCreate, sendEmail } }
}

describe('processSubscribeVerificationJob', () => {
  it('returns early for non-subscribe_verification type', async () => {
    const { prisma, log, sendEmail, mocks } = makeSubVerifyDeps()
    await processSubscribeVerificationJob(makeSubVerifyJob({ type: 'changelog_published' as never }), { prisma, log, sendEmail })
    expect(mocks.subscriberFindFirst).not.toHaveBeenCalled()
  })

  it('returns early + warns when subscriber not found', async () => {
    const { prisma, log, sendEmail, mocks } = makeSubVerifyDeps({
      subscriberFindFirst: jest.fn().mockResolvedValue(null),
    })
    await processSubscribeVerificationJob(makeSubVerifyJob(), { prisma, log, sendEmail })
    expect(mocks.sendEmail).not.toHaveBeenCalled()
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ subscriberId: 'sub-uuid-1' }),
      expect.stringContaining('not found'),
    )
  })

  it('returns early + logs info when subscriber already verified', async () => {
    const { prisma, log, sendEmail, mocks } = makeSubVerifyDeps({
      subscriberFindFirst: jest.fn().mockResolvedValue({
        verified: true,
        email: 'subscriber@example.com',
        verificationToken: 'sub-token-abc',
        project: { name: 'Acme App' },
      }),
    })
    await processSubscribeVerificationJob(makeSubVerifyJob(), { prisma, log, sendEmail })
    expect(mocks.sendEmail).not.toHaveBeenCalled()
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ subscriberId: 'sub-uuid-1' }),
      expect.stringContaining('already verified'),
    )
  })

  it('skips send when notificationLog entry already exists (dedup on retry)', async () => {
    const { prisma, log, sendEmail, mocks } = makeSubVerifyDeps({
      logFindFirst: jest.fn().mockResolvedValue({ id: 'log-uuid-1' }),
    })
    await processSubscribeVerificationJob(makeSubVerifyJob(), { prisma, log, sendEmail })
    expect(mocks.sendEmail).not.toHaveBeenCalled()
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ subscriberId: 'sub-uuid-1' }),
      expect.stringContaining('already sent'),
    )
  })

  it('sends email with correct to, projectName, verifyUrl, and unsubscribeUrl', async () => {
    const { prisma, log, sendEmail, mocks } = makeSubVerifyDeps()
    await processSubscribeVerificationJob(makeSubVerifyJob(), { prisma, log, sendEmail })
    expect(mocks.sendEmail).toHaveBeenCalledTimes(1)
    const call = mocks.sendEmail.mock.calls[0][0] as { to: string; projectName: string; verifyUrl: string; unsubscribeUrl: string }
    expect(call.to).toBe('subscriber@example.com')
    expect(call.projectName).toBe('Acme App')
    expect(() => new URL(call.verifyUrl)).not.toThrow()
    expect(call.verifyUrl).toContain('/verify/subscribe')
    expect(call.verifyUrl).toContain('token=sub-token-abc')
    expect(() => new URL(call.unsubscribeUrl)).not.toThrow()
    expect(call.unsubscribeUrl).toContain('/unsubscribe')
    expect(call.unsubscribeUrl).toContain('token=sub-token-abc')
  })

  it('creates notificationLog row after successful send', async () => {
    const { prisma, log, sendEmail, mocks } = makeSubVerifyDeps()
    await processSubscribeVerificationJob(makeSubVerifyJob(), { prisma, log, sendEmail })
    expect(mocks.logCreate).toHaveBeenCalledWith({
      data: { type: 'subscribe_verification', referenceId: 'sub-uuid-1' },
    })
  })

  it('logs error when notificationLog.create fails after email sent (duplicate risk)', async () => {
    const { prisma, log, sendEmail } = makeSubVerifyDeps({
      logCreate: jest.fn().mockRejectedValue(new Error('DB deadlock')),
    })
    await processSubscribeVerificationJob(makeSubVerifyJob(), { prisma, log, sendEmail })
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      expect.stringContaining('duplicate risk'),
    )
  })

  it('throws when email send fails so BullMQ retries', async () => {
    const { prisma, log, sendEmail } = makeSubVerifyDeps({
      sendEmail: jest.fn().mockResolvedValue({ ok: false, error: 'SMTP timeout' }),
    })
    await expect(
      processSubscribeVerificationJob(makeSubVerifyJob(), { prisma, log, sendEmail }),
    ).rejects.toThrow('subscribe verification email failed')
  })
})

describe('processChangelogPublishedJob — batch retry on partial failure', () => {
  it('throws after batch when at least one email send fails so BullMQ retries for missed subscribers', async () => {
    const { prisma, log, sendEmail } = makeDeps({
      findMany: jest.fn().mockResolvedValue([
        { id: 'sub-1', email: 'a@example.com', verificationToken: 'tok-1' },
        { id: 'sub-2', email: 'b@example.com', verificationToken: 'tok-2' },
      ]),
      sendEmail: jest.fn()
        .mockResolvedValueOnce({ ok: true })
        .mockResolvedValueOnce({ ok: false, error: 'Bounced' }),
    })
    await expect(
      processChangelogPublishedJob(makeJob(), { prisma, log, sendEmail }),
    ).rejects.toThrow('email sends failed')
  })

  it('does not throw when all sends succeed', async () => {
    const { prisma, log, sendEmail } = makeDeps({
      findMany: jest.fn().mockResolvedValue([
        { id: 'sub-1', email: 'a@example.com', verificationToken: 'tok-1' },
        { id: 'sub-2', email: 'b@example.com', verificationToken: 'tok-2' },
      ]),
    })
    await expect(
      processChangelogPublishedJob(makeJob(), { prisma, log, sendEmail }),
    ).resolves.toBeUndefined()
  })
})

describe('processFeatureShippedJob — batch retry on partial failure', () => {
  it('throws after batch when at least one email send fails so BullMQ retries for missed subscribers', async () => {
    const { prisma, log, sendEmail } = makeShippedDeps({
      findMany: jest.fn().mockResolvedValue([
        { id: 'sub-1', email: 'a@example.com', verificationToken: 'tok-1' },
        { id: 'sub-2', email: 'b@example.com', verificationToken: 'tok-2' },
      ]),
      sendEmail: jest.fn()
        .mockResolvedValueOnce({ ok: false, error: 'Bounced' })
        .mockResolvedValueOnce({ ok: true }),
    })
    await expect(
      processFeatureShippedJob(makeShippedJob(), { prisma, log, sendEmail }),
    ).rejects.toThrow('email sends failed')
  })

  it('does not throw when all sends succeed', async () => {
    const { prisma, log, sendEmail } = makeShippedDeps({
      findMany: jest.fn().mockResolvedValue([
        { id: 'sub-1', email: 'a@example.com', verificationToken: 'tok-1' },
      ]),
    })
    await expect(
      processFeatureShippedJob(makeShippedJob(), { prisma, log, sendEmail }),
    ).resolves.toBeUndefined()
  })
})

type StatusChangedSendFn = (opts: { to: string; featureTitle: string; newStatus: string; featuresUrl: string }) => Promise<SendResult>

function makeStatusChangedJob(overrides: Partial<Extract<EmailNotificationJobData, { type: 'feature_status_changed' }>> = {}): EmailNotificationJobData {
  return {
    type: 'feature_status_changed',
    referenceId: 'feature-uuid-1',
    projectId: 'project-uuid-1',
    newStatus: 'planned',
    ...overrides,
  }
}

function makeStatusChangedDeps(overrides: {
  featureFindFirst?: jest.Mock
  voteFindMany?: jest.Mock
  notificationLogFindMany?: jest.Mock
  createLog?: jest.Mock
  sendEmail?: jest.Mock
} = {}) {
  const featureFindFirst = overrides.featureFindFirst ?? jest.fn().mockResolvedValue({
    title: 'Dark mode',
    status: 'planned',
    project: { slug: 'acme' },
  })

  const voteFindMany = overrides.voteFindMany ?? jest.fn().mockResolvedValue([
    { id: 'vote-1', voterEmail: 'voter@example.com' },
  ])

  const notificationLogFindMany = overrides.notificationLogFindMany ?? jest.fn().mockResolvedValue([])

  const createLog = overrides.createLog ?? jest.fn().mockResolvedValue({})

  const sendEmail: jest.Mock<Promise<SendResult>> =
    overrides.sendEmail ?? jest.fn().mockResolvedValue({ ok: true })

  const prisma = {
    featureRequest: { findFirst: featureFindFirst },
    vote: { findMany: voteFindMany },
    notificationLog: {
      findMany: notificationLogFindMany,
      create: createLog,
    },
  } as unknown as Parameters<typeof processFeatureStatusChangedJob>[1]['prisma']

  const log = {
    warn: jest.fn(),
    info: jest.fn(),
    error: jest.fn(),
  } as unknown as Parameters<typeof processFeatureStatusChangedJob>[1]['log']

  return { prisma, log, sendEmail: sendEmail as StatusChangedSendFn, mocks: { featureFindFirst, voteFindMany, notificationLogFindMany, createLog, sendEmail } }
}

describe('processFeatureStatusChangedJob', () => {
  it('returns early for non-feature_status_changed type', async () => {
    const { prisma, log, sendEmail, mocks } = makeStatusChangedDeps()
    await processFeatureStatusChangedJob(makeStatusChangedJob({ type: 'changelog_published' as never }), { prisma, log, sendEmail })
    expect(mocks.featureFindFirst).not.toHaveBeenCalled()
  })

  it('returns early + warns when feature request not found', async () => {
    const { prisma, log, sendEmail, mocks } = makeStatusChangedDeps({
      featureFindFirst: jest.fn().mockResolvedValue(null),
    })
    await processFeatureStatusChangedJob(makeStatusChangedJob(), { prisma, log, sendEmail })
    expect(mocks.voteFindMany).not.toHaveBeenCalled()
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ featureId: 'feature-uuid-1' }),
      expect.stringContaining('not found'),
    )
  })

  it('returns early when no verified voters', async () => {
    const { prisma, log, sendEmail, mocks } = makeStatusChangedDeps({
      voteFindMany: jest.fn().mockResolvedValue([]),
    })
    await processFeatureStatusChangedJob(makeStatusChangedJob(), { prisma, log, sendEmail })
    expect(mocks.sendEmail).not.toHaveBeenCalled()
  })

  it('skips already-notified voters using voteId:newStatus dedup key', async () => {
    const { prisma, log, sendEmail, mocks } = makeStatusChangedDeps({
      voteFindMany: jest.fn().mockResolvedValue([
        { id: 'vote-1', voterEmail: 'a@example.com' },
        { id: 'vote-2', voterEmail: 'b@example.com' },
      ]),
      notificationLogFindMany: jest.fn().mockResolvedValue([
        { referenceId: 'vote-1:planned' },
        { referenceId: 'vote-2:planned' },
      ]),
    })
    await processFeatureStatusChangedJob(makeStatusChangedJob(), { prisma, log, sendEmail })
    expect(mocks.sendEmail).not.toHaveBeenCalled()
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ featureId: 'feature-uuid-1', newStatus: 'planned' }),
      expect.stringContaining('already notified'),
    )
  })

  it('sends only to unnotified voters', async () => {
    const { prisma, log, sendEmail, mocks } = makeStatusChangedDeps({
      voteFindMany: jest.fn().mockResolvedValue([
        { id: 'vote-1', voterEmail: 'a@example.com' },
        { id: 'vote-2', voterEmail: 'b@example.com' },
      ]),
      notificationLogFindMany: jest.fn().mockResolvedValue([
        { referenceId: 'vote-1:planned' },
      ]),
    })
    await processFeatureStatusChangedJob(makeStatusChangedJob(), { prisma, log, sendEmail })
    expect(mocks.sendEmail).toHaveBeenCalledTimes(1)
    expect(mocks.sendEmail).toHaveBeenCalledWith(expect.objectContaining({ to: 'b@example.com' }))
  })

  it('creates notification log with voteId:newStatus referenceId and type status_changed', async () => {
    const { prisma, log, sendEmail, mocks } = makeStatusChangedDeps()
    await processFeatureStatusChangedJob(makeStatusChangedJob(), { prisma, log, sendEmail })
    expect(mocks.createLog).toHaveBeenCalledWith({
      data: { type: 'status_changed', referenceId: 'vote-1:planned' },
    })
  })

  it('maps newStatus to human-readable label in email', async () => {
    const { prisma, log, sendEmail, mocks } = makeStatusChangedDeps({
      featureFindFirst: jest.fn().mockResolvedValue({
        title: 'Dark mode',
        status: 'in_progress',
        project: { slug: 'acme' },
      }),
    })
    await processFeatureStatusChangedJob(makeStatusChangedJob({ newStatus: 'in_progress' }), { prisma, log, sendEmail })
    expect(mocks.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ newStatus: 'In Progress' }),
    )
  })

  it('builds features URL using FRONTEND_URL and project slug', async () => {
    const { prisma, log, sendEmail, mocks } = makeStatusChangedDeps({
      featureFindFirst: jest.fn().mockResolvedValue({
        title: 'Dark mode',
        status: 'planned',
        project: { slug: 'my-project' },
      }),
    })
    await processFeatureStatusChangedJob(makeStatusChangedJob(), { prisma, log, sendEmail })
    expect(mocks.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ featuresUrl: expect.stringContaining('/p/my-project/features') }),
    )
    const call = mocks.sendEmail.mock.calls[0][0] as { featuresUrl: string }
    expect(() => new URL(call.featuresUrl)).not.toThrow()
  })

  it('returns early when current status no longer matches job status (stale job)', async () => {
    const { prisma, log, sendEmail, mocks } = makeStatusChangedDeps({
      featureFindFirst: jest.fn().mockResolvedValue({
        title: 'Dark mode',
        status: 'in_progress',
        project: { slug: 'acme' },
      }),
    })
    // job says 'planned' but DB now shows 'in_progress'
    await processFeatureStatusChangedJob(makeStatusChangedJob({ newStatus: 'planned' }), { prisma, log, sendEmail })
    expect(mocks.sendEmail).not.toHaveBeenCalled()
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ jobStatus: 'planned', currentStatus: 'in_progress' }),
      expect.stringContaining('stale'),
    )
  })

  it('falls back to raw status value when STATUS_LABELS has no entry', async () => {
    const { prisma, log, sendEmail, mocks } = makeStatusChangedDeps({
      featureFindFirst: jest.fn().mockResolvedValue({
        title: 'Dark mode',
        status: 'unknown_future_status',
        project: { slug: 'acme' },
      }),
    })
    await processFeatureStatusChangedJob(
      makeStatusChangedJob({ newStatus: 'unknown_future_status' as never }),
      { prisma, log, sendEmail },
    )
    expect(mocks.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ newStatus: 'unknown_future_status' }),
    )
  })

  it('does not create log row when send fails, then throws for retry', async () => {
    const { prisma, log, sendEmail, mocks } = makeStatusChangedDeps({
      voteFindMany: jest.fn().mockResolvedValue([
        { id: 'vote-1', voterEmail: 'a@example.com' },
        { id: 'vote-2', voterEmail: 'b@example.com' },
      ]),
      sendEmail: jest.fn()
        .mockResolvedValueOnce({ ok: false, error: 'Bounced' })
        .mockResolvedValueOnce({ ok: true }),
    })
    await expect(processFeatureStatusChangedJob(makeStatusChangedJob(), { prisma, log, sendEmail })).rejects.toThrow('email sends failed')
    expect(mocks.createLog).toHaveBeenCalledTimes(1)
    expect(mocks.createLog).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ referenceId: 'vote-2:planned' }),
    }))
  })

  it('logs error when notificationLog.create rejects after email sent (duplicate risk)', async () => {
    const { prisma, log, sendEmail } = makeStatusChangedDeps({
      createLog: jest.fn().mockRejectedValue(new Error('DB deadlock')),
    })
    await processFeatureStatusChangedJob(makeStatusChangedJob(), { prisma, log, sendEmail })
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      expect.stringContaining('duplicate risk'),
    )
  })

  it('dedup uses different keys per status — voter notified for planned still gets in_progress email', async () => {
    const { prisma, log, sendEmail, mocks } = makeStatusChangedDeps({
      featureFindFirst: jest.fn().mockResolvedValue({
        title: 'Dark mode',
        status: 'in_progress',
        project: { slug: 'acme' },
      }),
      voteFindMany: jest.fn().mockResolvedValue([
        { id: 'vote-1', voterEmail: 'a@example.com' },
      ]),
      // vote-1 was already notified for 'planned', not for 'in_progress'
      notificationLogFindMany: jest.fn().mockResolvedValue([
        { referenceId: 'vote-1:planned' },
      ]),
    })
    await processFeatureStatusChangedJob(makeStatusChangedJob({ newStatus: 'in_progress' }), { prisma, log, sendEmail })
    expect(mocks.sendEmail).toHaveBeenCalledTimes(1)
  })
})

describe('dispatchEmailNotificationJob', () => {
  function makeDispatchPrisma(overrides: { changelogFindFirst?: jest.Mock; roadmapFindFirst?: jest.Mock; featureRequestFindFirst?: jest.Mock } = {}) {
    return {
      changelogEntry: { findFirst: overrides.changelogFindFirst ?? jest.fn().mockResolvedValue(null) },
      roadmapItem: { findFirst: overrides.roadmapFindFirst ?? jest.fn().mockResolvedValue(null) },
      featureRequest: { findFirst: overrides.featureRequestFindFirst ?? jest.fn().mockResolvedValue(null) },
      subscriber: { findMany: jest.fn().mockResolvedValue([]) },
      vote: { findMany: jest.fn().mockResolvedValue([]) },
      notificationLog: { findMany: jest.fn().mockResolvedValue([]) },
    } as unknown as Parameters<typeof dispatchEmailNotificationJob>[1]
  }

  function makeLog() {
    return { warn: jest.fn(), info: jest.fn(), error: jest.fn() } as unknown as Parameters<typeof dispatchEmailNotificationJob>[2]
  }

  it('routes changelog_published to processChangelogPublishedJob (calls changelogEntry.findFirst)', async () => {
    const prisma = makeDispatchPrisma()
    const log = makeLog()
    await dispatchEmailNotificationJob({ type: 'changelog_published', referenceId: 'e-1', projectId: 'p-1' }, prisma, log)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((prisma as any).changelogEntry.findFirst).toHaveBeenCalled()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((prisma as any).roadmapItem.findFirst).not.toHaveBeenCalled()
  })

  it('routes feature_shipped to processFeatureShippedJob (calls roadmapItem.findFirst)', async () => {
    const prisma = makeDispatchPrisma()
    const log = makeLog()
    await dispatchEmailNotificationJob({ type: 'feature_shipped', referenceId: 'i-1', projectId: 'p-1' }, prisma, log)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((prisma as any).roadmapItem.findFirst).toHaveBeenCalled()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((prisma as any).changelogEntry.findFirst).not.toHaveBeenCalled()
  })

  it('routes feature_status_changed to processFeatureStatusChangedJob (calls featureRequest.findFirst)', async () => {
    const prisma = makeDispatchPrisma()
    const log = makeLog()
    await dispatchEmailNotificationJob({ type: 'feature_status_changed', referenceId: 'f-1', projectId: 'p-1', newStatus: 'planned' }, prisma, log)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((prisma as any).featureRequest.findFirst).toHaveBeenCalled()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((prisma as any).changelogEntry.findFirst).not.toHaveBeenCalled()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((prisma as any).roadmapItem.findFirst).not.toHaveBeenCalled()
  })

  it('logs warn for unknown job type', async () => {
    const prisma = makeDispatchPrisma()
    const log = makeLog()
    await dispatchEmailNotificationJob({ type: 'unknown_type' as never, referenceId: 'x', projectId: 'p-1' }, prisma, log)
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'unknown_type' }),
      expect.stringContaining('unknown job type'),
    )
  })
})
