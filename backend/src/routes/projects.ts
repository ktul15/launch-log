import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/library'
import { authenticate } from '../middleware/authenticate'
import { env } from '../config/env'

const PROJECT_RATE_LIMIT = env.NODE_ENV === 'test' ? 100_000 : 60
const PROJECT_MUTATE_RATE_LIMIT = env.NODE_ENV === 'test' ? 100_000 : 10

const PLAN_PROJECT_LIMITS: Record<string, number> = {
  free: 1,
  starter: 3,
  pro: Infinity,
}

// Sentinel strings thrown inside transactions so handlers can map them to HTTP responses.
const TXN_ERR = {
  NOT_FOUND: 'TXN_NOT_FOUND',
  UNKNOWN_PLAN: 'TXN_UNKNOWN_PLAN',
  PLAN_LIMIT: 'TXN_PLAN_LIMIT',
} as const

// Allows single alphanumeric or 2+ chars; no leading/trailing hyphens.
const slugSchema = z
  .string()
  .min(2, 'Slug must be at least 2 characters')
  .max(100, 'Slug must be at most 100 characters')
  .regex(
    /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/,
    'Slug must be lowercase alphanumeric with hyphens, no leading or trailing hyphen',
  )

const createProjectSchema = z.object({
  name: z
    .string()
    .min(2, 'Project name must be at least 2 characters')
    .max(200, 'Project name must be at most 200 characters'),
  slug: slugSchema,
})

export default async function projectRoutes(fastify: FastifyInstance) {
  // POST /api/v1/projects — create a new project (owner only)
  fastify.post(
    '/',
    {
      onRequest: [authenticate],
      config: { rateLimit: { max: PROJECT_MUTATE_RATE_LIMIT, timeWindow: 60_000 } },
    },
    async (req, reply) => {
      const { orgId, role } = req.user

      if (role !== 'owner') {
        return reply.status(403).send({ message: 'Only organisation owners can create projects' })
      }

      const parsed = createProjectSchema.safeParse(req.body)
      if (!parsed.success) {
        const messages = parsed.error.issues.map((i) => i.message).join(', ')
        return reply.status(422).send({ message: messages })
      }

      const { name, slug } = parsed.data

      try {
        // Serializable transaction prevents race conditions where two concurrent requests
        // both read count=0, pass the limit check, and both insert — exceeding the plan limit.
        const project = await fastify.prisma.$transaction(async (tx) => {
          const org = await tx.organization.findUnique({
            where: { id: orgId },
            select: {
              plan: true,
              _count: { select: { projects: { where: { isActive: true } } } },
            },
          })

          if (!org) throw new Error(TXN_ERR.NOT_FOUND)

          const limit = PLAN_PROJECT_LIMITS[org.plan]
          if (limit === undefined) throw new Error(TXN_ERR.UNKNOWN_PLAN)
          if (org._count.projects >= limit) throw new Error(TXN_ERR.PLAN_LIMIT)

          return tx.project.create({
            data: { orgId, name, slug },
            select: { id: true, name: true, slug: true, widgetKey: true, createdAt: true },
          })
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })

        return reply.status(201).send(project)
      } catch (err) {
        if (err instanceof Error) {
          if (err.message === TXN_ERR.NOT_FOUND) {
            return reply.status(404).send({ message: 'Organisation not found' })
          }
          if (err.message === TXN_ERR.UNKNOWN_PLAN) {
            return reply.status(500).send({ message: 'Unknown plan configuration' })
          }
          if (err.message === TXN_ERR.PLAN_LIMIT) {
            return reply.status(403).send({ message: 'Project limit reached for your plan' })
          }
        }
        if (err instanceof PrismaClientKnownRequestError) {
          // P2002: duplicate slug — Prisma re-throws KnownRequestError unchanged from inside
          // $transaction, so the code and type are preserved (verified by the duplicate-slug test).
          if (err.code === 'P2002') {
            return reply
              .status(409)
              .send({ message: 'A project with this slug already exists in your organisation' })
          }
          // P2034: serialization failure from concurrent requests racing past the plan limit check.
          // Returning 409 is intentional — the client should retry. No server-side retry loop to
          // avoid thundering-herd on the same org.
          if (err.code === 'P2034') {
            return reply.status(409).send({ message: 'Request conflicted, please retry' })
          }
        }
        throw err
      }
    },
  )

  // GET /api/v1/projects — list projects for the org
  fastify.get(
    '/',
    {
      onRequest: [authenticate],
      config: { rateLimit: { max: PROJECT_RATE_LIMIT, timeWindow: 60_000 } },
    },
    async (req, reply) => {
      const { orgId } = req.user

      const projects = await fastify.prisma.project.findMany({
        where: { orgId },
        select: { id: true, name: true, slug: true, widgetKey: true, createdAt: true },
        orderBy: { createdAt: 'asc' },
      })

      return reply.send(projects)
    },
  )
}
