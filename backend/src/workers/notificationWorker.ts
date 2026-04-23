import { Worker } from 'bullmq'
import { PrismaClient } from '@prisma/client'
import type { FastifyBaseLogger } from 'fastify'
import { createBullMQConnection, NotificationJobData } from '../jobs/index'
import { sendChangelogEmail, sendFeatureShippedEmail, SendResult } from '../services/emailService'
import { env } from '../config/env'

type ProcessDeps = {
  prisma: PrismaClient
  log: FastifyBaseLogger
  sendEmail: (opts: { to: string; entryTitle: string; changelogUrl: string }) => Promise<SendResult>
}

// Exported separately so tests can invoke it without a real Redis Worker
export async function processChangelogPublishedJob(
  data: NotificationJobData,
  deps: ProcessDeps,
): Promise<void> {
  if (data.type !== 'changelog_published') return

  const { referenceId: entryId, projectId } = data
  const { prisma, log, sendEmail } = deps

  const entry = await prisma.changelogEntry.findFirst({
    where: { id: entryId, projectId, status: 'published' },
    select: {
      title: true,
      project: { select: { slug: true } },
    },
  })

  if (!entry) {
    log.warn({ entryId, projectId }, 'notification worker: entry not found or not published, skipping')
    return
  }

  const changelogUrl = `${env.FRONTEND_URL}/p/${entry.project.slug}/changelog`

  const subscribers = await prisma.subscriber.findMany({
    where: { projectId, verified: true },
    select: { id: true, email: true },
  })

  if (subscribers.length === 0) return

  // Dedup: skip subscribers already notified for this entry.
  // This also handles re-publish after unpublish — publishedAt is cleared on unpublish so the
  // job is re-enqueued, but existing notification_log rows prevent duplicate emails.
  const alreadyNotified = await prisma.notificationLog.findMany({
    where: {
      changelogEntryId: entryId,
      type: 'changelog_published',
      subscriberId: { in: subscribers.map((s) => s.id) },
    },
    select: { subscriberId: true },
  })
  const notifiedIds = new Set(alreadyNotified.map((n) => n.subscriberId))

  const pending = subscribers.filter((s) => !notifiedIds.has(s.id))
  if (pending.length === 0) {
    log.info({ entryId }, 'notification worker: all subscribers already notified, skipping')
    return
  }

  const results = await Promise.allSettled(
    pending.map(async (subscriber) => {
      const result = await sendEmail({
        to: subscriber.email,
        entryTitle: entry.title,
        changelogUrl,
      })

      if (!result.ok) {
        log.warn(
          { subscriberId: subscriber.id, error: result.error },
          'notification worker: email send failed, skipping log entry',
        )
        return { sent: false }
      }

      // Write log row after send. If this fails, the email was sent but the dedup record is
      // missing — the subscriber may receive a duplicate on retry. Log as error (not warn)
      // so this is immediately visible in alerting.
      await prisma.notificationLog.create({
        data: {
          subscriberId: subscriber.id,
          changelogEntryId: entryId,
          type: 'changelog_published',
          referenceId: entryId,
        },
      })
      return { sent: true }
    }),
  )

  let sent = 0
  for (const result of results) {
    if (result.status === 'rejected') {
      // notificationLog.create failed after email was sent — duplicate email risk on retry
      log.error(
        { entryId, err: result.reason },
        'notification worker: log create failed after email sent — duplicate risk on retry',
      )
    } else if (result.value.sent) {
      sent++
    }
  }

  log.info({ entryId, total: pending.length, sent }, 'notification worker: batch complete')
}

type FeatureShippedDeps = {
  prisma: PrismaClient
  log: FastifyBaseLogger
  sendEmail: (opts: { to: string; itemTitle: string; roadmapUrl: string }) => Promise<SendResult>
}

export async function processFeatureShippedJob(
  data: NotificationJobData,
  deps: FeatureShippedDeps,
): Promise<void> {
  if (data.type !== 'feature_shipped') return

  const { referenceId: itemId, projectId } = data
  const { prisma, log, sendEmail } = deps

  const item = await prisma.roadmapItem.findFirst({
    where: { id: itemId, projectId, status: 'shipped' },
    select: {
      title: true,
      project: { select: { slug: true } },
    },
  })

  if (!item) {
    log.warn({ itemId, projectId }, 'notification worker: roadmap item not found or no longer shipped, skipping')
    return
  }

  const roadmapUrl = `${env.FRONTEND_URL}/p/${item.project.slug}/roadmap`

  const subscribers = await prisma.subscriber.findMany({
    where: { projectId, verified: true },
    select: { id: true, email: true },
  })

  if (subscribers.length === 0) return

  const alreadyNotified = await prisma.notificationLog.findMany({
    where: {
      type: 'feature_shipped',
      referenceId: itemId,
      subscriberId: { in: subscribers.map((s) => s.id) },
    },
    select: { subscriberId: true },
  })
  const notifiedIds = new Set(alreadyNotified.map((n) => n.subscriberId))

  const pending = subscribers.filter((s) => !notifiedIds.has(s.id))
  if (pending.length === 0) {
    log.info({ itemId }, 'notification worker: all subscribers already notified, skipping')
    return
  }

  const results = await Promise.allSettled(
    pending.map(async (subscriber) => {
      const result = await sendEmail({
        to: subscriber.email,
        itemTitle: item.title,
        roadmapUrl,
      })

      if (!result.ok) {
        log.warn(
          { subscriberId: subscriber.id, error: result.error },
          'notification worker: email send failed, skipping log entry',
        )
        return { sent: false }
      }

      await prisma.notificationLog.create({
        data: {
          subscriberId: subscriber.id,
          type: 'feature_shipped',
          referenceId: itemId,
        },
      })
      return { sent: true }
    }),
  )

  let sent = 0
  for (const result of results) {
    if (result.status === 'rejected') {
      log.error(
        { itemId, err: result.reason },
        'notification worker: log create failed after email sent — duplicate risk on retry',
      )
    } else if (result.value.sent) {
      sent++
    }
  }

  log.info({ itemId, total: pending.length, sent }, 'notification worker: batch complete')
}

// Exported for use in tests to assert failed-event behavior without a real Worker
export function handleWorkerFailedEvent(
  job: { id?: string; attemptsMade: number; opts: { attempts?: number } } | undefined,
  err: Error,
  log: FastifyBaseLogger,
): void {
  const maxAttempts = job?.opts.attempts ?? 1
  if (job && job.attemptsMade >= maxAttempts) {
    log.error({ jobId: job.id, err }, 'notification worker: job exhausted all retries')
  } else {
    log.warn({ jobId: job?.id, attemptsMade: job?.attemptsMade, err }, 'notification worker: job attempt failed, will retry')
  }
}

export function createNotificationWorker(
  prisma: PrismaClient,
  log: FastifyBaseLogger,
): Worker<NotificationJobData> {
  const connection = createBullMQConnection()

  const worker = new Worker<NotificationJobData>(
    'notifications',
    async (job) => {
      if (job.data.type === 'changelog_published') {
        return processChangelogPublishedJob(job.data, { prisma, log, sendEmail: sendChangelogEmail })
      }
      if (job.data.type === 'feature_shipped') {
        return processFeatureShippedJob(job.data, { prisma, log, sendEmail: sendFeatureShippedEmail })
      }
      log.warn({ type: job.data.type }, 'notification worker: unknown job type, skipping')
    },
    { connection, concurrency: 5 },
  )

  worker.on('failed', (job, err) => handleWorkerFailedEvent(job, err, log))

  return worker
}
