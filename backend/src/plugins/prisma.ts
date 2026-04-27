import fp from 'fastify-plugin'
import { FastifyPluginAsync } from 'fastify'
import { PrismaClient } from '@prisma/client'

declare module 'fastify' {
  interface FastifyInstance {
    prisma: PrismaClient
  }
}

const prismaPlugin: FastifyPluginAsync = fp(async (fastify) => {
  const prisma = new PrismaClient({
    // Only log errors and warnings — never 'query', which outputs raw SQL
    // including parameterized values that may contain PII (emails, hashes)
    log: [
      { emit: 'event', level: 'error' },
      { emit: 'event', level: 'warn' },
    ],
  })

  prisma.$on('error', (e) => fastify.log.error({ prismaTarget: e.target, message: e.message }, 'Prisma error'))
  prisma.$on('warn', (e) => fastify.log.warn({ prismaTarget: e.target, message: e.message }, 'Prisma warning'))

  await prisma.$connect()

  fastify.decorate('prisma', prisma)

  fastify.addHook('onClose', async (instance) => {
    await instance.prisma.$disconnect()
  })
})

export default prismaPlugin
