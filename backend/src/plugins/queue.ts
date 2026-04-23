import fp from 'fastify-plugin'
import { FastifyPluginAsync } from 'fastify'
import { Queue } from 'bullmq'
import { NotificationJobData, createNotificationQueue, createBullMQConnection } from '../jobs/index'

declare module 'fastify' {
  interface FastifyInstance {
    notificationQueue: Queue<NotificationJobData>
  }
}

const queuePlugin: FastifyPluginAsync = fp(async (fastify) => {
  const connection = createBullMQConnection()

  // Verify Redis is reachable at startup — mirrors redis.ts pattern
  await new Promise<void>((resolve, reject) => {
    const onReady = () => {
      connection.off('error', onError)
      resolve()
    }
    const onError = (err: Error) => {
      connection.off('ready', onReady)
      connection.disconnect()
      reject(err)
    }
    connection.once('ready', onReady)
    connection.once('error', onError)
    connection.connect()
  })

  const queue = createNotificationQueue(connection)

  fastify.decorate('notificationQueue', queue)

  fastify.addHook('onClose', async () => {
    await queue.close()
    if (connection.status !== 'end') {
      await connection.quit()
    }
  })
})

export default queuePlugin
