import fp from 'fastify-plugin'
import { FastifyPluginAsync } from 'fastify'
import rateLimit from '@fastify/rate-limit'
import IORedis from 'ioredis'
import { env } from '../config/env'

const rateLimitPlugin: FastifyPluginAsync = fp(async (fastify) => {
  // Dedicated Redis connection for rate limiting — separate from BullMQ so settings differ.
  // maxRetriesPerRequest: 0 + enableOfflineQueue: false means a Redis outage fails fast
  // rather than queuing/blocking every incoming request. skipOnError: true (below) then
  // falls back to in-memory so the app stays up.
  const redis = new IORedis(env.REDIS_URL, {
    maxRetriesPerRequest: 0,
    enableOfflineQueue: false,
    lazyConnect: true,
  })

  // Track whether connect() succeeded. The onClose guard checks `status !== 'end'` but
  // IORedis uses 'close' (not 'end') after a failed connect, so quit() would throw without
  // this flag. skipOnError: true below handles the in-flight fallback when Redis is down.
  let redisConnected = false
  try {
    await redis.connect()
    redisConnected = true
  } catch (err) {
    fastify.log.warn({ err }, 'rateLimit: Redis connect failed — falling back to in-memory store')
  }

  fastify.addHook('onClose', async () => {
    if (redisConnected && redis.status !== 'end') await redis.quit()
  })

  await fastify.register(rateLimit, {
    redis,
    // skipOnError: rate-limit errors (e.g. Redis down) pass the request through rather than 500.
    // Known trade-off: during a Redis hiccup, per-process in-memory limits apply, so the
    // effective global rate doubles per worker in multi-process deployments.
    skipOnError: true,
    // With trustProxy: true on the Fastify instance (set in index.ts),
    // request.ip is already resolved from X-Forwarded-For correctly.
    // Do NOT read the raw header here — it's trivially spoofable.
    //
    // In test env, a very high cap keeps the plugin and all per-route rateLimit configs
    // active (so misconfigured or missing limits are still detectable) while ensuring
    // inject() requests sharing 127.0.0.1 are never actually throttled.
    //
    // This global limit (200/min in prod) is defence-in-depth. Individual sensitive routes
    // like /auth/* override it with much stricter per-route limits (10/min) via route config.
    max: env.NODE_ENV === 'test' ? 100_000 : 200,
    timeWindow: '1 minute',
    errorResponseBuilder: (_request, context) => ({
      statusCode: 429,
      error: 'Too Many Requests',
      message: `Rate limit exceeded. Retry after ${context.after}`,
    }),
  })
})

export default rateLimitPlugin
