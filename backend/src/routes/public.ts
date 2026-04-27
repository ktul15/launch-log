import crypto from 'crypto'
import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { env } from '../config/env'

const PUBLIC_RATE_LIMIT = env.NODE_ENV === 'test' ? 100_000 : 5
// Higher limit than submit/vote — SSR server is a single shared IP for all page renders.
// With 60s revalidation on the frontend, real backend call rate is ~1/min/project.
const PAGE_RATE_LIMIT = env.NODE_ENV === 'test' ? 100_000 : 120
const PAGE_LIST_LIMIT = 50
// Verify-vote is a click-from-email flow — more generous limit than submit/vote
// to avoid blocking users behind shared NAT from verifying their own vote.
const VERIFY_VOTE_RATE_LIMIT = env.NODE_ENV === 'test' ? 100_000 : 30
// Per-email rate limit on the upvote endpoint. Complements IP-based limiting: an attacker
// rotating IPs can't bypass this to probe whether a given email has already voted (verified).
const EMAIL_VOTE_RATE_LIMIT = env.NODE_ENV === 'test' ? 100_000 : 3
const FORTY_EIGHT_HOURS_MS = 48 * 60 * 60 * 1000

const SUBSCRIBE_RATE_LIMIT = env.NODE_ENV === 'test' ? 100_000 : 5
const VERIFY_SUBSCRIBE_RATE_LIMIT = env.NODE_ENV === 'test' ? 100_000 : 30
const UNSUBSCRIBE_RATE_LIMIT = env.NODE_ENV === 'test' ? 100_000 : 30

const FEATURE_SELECT_PUBLIC = {
  id: true,
  projectId: true,
  title: true,
  description: true,
  status: true,
  voteCount: true,
  createdAt: true,
  updatedAt: true,
} as const

type PublicFeature = Prisma.FeatureRequestGetPayload<{ select: typeof FEATURE_SELECT_PUBLIC }>

const PROJECT_KEY_MAX_LEN = 64
const FEATURE_ID_MAX_LEN = 36
const VERIFY_TOKEN_MAX_LEN = 128

const uuidSchema = z.string().uuid()
function isUUID(s: string): boolean {
  return uuidSchema.safeParse(s).success
}

const submitFeatureSchema = z
  .object({
    title: z.string().min(1, 'Title is required').max(200, 'Title must be at most 200 characters'),
    description: z
      .string()
      .min(1, 'Description must not be empty')
      .max(1000, 'Description must be at most 1000 characters')
      .nullable()
      .optional(),
    email: z
      .string()
      .email('Invalid email address')
      .transform((s) => s.toLowerCase()),
  })
  .strict()

const voteSchema = z
  .object({
    email: z
      .string()
      .email('Invalid email address')
      .transform((s) => s.toLowerCase()),
  })
  .strict()

const verifyVoteSchema = z
  .object({ token: z.string().min(1, 'Token is required').max(VERIFY_TOKEN_MAX_LEN, 'Invalid token') })
  .strict()

const subscribeSchema = z
  .object({
    email: z
      .string()
      .email('Invalid email address')
      .transform((s) => s.toLowerCase()),
  })
  .strict()

const tokenQuerySchema = z
  .object({ token: z.string().min(1, 'Token is required').max(VERIFY_TOKEN_MAX_LEN, 'Invalid token') })
  .strict()

// HMAC-SHA256 with the server JWT secret — one-way and not reversible without the key.
// Returns null when IP is absent (e.g. tests via inject with no remote address).
function hashIp(ip: string | undefined): string | null {
  if (!ip) return null
  return crypto.createHmac('sha256', env.JWT_SECRET).update(ip).digest('hex')
}

export default async function publicRoutes(fastify: FastifyInstance) {
  fastify.post(
    '/:projectKey/features',
    {
      config: { rateLimit: { max: PUBLIC_RATE_LIMIT, timeWindow: 3_600_000 } },
    },
    async (req, reply) => {
      const { projectKey } = req.params as { projectKey: string }

      if (projectKey.length > PROJECT_KEY_MAX_LEN) {
        return reply.status(404).send({ message: 'Project not found' })
      }

      const parsed = submitFeatureSchema.safeParse(req.body)
      if (!parsed.success) {
        const messages = parsed.error.issues.map((i) => i.message).join(', ')
        return reply.status(400).send({ message: messages })
      }

      const { title, description, email } = parsed.data

      const project = await fastify.prisma.project.findUnique({
        where: { widgetKey: projectKey },
        select: { id: true },
      })
      if (!project) {
        return reply.status(404).send({ message: 'Project not found' })
      }

      const verificationToken = crypto.randomUUID()
      const ipHash = hashIp(req.ip)

      let feature: PublicFeature
      let voteId: string

      try {
        const result = await fastify.prisma.$transaction(async (tx) => {
          const f = await tx.featureRequest.create({
            data: { projectId: project.id, title, description: description ?? null, submitterEmail: email },
            select: FEATURE_SELECT_PUBLIC,
          })
          const v = await tx.vote.create({
            data: {
              featureRequestId: f.id,
              voterEmail: email,
              verified: false,
              verificationToken,
              ipHash,
            },
            select: { id: true },
          })
          return { feature: f, voteId: v.id }
        })
        feature = result.feature
        voteId = result.voteId
      } catch (err) {
        // P2003 = foreign key constraint: project was deleted between lookup and insert
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2003') {
          return reply.status(404).send({ message: 'Project not found' })
        }
        throw err
      }

      try {
        await fastify.notificationQueue.add('vote_verification', {
          type: 'vote_verification',
          referenceId: voteId,
          projectId: project.id,
        })
      } catch (err) {
        req.log.error({ voteId, err }, 'public: failed to enqueue vote_verification — vote exists but email will not be sent')
      }

      return reply.status(201).send(feature)
    },
  )

  // POST /:projectKey/features/:featureId/vote
  fastify.post(
    '/:projectKey/features/:featureId/vote',
    {
      config: { rateLimit: { max: PUBLIC_RATE_LIMIT, timeWindow: 3_600_000 } },
    },
    async (req, reply) => {
      const { projectKey, featureId } = req.params as { projectKey: string; featureId: string }

      if (projectKey.length > PROJECT_KEY_MAX_LEN) {
        return reply.status(404).send({ message: 'Project not found' })
      }

      if (featureId.length > FEATURE_ID_MAX_LEN || !isUUID(featureId)) {
        return reply.status(404).send({ message: 'Feature not found' })
      }

      const parsed = voteSchema.safeParse(req.body)
      if (!parsed.success) {
        const messages = parsed.error.issues.map((i) => i.message).join(', ')
        return reply.status(400).send({ message: messages })
      }

      const { email } = parsed.data

      const project = await fastify.prisma.project.findUnique({
        where: { widgetKey: projectKey },
        select: { id: true },
      })
      if (!project) {
        return reply.status(404).send({ message: 'Project not found' })
      }

      // Reject votes on closed or shipped features — status is no longer actionable
      const feature = await fastify.prisma.featureRequest.findFirst({
        where: { id: featureId, projectId: project.id, status: { notIn: ['closed', 'shipped'] } },
        select: { id: true },
      })
      if (!feature) {
        return reply.status(404).send({ message: 'Feature not found' })
      }

      // Per-email rate limit — prevents IP-rotation attacks from probing vote/verified status
      // via the differentiated 409 messages. Fail open if Redis is unavailable.
      const emailHash = crypto.createHmac('sha256', env.JWT_SECRET).update(email).digest('hex')
      const emailRlKey = `rl:vote:email:${emailHash}`
      try {
        const attempts = await fastify.redis.incr(emailRlKey)
        if (attempts === 1) {
          await fastify.redis.expire(emailRlKey, 3600)
        }
        if (attempts > EMAIL_VOTE_RATE_LIMIT) {
          return reply.status(429).send({ statusCode: 429, error: 'Too Many Requests', message: 'Rate limit exceeded. Retry after 1h' })
        }
      } catch (err) {
        req.log.warn({ err }, 'vote: email rate-limit Redis check failed — skipping check')
      }

      const existingVote = await fastify.prisma.vote.findUnique({
        where: { featureRequestId_voterEmail: { featureRequestId: feature.id, voterEmail: email } },
        select: { verified: true },
      })

      if (existingVote) {
        const message = existingVote.verified
          ? 'You have already voted for this feature.'
          : 'A verification email has already been sent. Please check your inbox.'
        return reply.status(409).send({ statusCode: 409, error: 'Conflict', message })
      }

      const verificationToken = crypto.randomUUID()
      const ipHash = hashIp(req.ip)

      let voteId: string

      try {
        const vote = await fastify.prisma.vote.create({
          data: {
            featureRequestId: feature.id,
            voterEmail: email,
            verified: false,
            verificationToken,
            ipHash,
          },
          select: { id: true },
        })
        voteId = vote.id
      } catch (err) {
        // Safety net for the race window between the pre-check and the insert.
        // Re-query to return the same context-aware message as the pre-check path.
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          const raceVote = await fastify.prisma.vote.findUnique({
            where: { featureRequestId_voterEmail: { featureRequestId: feature.id, voterEmail: email } },
            select: { verified: true },
          })
          const message = raceVote?.verified
            ? 'You have already voted for this feature.'
            : 'A verification email has already been sent. Please check your inbox.'
          return reply.status(409).send({ statusCode: 409, error: 'Conflict', message })
        }
        throw err
      }

      try {
        await fastify.notificationQueue.add('vote_verification', {
          type: 'vote_verification',
          referenceId: voteId,
          projectId: project.id,
        })
      } catch (err) {
        req.log.error({ voteId, err }, 'public: failed to enqueue vote_verification — vote exists but email will not be sent')
      }

      return reply.status(200).send({ message: 'Verification email sent' })
    },
  )

  // GET /verify-vote
  fastify.get(
    '/verify-vote',
    {
      config: { rateLimit: { max: VERIFY_VOTE_RATE_LIMIT, timeWindow: 3_600_000 } },
    },
    async (req, reply) => {
      const parsed = verifyVoteSchema.safeParse(req.query)
      if (!parsed.success) {
        const messages = parsed.error.issues.map((i) => i.message).join(', ')
        return reply.status(400).send({ message: messages })
      }

      const { token } = parsed.data

      const vote = await fastify.prisma.vote.findUnique({
        where: { verificationToken: token },
        select: { id: true, featureRequestId: true, createdAt: true },
      })

      if (!vote) {
        return reply.status(400).send({ message: 'Invalid or expired token' })
      }

      if (Date.now() - vote.createdAt.getTime() > FORTY_EIGHT_HOURS_MS) {
        // Delete the unverified vote so the user can cast a new vote
        await fastify.prisma.vote.deleteMany({ where: { id: vote.id, verified: false } })
        req.log.info({ voteId: vote.id }, 'vote: verification token expired — vote deleted, user can re-vote')
        return reply.status(400).send({ message: 'Invalid or expired token' })
      }

      const expiryThreshold = new Date(Date.now() - FORTY_EIGHT_HOURS_MS)

      // Transaction: verify the vote AND increment voteCount atomically.
      // The WHERE clause also includes the expiry threshold to handle the edge case where
      // the token crosses the 48h boundary between the check above and this update.
      // Atomic gate: only one concurrent request wins the UPDATE WHERE verified = false.
      const { alreadyVerified } = await fastify.prisma.$transaction(async (tx) => {
        const updated = await tx.vote.updateMany({
          where: { id: vote.id, verified: false, createdAt: { gte: expiryThreshold } },
          data: { verified: true },
        })

        if (updated.count === 0) {
          return { alreadyVerified: true }
        }

        await tx.featureRequest.update({
          where: { id: vote.featureRequestId },
          data: { voteCount: { increment: 1 } },
        })

        return { alreadyVerified: false }
      })

      if (alreadyVerified) {
        return reply.status(200).send({ message: 'Already verified' })
      }

      return reply.status(200).send({ message: 'Vote verified' })
    },
  )

  // GET /resolve/:orgSlug/:projectSlug — slug-based resolution for SSR public pages.
  // Single DB query via relation filter — no id exposed in response.
  fastify.get(
    '/resolve/:orgSlug/:projectSlug',
    {
      config: { rateLimit: { max: PAGE_RATE_LIMIT, timeWindow: 3_600_000 } },
    },
    async (req, reply) => {
      const { orgSlug, projectSlug } = req.params as { orgSlug: string; projectSlug: string }

      if (orgSlug.length > 100 || projectSlug.length > 100) {
        return reply.status(404).send({ message: 'Project not found' })
      }

      const project = await fastify.prisma.project.findFirst({
        where: { slug: projectSlug, isActive: true, org: { slug: orgSlug } },
        select: {
          name: true,
          slug: true,
          description: true,
          widgetKey: true,
          org: { select: { name: true } },
        },
      })
      if (!project) return reply.status(404).send({ message: 'Project not found' })

      return reply.send({
        name: project.name,
        slug: project.slug,
        description: project.description,
        widgetKey: project.widgetKey,
        orgName: project.org.name,
      })
    },
  )

  // GET /:projectKey/changelog — published entries for public page
  fastify.get(
    '/:projectKey/changelog',
    {
      config: { rateLimit: { max: PAGE_RATE_LIMIT, timeWindow: 3_600_000 } },
    },
    async (req, reply) => {
      const { projectKey } = req.params as { projectKey: string }

      if (projectKey.length > PROJECT_KEY_MAX_LEN) {
        return reply.status(404).send({ message: 'Project not found' })
      }

      const project = await fastify.prisma.project.findUnique({
        where: { widgetKey: projectKey, isActive: true },
        select: { id: true },
      })
      if (!project) return reply.status(404).send({ message: 'Project not found' })

      const entries = await fastify.prisma.changelogEntry.findMany({
        where: { projectId: project.id, status: 'published' },
        orderBy: { publishedAt: 'desc' },
        take: PAGE_LIST_LIMIT,
        select: { id: true, title: true, version: true, status: true, publishedAt: true, categoryId: true },
      })

      return reply.send(entries)
    },
  )

  // GET /:projectKey/changelog/:entryId — single published entry with content
  fastify.get(
    '/:projectKey/changelog/:entryId',
    {
      config: { rateLimit: { max: PAGE_RATE_LIMIT, timeWindow: 3_600_000 } },
    },
    async (req, reply) => {
      const { projectKey, entryId } = req.params as { projectKey: string; entryId: string }

      if (projectKey.length > PROJECT_KEY_MAX_LEN) {
        return reply.status(404).send({ message: 'Project not found' })
      }

      const project = await fastify.prisma.project.findUnique({
        where: { widgetKey: projectKey, isActive: true },
        select: { id: true },
      })
      if (!project) return reply.status(404).send({ message: 'Project not found' })

      const entry = await fastify.prisma.changelogEntry.findUnique({
        where: { id: entryId, projectId: project.id, status: 'published' },
        select: { id: true, title: true, version: true, status: true, publishedAt: true, categoryId: true, content: true },
      })
      if (!entry) return reply.status(404).send({ message: 'Entry not found' })

      return reply.send(entry)
    },
  )

  // GET /:projectKey/roadmap — all roadmap items for public page
  fastify.get(
    '/:projectKey/roadmap',
    {
      config: { rateLimit: { max: PAGE_RATE_LIMIT, timeWindow: 3_600_000 } },
    },
    async (req, reply) => {
      const { projectKey } = req.params as { projectKey: string }

      if (projectKey.length > PROJECT_KEY_MAX_LEN) {
        return reply.status(404).send({ message: 'Project not found' })
      }

      const project = await fastify.prisma.project.findUnique({
        where: { widgetKey: projectKey, isActive: true },
        select: { id: true },
      })
      if (!project) return reply.status(404).send({ message: 'Project not found' })

      const items = await fastify.prisma.roadmapItem.findMany({
        where: { projectId: project.id },
        orderBy: [{ status: 'asc' }, { displayOrder: 'asc' }],
        take: PAGE_LIST_LIMIT,
        select: { id: true, title: true, description: true, status: true, displayOrder: true },
      })

      return reply.send(items)
    },
  )

  // GET /:projectKey/features — open/active feature requests for public page
  fastify.get(
    '/:projectKey/features',
    {
      config: { rateLimit: { max: PAGE_RATE_LIMIT, timeWindow: 3_600_000 } },
    },
    async (req, reply) => {
      const { projectKey } = req.params as { projectKey: string }

      if (projectKey.length > PROJECT_KEY_MAX_LEN) {
        return reply.status(404).send({ message: 'Project not found' })
      }

      const project = await fastify.prisma.project.findUnique({
        where: { widgetKey: projectKey, isActive: true },
        select: { id: true },
      })
      if (!project) return reply.status(404).send({ message: 'Project not found' })

      const features = await fastify.prisma.featureRequest.findMany({
        where: { projectId: project.id, status: { notIn: ['closed', 'shipped'] } },
        orderBy: { voteCount: 'desc' },
        take: PAGE_LIST_LIMIT,
        select: FEATURE_SELECT_PUBLIC,
      })

      return reply.send(features)
    },
  )

  // POST /:projectKey/subscribe — subscribe email to project updates
  fastify.post(
    '/:projectKey/subscribe',
    {
      config: { rateLimit: { max: SUBSCRIBE_RATE_LIMIT, timeWindow: 3_600_000 } },
    },
    async (req, reply) => {
      const { projectKey } = req.params as { projectKey: string }

      if (projectKey.length > PROJECT_KEY_MAX_LEN) {
        return reply.status(404).send({ message: 'Project not found' })
      }

      const parsed = subscribeSchema.safeParse(req.body)
      if (!parsed.success) {
        const messages = parsed.error.issues.map((i) => i.message).join(', ')
        return reply.status(400).send({ message: messages })
      }

      const { email } = parsed.data

      const project = await fastify.prisma.project.findUnique({
        where: { widgetKey: projectKey, isActive: true },
        select: { id: true },
      })
      if (!project) {
        return reply.status(404).send({ message: 'Project not found' })
      }

      // Check for an existing subscriber record before upserting to decide the response status.
      const existing = await fastify.prisma.subscriber.findUnique({
        where: { projectId_email: { projectId: project.id, email } },
        select: { id: true, verified: true },
      })

      if (existing?.verified) {
        return reply.status(200).send({ status: 'already_subscribed' })
      }

      // Upsert — create new or leave existing unverified record in place (token preserved for resend).
      const subscriber = await fastify.prisma.subscriber.upsert({
        where: { projectId_email: { projectId: project.id, email } },
        create: {
          projectId: project.id,
          email,
          verified: false,
          verificationToken: crypto.randomUUID(),
        },
        update: {},
        select: { id: true },
      })

      try {
        await fastify.notificationQueue.add('subscribe_verification', {
          type: 'subscribe_verification',
          referenceId: subscriber.id,
          projectId: project.id,
        })
      } catch (err) {
        req.log.error({ subscriberId: subscriber.id, err }, 'public: failed to enqueue subscribe_verification — subscriber exists but email will not be sent')
      }

      return reply.status(200).send({ status: 'verification_sent' })
    },
  )

  // GET /verify-subscribe — verify subscriber email via token link
  fastify.get(
    '/verify-subscribe',
    {
      config: { rateLimit: { max: VERIFY_SUBSCRIBE_RATE_LIMIT, timeWindow: 3_600_000 } },
    },
    async (req, reply) => {
      const parsed = tokenQuerySchema.safeParse(req.query)
      if (!parsed.success) {
        const messages = parsed.error.issues.map((i) => i.message).join(', ')
        return reply.status(400).send({ message: messages })
      }

      const { token } = parsed.data

      const subscriber = await fastify.prisma.subscriber.findUnique({
        where: { verificationToken: token },
        select: { id: true, verified: true },
      })

      if (!subscriber) {
        return reply.status(400).send({ message: 'Invalid token' })
      }

      if (subscriber.verified) {
        return reply.status(200).send({ verified: true })
      }

      // Atomic gate: WHERE verified = false ensures concurrent requests don't both "win".
      // count === 0 means a concurrent request already verified — result is the same either way.
      await fastify.prisma.subscriber.updateMany({
        where: { id: subscriber.id, verified: false },
        data: { verified: true },
      })

      return reply.status(200).send({ verified: true })
    },
  )

  // GET /unsubscribe — remove subscriber by token (included in all notification emails)
  fastify.get(
    '/unsubscribe',
    {
      config: { rateLimit: { max: UNSUBSCRIBE_RATE_LIMIT, timeWindow: 3_600_000 } },
    },
    async (req, reply) => {
      const parsed = tokenQuerySchema.safeParse(req.query)
      if (!parsed.success) {
        const messages = parsed.error.issues.map((i) => i.message).join(', ')
        return reply.status(400).send({ message: messages })
      }

      const { token } = parsed.data

      const subscriber = await fastify.prisma.subscriber.findUnique({
        where: { verificationToken: token },
        select: { id: true },
      })

      // Treat unknown token as already-unsubscribed — idempotent so email prefetch scanners
      // (Gmail, Apple Mail) don't cause an error on the user's real click.
      if (!subscriber) {
        return reply.status(200).send({ unsubscribed: true })
      }

      await fastify.prisma.subscriber.delete({ where: { id: subscriber.id } })

      return reply.status(200).send({ unsubscribed: true })
    },
  )
}
