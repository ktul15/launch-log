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
  // Access tokens: short-lived, signed with JWT_SECRET.
  // cookie.cookieName enables extraction from httpOnly cookie in request.accessVerify().
  await fastify.register(jwtPlugin, {
    secret: env.JWT_SECRET,
    sign: { expiresIn: env.JWT_ACCESS_EXPIRES_IN },
    namespace: 'access',
    jwtVerify: 'accessVerify',
    jwtSign: 'accessSign',
    cookie: { cookieName: 'access_token', signed: false },
  })

  // Refresh tokens: long-lived, signed with a separate JWT_REFRESH_SECRET.
  // Using a distinct secret means a compromised access secret cannot forge refresh tokens.
  await fastify.register(jwtPlugin, {
    secret: env.JWT_REFRESH_SECRET,
    sign: { expiresIn: env.JWT_REFRESH_EXPIRES_IN },
    namespace: 'refresh',
    jwtVerify: 'refreshVerify',
    jwtSign: 'refreshSign',
    cookie: { cookieName: 'refresh_token', signed: false },
  })

  // In @fastify/jwt v8, the namespace option stores instances at fastify.jwt[namespace] rather
  // than decorating fastify[namespace] directly (see jwt.js line 180: fastify.jwt[namespace] =
  // jwtDecorator). We extract them and add explicit top-level decorations so route handlers can
  // use fastify.access.sign() / fastify.refresh.sign() as declared above.
  // The runtime guard ensures a @fastify/jwt upgrade that changes this behaviour fails fast at
  // startup rather than silently causing TypeError in the first authenticated request.
  const namespacedJwt = fastify.jwt as unknown as Record<string, JWT>
  if (!namespacedJwt.access || !namespacedJwt.refresh) {
    throw new Error(
      'JWT namespaces not initialized. Verify that @fastify/jwt is registered with ' +
        'namespace: "access" and namespace: "refresh" before calling fastify.decorate.',
    )
  }
  fastify.decorate('access', namespacedJwt.access)
  fastify.decorate('refresh', namespacedJwt.refresh)
})

export default jwt
