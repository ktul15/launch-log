import fp from 'fastify-plugin'
import { FastifyPluginAsync } from 'fastify'
import cookiePlugin from '@fastify/cookie'

const cookie: FastifyPluginAsync = fp(async (fastify) => {
  await fastify.register(cookiePlugin)
})

export default cookie
