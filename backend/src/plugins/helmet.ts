import fp from 'fastify-plugin'
import { FastifyPluginAsync } from 'fastify'
import helmet from '@fastify/helmet'

const helmetPlugin: FastifyPluginAsync = fp(async (fastify) => {
  // CSP disabled — this is an API server; Next.js manages its own CSP
  await fastify.register(helmet, { contentSecurityPolicy: false })
})

export default helmetPlugin
