import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import bcrypt from 'bcrypt'
import { z } from 'zod'
import crypto from 'crypto'
import { Organization, User } from '@prisma/client'
import { ALLOWED_ROLES, Role } from '../config/constants'

// JWT length is structurally determined by the signer so char length ≈ byte length in practice,
// but we compute byte-length buffers first and guard before calling timingSafeEqual to avoid the
// RangeError it throws when buffer sizes differ (e.g. multi-byte UTF-8 in a crafted token).
function safeTokenEqual(a: string, b: string): boolean {
  try {
    const ba = Buffer.from(a)
    const bb = Buffer.from(b)
    if (ba.length !== bb.length) return false
    return crypto.timingSafeEqual(ba, bb)
  } catch {
    return false
  }
}
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/library'
import { env } from '../config/env'
import { googleOAuth } from '../plugins/passport'
import { toSlug } from '../utils/slug'
import '@fastify/cookie'

const BCRYPT_ROUNDS = 10

// Computed once at startup — bcrypt.compare always runs during login regardless of whether the
// email exists, preventing a timing oracle that would reveal registered addresses.
const DUMMY_HASH = bcrypt.hashSync('__launchlog_dummy__', BCRYPT_ROUNDS)

// Per-route auth rate limits. Tests use a very high cap so the plugin is still exercised
// (config blocks are present and active) without individual test requests being throttled.
const AUTH_RATE_LIMIT = env.NODE_ENV === 'test' ? 100_000 : 10
const LOGOUT_RATE_LIMIT = env.NODE_ENV === 'test' ? 100_000 : 20

const registerSchema = z.object({
  orgName: z.string().min(2, 'Organisation name must be at least 2 characters'),
  name: z.string().min(1, 'Name is required'),
  email: z.string().email('Invalid email address'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
})

const loginSchema = z.object({
  email: z.string().email('Invalid email address'),
  // max(1024) prevents multi-megabyte payloads from consuming bcrypt CPU unnecessarily
  password: z.string().min(1, 'Password is required').max(1024),
})

// Parses JWT expiry strings like "15m", "7d", "1h" to seconds for cookie maxAge and Redis TTL.
// Throws on unrecognised formats or non-positive values so misconfigured env vars surface at
// startup rather than silently producing NaN/zero, which would corrupt expiry values.
function expiryToSeconds(exp: string): number {
  const match = exp.match(/^(\d+)([smhd])$/)
  if (match) {
    const multipliers: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 }
    const result = Number(match[1]) * (multipliers[match[2]] ?? 1)
    if (result <= 0) throw new Error(`JWT expiry must be positive, got "${exp}"`)
    return result
  }
  const raw = Number(exp)
  if (Number.isNaN(raw) || raw <= 0) throw new Error(`Invalid JWT expiry format: "${exp}"`)
  return raw
}

const ACCESS_MAX_AGE = expiryToSeconds(env.JWT_ACCESS_EXPIRES_IN)
const REFRESH_MAX_AGE = expiryToSeconds(env.JWT_REFRESH_EXPIRES_IN)

// lax permits cookies on top-level navigations (required for OAuth callbacks). strict would
// offer no additional CSRF protection here because our API endpoints require a JSON body and
// the httpOnly flag already prevents JS from reading the token.
const COOKIE_BASE = {
  httpOnly: true,
  secure: env.NODE_ENV === 'production',
  sameSite: 'lax' as const,
  path: '/',
}

// CORS_ORIGIN may be comma-separated in production (e.g. "https://a.com,https://b.com").
// Use only the first origin for redirects to keep the Location header a valid URL.
const FRONTEND_ORIGIN = env.CORS_ORIGIN.split(',')[0].trim().replace(/\/$/, '')

// Attempts to create org + user atomically, retrying up to MAX_SLUG_ATTEMPTS times on slug
// collision. Uses 4-byte (8 hex-char) suffix giving ~4 billion values per base slug.
async function createOrgAndUser(
  fastify: FastifyInstance,
  orgName: string,
  email: string,
  name: string,
  passwordHash: string,
): Promise<{ org: Organization; user: User }> {
  const MAX_SLUG_ATTEMPTS = 5
  const baseSlug = toSlug(orgName, fastify.log)

  for (let attempt = 0; attempt <= MAX_SLUG_ATTEMPTS; attempt++) {
    const slug =
      attempt === 0 ? baseSlug : `${baseSlug}-${crypto.randomBytes(4).toString('hex')}`

    try {
      return await fastify.prisma.$transaction(async (tx) => {
        const org = await tx.organization.create({ data: { name: orgName, slug } })
        const user = await tx.user.create({
          data: { orgId: org.id, email, name, passwordHash, role: 'owner' },
        })
        return { org, user }
      })
    } catch (err) {
      if (err instanceof PrismaClientKnownRequestError && err.code === 'P2002') {
        const target = JSON.stringify(err.meta?.target ?? '')
        if (target.includes('email')) {
          const conflict = new Error('Email already registered') as Error & { statusCode: number }
          conflict.statusCode = 409
          throw conflict
        }
        if (target.includes('slug') && attempt < MAX_SLUG_ATTEMPTS) continue
      }
      throw err
    }
  }

  const slugError = new Error('Could not generate a unique org slug') as Error & {
    statusCode: number
  }
  slugError.statusCode = 409
  throw slugError
}

export default async function authRoutes(fastify: FastifyInstance) {
  fastify.post(
    '/register',
    { config: { rateLimit: { max: AUTH_RATE_LIMIT, timeWindow: 60_000 } } },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const parsed = registerSchema.safeParse(req.body)
      if (!parsed.success) {
        return reply.status(422).send({ message: parsed.error.errors[0].message })
      }

      const { orgName, name, email, password } = parsed.data

      const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS)

      // Global uniqueness check — the DB constraint is per-org but login is not org-scoped,
      // so the same email in two orgs would make login non-deterministic.
      const existing = await fastify.prisma.user.findFirst({ where: { email } })
      if (existing) {
        return reply.status(409).send({ message: 'Email already registered' })
      }

      let result: { org: Organization; user: User }
      try {
        result = await createOrgAndUser(fastify, orgName, email, name, passwordHash)
      } catch (err: unknown) {
        const e = err as { statusCode?: number; message?: string }
        if (e.statusCode === 409) {
          return reply.status(409).send({ message: e.message ?? 'Conflict' })
        }
        throw err
      }

      const { org, user } = result
      const payload = { sub: user.id, orgId: org.id, role: user.role }
      const accessToken = fastify.access.sign(payload)
      const refreshToken = fastify.refresh.sign(payload)

      await fastify.redis.set(`refresh:${user.id}`, refreshToken, 'EX', REFRESH_MAX_AGE)

      reply.setCookie('access_token', accessToken, { ...COOKIE_BASE, maxAge: ACCESS_MAX_AGE })
      reply.setCookie('refresh_token', refreshToken, { ...COOKIE_BASE, maxAge: REFRESH_MAX_AGE })

      // Tokens are delivered via httpOnly cookies only — not in the response body — so that
      // browser JS (including XSS payloads and third-party scripts) cannot read them.
      return reply.status(201).send({
        user: { id: user.id, name: user.name, email: user.email },
        org: { id: org.id, name: org.name, slug: org.slug },
      })
    },
  )

  fastify.post(
    '/login',
    { config: { rateLimit: { max: AUTH_RATE_LIMIT, timeWindow: 60_000 } } },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const parsed = loginSchema.safeParse(req.body)
      if (!parsed.success) {
        return reply.status(422).send({ message: parsed.error.errors[0].message })
      }

      const { email, password } = parsed.data

      const user = await fastify.prisma.user.findFirst({
        where: { email, passwordHash: { not: null } },
        include: { org: true },
      })

      // Always run bcrypt.compare — if the user doesn't exist we compare against DUMMY_HASH so
      // the response time is the same whether the email is registered or not, preventing
      // enumeration via timing.
      const hashToCompare = user?.passwordHash ?? DUMMY_HASH
      const passwordMatches = await bcrypt.compare(password, hashToCompare)

      if (!user || !passwordMatches) {
        return reply.status(401).send({ message: 'Invalid credentials' })
      }

      if (!user.org) {
        return reply.status(500).send({ message: 'Internal Server Error' })
      }

      const payload = { sub: user.id, orgId: user.orgId, role: user.role }
      const accessToken = fastify.access.sign(payload)
      const refreshToken = fastify.refresh.sign(payload)

      await fastify.redis.set(`refresh:${user.id}`, refreshToken, 'EX', REFRESH_MAX_AGE)

      reply.setCookie('access_token', accessToken, { ...COOKIE_BASE, maxAge: ACCESS_MAX_AGE })
      reply.setCookie('refresh_token', refreshToken, { ...COOKIE_BASE, maxAge: REFRESH_MAX_AGE })

      return reply.status(200).send({
        user: { id: user.id, name: user.name, email: user.email },
        org: { id: user.org.id, name: user.org.name, slug: user.org.slug },
      })
    },
  )

  // ─── Google OAuth ──────────────────────────────────────────────────────────

  const GOOGLE_RATE_LIMIT = env.NODE_ENV === 'test' ? 100_000 : 20

  // Step 1: redirect browser to Google's consent screen
  fastify.get(
    '/google',
    { config: { rateLimit: { max: GOOGLE_RATE_LIMIT, timeWindow: 60_000 } } },
    async (req: FastifyRequest, reply: FastifyReply) => {
      if (!googleOAuth.authenticate) {
        return reply.status(503).send({ message: 'Google OAuth is not configured' })
      }
      const result = await googleOAuth.authenticate(req, reply)
      if (result.type === 'redirect') return reply.redirect(result.url)
    },
  )

  // Step 2: Google redirects back here; Passport exchanges the code for a profile
  fastify.get(
    '/google/callback',
    { config: { rateLimit: { max: GOOGLE_RATE_LIMIT, timeWindow: 60_000 } } },
    async (req: FastifyRequest, reply: FastifyReply) => {
      if (!googleOAuth.authenticate) {
        return reply.redirect(`${FRONTEND_ORIGIN}/login?error=oauth`)
      }

      let result
      try {
        result = await googleOAuth.authenticate(req, reply)
      } catch {
        return reply.redirect(`${FRONTEND_ORIGIN}/login?error=oauth`)
      }

      if (result.type !== 'success') {
        return reply.redirect(`${FRONTEND_ORIGIN}/login?error=oauth`)
      }

      const { user } = result
      const payload = { sub: user.id, orgId: user.orgId, role: user.role }
      const accessToken = fastify.access.sign(payload)
      const refreshToken = fastify.refresh.sign(payload)

      await fastify.redis.set(`refresh:${user.id}`, refreshToken, 'EX', REFRESH_MAX_AGE)

      reply.setCookie('access_token', accessToken, { ...COOKIE_BASE, maxAge: ACCESS_MAX_AGE })
      reply.setCookie('refresh_token', refreshToken, { ...COOKIE_BASE, maxAge: REFRESH_MAX_AGE })

      return reply.redirect(`${FRONTEND_ORIGIN}/dashboard`)
    },
  )

  fastify.post(
    '/refresh',
    { config: { rateLimit: { max: AUTH_RATE_LIMIT, timeWindow: 60_000 } } },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const token = req.cookies['refresh_token']
      if (!token) {
        return reply.status(401).send({ message: 'Unauthorized' })
      }

      let payload: { sub: string; orgId: string; role: string }
      try {
        payload = fastify.refresh.verify<{ sub: string; orgId: string; role: string }>(token)
      } catch (err: unknown) {
        const code = (err as { code?: string }).code
        // fast-jwt throws 'FAST_JWT_EXPIRED' on expired tokens (instance-level verify)
        if (code === 'FAST_JWT_EXPIRED') {
          return reply.status(401).send({ message: 'Token expired', code: 'TOKEN_EXPIRED' })
        }
        return reply.status(401).send({ message: 'Unauthorized' })
      }

      // Validate claims before using sub as a Redis key or re-signing the token.
      const { sub, orgId, role } = payload
      if (
        typeof sub !== 'string' || !sub ||
        typeof orgId !== 'string' || !orgId ||
        !ALLOWED_ROLES.includes(role as Role)
      ) {
        return reply.status(401).send({ message: 'Unauthorized' })
      }

      const stored = await fastify.redis.get(`refresh:${sub}`)
      // Constant-time compare prevents timing oracle on the stored token value.
      if (!stored || !safeTokenEqual(stored, token)) {
        return reply.status(401).send({ message: 'Unauthorized' })
      }

      const accessToken = fastify.access.sign({ sub, orgId, role: role as Role })
      reply.setCookie('access_token', accessToken, { ...COOKIE_BASE, maxAge: ACCESS_MAX_AGE })
      return reply.status(200).send({ message: 'Token refreshed' })
    },
  )

  fastify.post(
    '/logout',
    { config: { rateLimit: { max: LOGOUT_RATE_LIMIT, timeWindow: 60_000 } } },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const refreshToken = req.cookies['refresh_token']
      if (refreshToken) {
        try {
          const payload = fastify.refresh.verify<{ sub: string }>(refreshToken)
          // Guard against tokens that are structurally valid but missing the sub claim
          if (payload.sub) {
            const stored = await fastify.redis.get(`refresh:${payload.sub}`)
            // Compare before deleting — prevents a stale token from invalidating a newer session
            // if token rotation is ever added. The get→del is not atomic; a concurrent logout
            // would simply find the key already gone and skip the delete, which is harmless for
            // the current single-session-per-user model.
            if (stored && safeTokenEqual(stored, refreshToken)) {
              await fastify.redis.del(`refresh:${payload.sub}`)
            }
          }
        } catch {
          // Token may be expired or tampered — still clear cookies
        }
      }

      reply.clearCookie('access_token', COOKIE_BASE)
      reply.clearCookie('refresh_token', COOKIE_BASE)
      return reply.status(200).send({ message: 'Logged out' })
    },
  )
}
