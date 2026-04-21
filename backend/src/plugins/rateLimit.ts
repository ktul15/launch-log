import fp from 'fastify-plugin'
import { FastifyPluginAsync } from 'fastify'
import rateLimit from '@fastify/rate-limit'
import { env } from '../config/env'

const rateLimitPlugin: FastifyPluginAsync = fp(async (fastify) => {
  await fastify.register(rateLimit, {
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
