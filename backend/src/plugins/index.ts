import { FastifyInstance } from 'fastify'
import helmetPlugin from './helmet'
import corsPlugin from './cors'
import rateLimitPlugin from './rateLimit'
import prismaPlugin from './prisma'
import redisPlugin from './redis'
import cookiePlugin from './cookie'
import jwtPlugin from './jwt'
import multipartPlugin from './multipart'

export async function registerPlugins(app: FastifyInstance): Promise<void> {
  // Security first — must be registered before any routes
  await app.register(helmetPlugin)
  await app.register(corsPlugin)
  await app.register(rateLimitPlugin)

  // Infrastructure — database and cache connections
  await app.register(prismaPlugin)
  await app.register(redisPlugin)

  // Cookie support must be registered before JWT so @fastify/jwt can extract tokens from cookies
  await app.register(cookiePlugin)

  // Auth — JWT signing/verification
  await app.register(jwtPlugin)

  // Upload support
  await app.register(multipartPlugin)
}
