import { Queue } from 'bullmq'
import IORedis from 'ioredis'
import { FeatureStatus } from '@prisma/client'
import { env } from '../config/env'

export type EmailNotificationJobData =
  | { type: 'changelog_published'; referenceId: string; projectId: string }
  | { type: 'feature_shipped'; referenceId: string; projectId: string }
  | { type: 'feature_status_changed'; referenceId: string; projectId: string; newStatus: FeatureStatus }

export type VoteVerificationJobData = {
  type: 'vote_verification'
  referenceId: string
  projectId: string
}

export type SubscriptionVerificationJobData = {
  type: 'subscribe_verification'
  referenceId: string
  projectId: string
}

// BullMQ requires a dedicated connection — sharing the app's Redis connection
// causes blocking commands (BLPOP) to starve other operations.
export function createBullMQConnection(): IORedis {
  return new IORedis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
    lazyConnect: true,
  })
}

const defaultJobOptions = {
  removeOnComplete: 100,
  removeOnFail: 50,
  attempts: 3,
  backoff: { type: 'exponential', delay: 2000 },
} as const

// Returns a new Queue instance each call — callers own the lifecycle.
// Do not use a module-level singleton: it leaks between Jest test runs.
export function createEmailNotificationsQueue(connection: IORedis): Queue<EmailNotificationJobData> {
  return new Queue('email-notifications', { connection, defaultJobOptions })
}

export function createVoteVerificationQueue(connection: IORedis): Queue<VoteVerificationJobData> {
  return new Queue('vote-verification', { connection, defaultJobOptions })
}

export function createSubscriptionVerificationQueue(connection: IORedis): Queue<SubscriptionVerificationJobData> {
  return new Queue('subscription-verification', { connection, defaultJobOptions })
}
