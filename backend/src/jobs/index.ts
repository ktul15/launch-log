import { Queue } from 'bullmq'
import IORedis from 'ioredis'
import { env } from '../config/env'

export type NotificationJobData = {
  type:
    | 'changelog_published'
    | 'feature_shipped'
    | 'status_changed'
    | 'vote_verification'
    | 'subscribe_verification'
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

// Returns a new Queue instance each call — callers own the lifecycle.
// Do not use a module-level singleton: it leaks between Jest test runs.
export function createNotificationQueue(connection: IORedis): Queue<NotificationJobData> {
  return new Queue('notifications', {
    connection,
    defaultJobOptions: {
      removeOnComplete: 100,
      removeOnFail: 50,
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
    },
  })
}
