import fp from 'fastify-plugin'
import { FastifyPluginAsync } from 'fastify'
import jwtPlugin, { JWT } from '@fastify/jwt'
import { env } from '../config/env'

declare module 'fastify' {
  interface FastifyInstance {
    // fastify.access.sign / verify — for short-lived access tokens
    access: JWT
    // fastify.refresh.sign / verify — for long-lived refresh tokens
    refresh: JWT
  }
}

const jwt: FastifyPluginAsync = fp(async (fastify) => {
  // Access tokens: short-lived, signed with JWT_SECRET
  await fastify.register(jwtPlugin, {
    secret: env.JWT_SECRET,
    sign: { expiresIn: env.JWT_ACCESS_EXPIRES_IN },
    namespace: 'access',
    jwtVerify: 'accessVerify',
    jwtSign: 'accessSign',
  })

  // Refresh tokens: long-lived, signed with a separate JWT_REFRESH_SECRET.
  // Using a distinct secret means a compromised access secret cannot forge refresh tokens.
  await fastify.register(jwtPlugin, {
    secret: env.JWT_REFRESH_SECRET,
    sign: { expiresIn: env.JWT_REFRESH_EXPIRES_IN },
    namespace: 'refresh',
    jwtVerify: 'refreshVerify',
    jwtSign: 'refreshSign',
  })

  // Cookie extraction for both token types is added in issue #3 when @fastify/cookie is installed.
  // Add to each registration above:
  //   cookie: { cookieName: 'access_token', signed: false }  (access)
  //   cookie: { cookieName: 'refresh_token', signed: false } (refresh)
})

export default jwt
