import fp from 'fastify-plugin'
import { FastifyPluginAsync } from 'fastify'
import cors from '@fastify/cors'
import { env } from '../config/env'

const corsPlugin: FastifyPluginAsync = fp(async (fastify) => {
  // Only reflect all origins in development and test.
  // Any other NODE_ENV (production, staging, preview) uses the explicit allowlist
  // to prevent credentialed cross-origin requests from untrusted origins.
  const permissive = env.NODE_ENV === 'development' || env.NODE_ENV === 'test'

  await fastify.register(cors, {
    origin: permissive
      ? true
      : env.CORS_ORIGIN.split(',').map((o) => o.trim()),
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  })
})

export default corsPlugin
