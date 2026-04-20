import fp from 'fastify-plugin'
import { FastifyPluginAsync } from 'fastify'
import IORedis from 'ioredis'
import { env } from '../config/env'

declare module 'fastify' {
  interface FastifyInstance {
    redis: IORedis
  }
}

const redisPlugin: FastifyPluginAsync = fp(async (fastify) => {
  const redis = new IORedis(env.REDIS_URL, {
    // Required by BullMQ — blocking commands must not have a retry limit
    maxRetriesPerRequest: null,
  })

  redis.on('error', (err) => {
    fastify.log.error({ err }, 'Redis connection error')
  })

  // Wait for connection before accepting traffic; clean up on failure
  await new Promise<void>((resolve, reject) => {
    const onReady = () => {
      redis.off('error', onError)
      resolve()
    }
    const onError = (err: Error) => {
      redis.off('ready', onReady)
      // Disconnect to stop retry timers so the process can exit cleanly
      redis.disconnect()
      reject(err)
    }
    redis.once('ready', onReady)
    redis.once('error', onError)
  })

  fastify.decorate('redis', redis)

  fastify.addHook('onClose', async (instance) => {
    // Guard against already-disconnected client (e.g. Redis went away mid-flight)
    if (instance.redis.status !== 'end') {
      await instance.redis.quit()
    }
  })
})

export default redisPlugin
