import fp from 'fastify-plugin'
import { FastifyPluginAsync } from 'fastify'
import { Queue } from 'bullmq'
import {
  EmailNotificationJobData,
  VoteVerificationJobData,
  SubscriptionVerificationJobData,
  createEmailNotificationsQueue,
  createVoteVerificationQueue,
  createSubscriptionVerificationQueue,
  createBullMQConnection,
} from '../jobs/index'

declare module 'fastify' {
  interface FastifyInstance {
    emailNotificationsQueue: Queue<EmailNotificationJobData>
    voteVerificationQueue: Queue<VoteVerificationJobData>
    subscriptionVerificationQueue: Queue<SubscriptionVerificationJobData>
  }
}

const queuePlugin: FastifyPluginAsync = fp(async (fastify) => {
  // Each queue gets its own connection — BullMQ's Queue.close() behavior on a
  // shared connection is non-deterministic when multiple queues share one IORedis.
  const emailConnection = createBullMQConnection()
  const voteConnection = createBullMQConnection()
  const subscriptionConnection = createBullMQConnection()

  // Verify Redis is reachable at startup using the first connection.
  // If Redis is up for one connection, it's up for all three.
  await new Promise<void>((resolve, reject) => {
    const onReady = () => {
      emailConnection.off('error', onError)
      resolve()
    }
    const onError = (err: Error) => {
      emailConnection.off('ready', onReady)
      emailConnection.disconnect()
      reject(err)
    }
    emailConnection.once('ready', onReady)
    emailConnection.once('error', onError)
    emailConnection.connect()
  })

  // Connect remaining connections after Redis is confirmed reachable.
  await voteConnection.connect()
  await subscriptionConnection.connect()

  const emailQueue = createEmailNotificationsQueue(emailConnection)
  const voteQueue = createVoteVerificationQueue(voteConnection)
  const subscriptionQueue = createSubscriptionVerificationQueue(subscriptionConnection)

  fastify.decorate('emailNotificationsQueue', emailQueue)
  fastify.decorate('voteVerificationQueue', voteQueue)
  fastify.decorate('subscriptionVerificationQueue', subscriptionQueue)

  fastify.addHook('onClose', async () => {
    await Promise.all([emailQueue.close(), voteQueue.close(), subscriptionQueue.close()])
    await Promise.all([
      emailConnection.status !== 'end' ? emailConnection.quit() : Promise.resolve(),
      voteConnection.status !== 'end' ? voteConnection.quit() : Promise.resolve(),
      subscriptionConnection.status !== 'end' ? subscriptionConnection.quit() : Promise.resolve(),
    ])
  })
})

export default queuePlugin
