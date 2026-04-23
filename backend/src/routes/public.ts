import crypto from 'crypto'
import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { env } from '../config/env'

const PUBLIC_RATE_LIMIT = env.NODE_ENV === 'test' ? 100_000 : 5

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

const submitFeatureSchema = z
  .object({
    title: z.string().min(1, 'Title is required').max(200, 'Title must be at most 200 characters'),
    description: z
      .string()
      .min(1, 'Description must not be empty')
      .max(1000, 'Description must be at most 1000 characters')
      .nullable()
      .optional(),
    email: z.string().email('Invalid email address'),
  })
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
}
