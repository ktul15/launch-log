import fp from 'fastify-plugin'
import { FastifyPluginAsync } from 'fastify'
import rateLimit from '@fastify/rate-limit'

const rateLimitPlugin: FastifyPluginAsync = fp(async (fastify) => {
  await fastify.register(rateLimit, {
    // With trustProxy: true on the Fastify instance (set in index.ts),
    // request.ip is already resolved from X-Forwarded-For correctly.
    // Do NOT read the raw header here — it's trivially spoofable.
    max: 200,
    timeWindow: '1 minute',
    errorResponseBuilder: (_request, context) => ({
      statusCode: 429,
      error: 'Too Many Requests',
      message: `Rate limit exceeded. Retry after ${context.after}`,
    }),
  })
})

export default rateLimitPlugin
