import fp from 'fastify-plugin'
import { FastifyInstance, FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify'
import { Strategy as GoogleStrategy, Profile } from 'passport-google-oauth20'
import crypto from 'crypto'
import { Organization, User } from '@prisma/client'
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/library'
import { env } from '../config/env'
import { toSlug } from '../utils/slug'

export type UserWithOrg = User & { org: Organization }

// ─── Typed interfaces ─────────────────────────────────────────────────────────

// State store contract mirroring passport-oauth2's internal StateStore interface.
// Typed here so RedisStateStore is checked against it without casting.
interface OAuth2StateStore {
  store(req: unknown, state: string, meta: unknown, callback: (err: Error | null) => void): void
  verify(
    req: unknown,
    providedState: string,
    state: unknown,
    callback: (err: Error | null, ok: boolean, state?: string) => void,
  ): void
}

// Outcome methods Passport sets on a strategy before calling authenticate().
// Typed once so the single cast is auditable and subsequent uses are type-safe.
interface PassportStrategyContext {
  success(user: UserWithOrg, info?: unknown): void
  fail(challenge: { message?: string } | number, status?: number): void
  redirect(url: string, status?: number): void
  error(err: Error): void
  pass(): void
  authenticate(req: unknown, options?: unknown): void
}

// ─── OAuth state store backed by Redis ────────────────────────────────────────
// Replaces the default session-based store. Each token lives 5 min — long enough
// for the user to complete the Google consent screen. Delete-then-check-count is
// atomic: it prevents replay of a used state token.

const STATE_MAX_LEN = 128
// passport-oauth2 ≥ 1.7.0 generates state tokens via crypto.randomBytes(24).toString('base64url'),
// producing only [A-Za-z0-9_-]. If you upgrade passport-oauth2, verify it still uses base64url
// (not base64, which adds '+', '/', '=' and would cause all state verification to silently fail).
const STATE_RE = /^[a-zA-Z0-9_-]+$/

export class RedisStateStore implements OAuth2StateStore {
  private prefix = 'oauth_state:'

  constructor(private redis: FastifyInstance['redis']) {}

  store(_req: unknown, state: string, _meta: unknown, callback: (err: Error | null) => void) {
    this.redis
      .set(`${this.prefix}${state}`, '1', 'EX', 300)
      .then(() => callback(null))
      .catch(callback)
  }

  verify(
    _req: unknown,
    providedState: string,
    _state: unknown,
    callback: (err: Error | null, ok: boolean, state?: string) => void,
  ) {
    // Reject oversized or malformed state before touching Redis.
    if (!providedState || providedState.length > STATE_MAX_LEN || !STATE_RE.test(providedState)) {
      callback(null, false, undefined)
      return
    }

    this.redis
      .del(`${this.prefix}${providedState}`)
      .then((deleted) => callback(null, deleted > 0, deleted > 0 ? providedState : undefined))
      .catch((err) => callback(err, false))
  }
}

// ─── User find / create / link ────────────────────────────────────────────────

async function findOrCreateUser(fastify: FastifyInstance, profile: Profile): Promise<UserWithOrg> {
  const googleId = profile.id
  const email = profile.emails?.[0]?.value
  const name = profile.displayName || email?.split('@')[0] || 'User'
  const avatarUrl = profile.photos?.[0]?.value ?? null

  if (!email) throw Object.assign(new Error('Google account has no email'), { statusCode: 400 })

  // 1. Existing user with this googleId — sign in directly
  const byGoogleId = await fastify.prisma.user.findFirst({
    where: { googleId },
    include: { org: true },
  })
  if (byGoogleId) return byGoogleId as UserWithOrg

  // 2. Existing user(s) with matching email — link googleId and sign in.
  //    The schema allows the same email in multiple orgs (invitations). Prefer the account that
  //    was created via registration (has a passwordHash — i.e., the org owner). If multiple or
  //    none have a password, fall back to the oldest record for deterministic behaviour.
  //    Preserve any custom avatarUrl the user already has.
  const byEmailUsers = await fastify.prisma.user.findMany({
    where: { email },
    include: { org: true },
    orderBy: { createdAt: 'asc' },
  })
  const byEmail = byEmailUsers.find((u) => u.passwordHash !== null) ?? byEmailUsers[0] ?? null
  if (byEmail) {
    // Step 1: link googleId atomically — updateMany accepts arbitrary filter conditions
    // (unlike update which requires a unique-field where clause).
    // `googleId: null` guard prevents a concurrent OAuth callback for the same email from
    // overwriting an already-linked account.
    const { count } = await fastify.prisma.user.updateMany({
      where: { id: byEmail.id, googleId: null },
      data: { googleId },
    })
    if (count === 0) {
      // Zero rows updated — a concurrent callback already linked a googleId to this email.
      // Fetch by googleId (not email) to avoid the multi-org ambiguity: the concurrent request
      // just created the record we want, so googleId is the only unambiguous lookup key.
      const byId = await fastify.prisma.user.findFirst({ where: { googleId }, include: { org: true } })
      if (byId) return byId as UserWithOrg
      throw Object.assign(new Error('Email already linked to a different Google account'), { statusCode: 409 })
    }
    // Step 2: set avatarUrl separately so it doesn't interfere with the googleId link atomicity.
    // `avatarUrl: null` in the where clause ensures we don't overwrite an avatar set concurrently
    // (e.g. a concurrent profile update between the findMany above and this write).
    if (avatarUrl) {
      await fastify.prisma.user.updateMany({
        where: { id: byEmail.id, avatarUrl: null },
        data: { avatarUrl },
      })
    }
    // Fetch by id — avoids multi-org email ambiguity that findFirst({ where: { email } }) has.
    const linked = await fastify.prisma.user.findUnique({ where: { id: byEmail.id }, include: { org: true } })
    return linked as UserWithOrg
  }

  // 3. Brand-new user — create org + user atomically.
  //    passwordHash is left null; the user authenticates via Google only (unless they
  //    later set a password). Slug collisions are retried up to MAX_ATTEMPTS times.
  //    If a concurrent request wins the race and inserts the same email first, we catch
  //    the P2002 and fall back to fetching the just-created record.
  const orgName = `${name}'s Workspace`
  const baseSlug = toSlug(orgName, fastify.log)
  const MAX_ATTEMPTS = 5

  for (let attempt = 0; attempt <= MAX_ATTEMPTS; attempt++) {
    const slug =
      attempt === 0 ? baseSlug : `${baseSlug}-${crypto.randomBytes(4).toString('hex')}`

    try {
      const user = await fastify.prisma.$transaction(async (tx) => {
        const org = await tx.organization.create({ data: { name: orgName, slug } })
        return tx.user.create({
          data: { orgId: org.id, email, name, googleId, avatarUrl, role: 'owner' },
          include: { org: true },
        })
      })
      return user as UserWithOrg
    } catch (err) {
      if (err instanceof PrismaClientKnownRequestError && err.code === 'P2002') {
        // Normalize target to an array — Prisma always provides string[] but guard for
        // possible future format changes so matching doesn't silently stop working.
        const rawTarget = (err.meta as { target?: unknown })?.target
        const targets: string[] = Array.isArray(rawTarget)
          ? rawTarget.map(String)
          : typeof rawTarget === 'string'
          ? [rawTarget]
          : []
        const hasTarget = (field: string) => targets.some((t) => t.includes(field))

        if (hasTarget('slug') && attempt < MAX_ATTEMPTS) continue

        if (hasTarget('googleId')) {
          // A concurrent request just registered this Google account — fetch their record.
          const byId = await fastify.prisma.user.findFirst({
            where: { googleId },
            include: { org: true },
          })
          if (byId) return byId as UserWithOrg
        }

        if (hasTarget('email')) {
          // Concurrent OAuth callback beat us to it — fetch the record they created
          // and link our googleId if it isn't already set.
          const existing = await fastify.prisma.user.findFirst({
            where: { email },
            include: { org: true },
          })
          if (existing) {
            if (!existing.googleId) {
              return await fastify.prisma.user.update({
                where: { id: existing.id },
                data: { googleId },
                include: { org: true },
              }) as UserWithOrg
            }
            return existing as UserWithOrg
          }
          throw Object.assign(new Error('Email already registered'), { statusCode: 409 })
        }
      }
      throw err
    }
  }

  throw Object.assign(new Error('Could not generate a unique org slug'), { statusCode: 409 })
}

// ─── Auth result ──────────────────────────────────────────────────────────────

export type AuthResult =
  | { type: 'redirect'; url: string }
  | { type: 'success'; user: UserWithOrg }
  | { type: 'fail'; message: string }

// Exported as an object so the property assignment inside the plugin is visible to
// all importers via the stable object reference (safe under both CJS and ESM).
export const googleOAuth: {
  authenticate: ((req: FastifyRequest, reply: FastifyReply) => Promise<AuthResult>) | null
} = { authenticate: null }

// ─── Fastify adapter for passport-google-oauth20 ─────────────────────────────
// @fastify/passport has no Fastify v4-compatible release, so we call the
// strategy's authenticate() directly after binding the five Passport outcome
// methods onto it. RedisStateStore replaces the default session-based store so
// no session plugin is required.

const passportPlugin: FastifyPluginAsync = fp(async (fastify) => {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return

  const stateStore = new RedisStateStore(fastify.redis)

  // Cast options to `any` once so TypeScript doesn't fight the `store` property
  // (passport-oauth2 accepts it at runtime but @types/passport-google-oauth20 doesn't expose it).
  const strategyOptions = {
    clientID: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    callbackURL: `${env.APP_URL}/api/v1/auth/google/callback`,
    scope: ['profile', 'email'],
    store: stateStore as OAuth2StateStore,
  } as any // eslint-disable-line @typescript-eslint/no-explicit-any

  const strategy = new GoogleStrategy(
    strategyOptions,
    async (_accessToken: string, _refreshToken: string, profile: Profile, done: (err: Error | null, user?: UserWithOrg) => void) => {
      try {
        const user = await findOrCreateUser(fastify, profile)
        done(null, user)
      } catch (err) {
        done(err as Error)
      }
    },
  )

  googleOAuth.authenticate = (req, _reply) =>
    new Promise<AuthResult>((resolve, reject) => {
      // Each request gets its own context via prototype inheritance from the strategy.
      // This prevents concurrent requests from overwriting each other's outcome methods
      // on the shared strategy instance (which would cause one request's success callback
      // to resolve the other's promise, leaving the first hanging forever).
      const ctx = Object.create(strategy) as PassportStrategyContext

      ctx.success = (user) => resolve({ type: 'success', user })
      // Never expose raw Passport challenge strings — they may contain OAuth error
      // detail from Google (e.g. "invalid_grant") that shouldn't reach callers.
      ctx.fail = (_challenge) => resolve({ type: 'fail', message: 'Authentication failed' })
      ctx.redirect = (url) => resolve({ type: 'redirect', url })
      // pass() means "no strategy handled this request" — should never fire in a
      // single-strategy setup; log it so it's traceable if it does.
      ctx.pass = () => {
        fastify.log.warn('[google-oauth] passport strategy pass() called — no further strategies')
        resolve({ type: 'fail', message: 'Authentication failed' })
      }
      ctx.error = (err) => reject(err)

      // Minimal Express-compatible surface that passport-oauth2 needs.
      // session is a no-op object — state is stored in Redis via RedisStateStore.
      ctx.authenticate(
        {
          query: req.query as Record<string, string>,
          headers: req.headers,
          url: req.url,
          method: req.method,
          connection: { encrypted: env.NODE_ENV === 'production' },
          session: {},
        },
        { scope: ['profile', 'email'] },
      )
    })
})

export default passportPlugin
