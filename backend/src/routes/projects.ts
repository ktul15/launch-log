import crypto from 'crypto'
import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/library'
import { authenticate } from '../middleware/authenticate'
import { env } from '../config/env'
import { toSlug } from '../utils/slug'
import { assertPlanLimit, PlanLimitExceededError } from '../utils/planLimits'

const PROJECT_RATE_LIMIT = env.NODE_ENV === 'test' ? 100_000 : 60
const PROJECT_MUTATE_RATE_LIMIT = env.NODE_ENV === 'test' ? 100_000 : 10

// Sentinel strings thrown inside transactions so handlers can map them to HTTP responses.
const TXN_ERR = {
  NOT_FOUND: 'TXN_NOT_FOUND',
} as const

const MAX_SLUG_ATTEMPTS = 5

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
  slug: slugSchema.optional(),
})

const updateProjectSchema = z
  .object({
    name: z
      .string()
      .min(2, 'Project name must be at least 2 characters')
      .max(200, 'Project name must be at most 200 characters')
      .optional(),
    slug: slugSchema.optional(),
    description: z.string().max(500, 'Description must be at most 500 characters').nullable().optional(),
  })
  .superRefine((data, ctx) => {
    if (Object.keys(data).length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'At least one field must be provided' })
    }
  })

const PROJECT_DETAIL_SELECT = {
  id: true,
  name: true,
  slug: true,
  description: true,
  widgetKey: true,
  widgetSettings: true,
  themeSettings: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
} as const

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

      const { name } = parsed.data
      // Auto-generate from name when omitted. Validate the result against slugSchema so a future
      // change to toSlug that produces an invalid string falls back to a guaranteed-safe hex id.
      const rawSlug = parsed.data.slug ?? toSlug(name, fastify.log)
      const baseSlug = slugSchema.safeParse(rawSlug).success ? rawSlug : crypto.randomBytes(4).toString('hex')

      for (let attempt = 1; attempt <= MAX_SLUG_ATTEMPTS; attempt++) {
        const slug = attempt === 1 ? baseSlug : `${baseSlug}-${attempt}`

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

            assertPlanLimit('projects', org.plan, org._count.projects)

            return tx.project.create({
              data: { orgId, name, slug },
              select: { id: true, name: true, slug: true, widgetKey: true, createdAt: true },
            })
          }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })

          return reply.status(201).send(project)
        } catch (err) {
          if (err instanceof PlanLimitExceededError) {
            return reply.status(403).send({ message: 'Project limit reached for your plan' })
          }
          if (err instanceof Error && !(err instanceof PrismaClientKnownRequestError)) {
            if (err.message === TXN_ERR.NOT_FOUND) {
              return reply.status(404).send({ message: 'Organisation not found' })
            }
          }
          if (err instanceof PrismaClientKnownRequestError) {
            if (err.code === 'P2002') {
              // Explicit slug provided — no retry, surface the conflict immediately.
              if (parsed.data.slug) {
                return reply
                  .status(409)
                  .send({ message: 'A project with this slug already exists in your organisation' })
              }
              // Auto-generated slug — retry with suffix.
              if (attempt < MAX_SLUG_ATTEMPTS) continue
              return reply
                .status(409)
                .send({ message: 'Could not generate a unique slug, please specify one manually' })
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
      }
    },
  )

  // GET /api/v1/projects — list active projects for the org
  fastify.get(
    '/',
    {
      onRequest: [authenticate],
      config: { rateLimit: { max: PROJECT_RATE_LIMIT, timeWindow: 60_000 } },
    },
    async (req, reply) => {
      const { orgId } = req.user

      const projects = await fastify.prisma.project.findMany({
        where: { orgId, isActive: true },
        select: {
          id: true,
          name: true,
          slug: true,
          description: true,
          widgetKey: true,
          createdAt: true,
          _count: { select: { changelogEntries: true, roadmapItems: true } },
        },
        orderBy: { createdAt: 'asc' },
      })

      return reply.send(projects)
    },
  )

  // GET /api/v1/projects/:id — get single active project detail
  fastify.get(
    '/:id',
    {
      onRequest: [authenticate],
      config: { rateLimit: { max: PROJECT_RATE_LIMIT, timeWindow: 60_000 } },
    },
    async (req, reply) => {
      const { orgId } = req.user
      const { id } = req.params as { id: string }

      const project = await fastify.prisma.project.findFirst({
        where: { id, orgId, isActive: true },
        select: PROJECT_DETAIL_SELECT,
      })

      if (!project) {
        return reply.status(404).send({ message: 'Project not found' })
      }

      return reply.send(project)
    },
  )

  // PATCH /api/v1/projects/:id — update project (owner only)
  fastify.patch(
    '/:id',
    {
      onRequest: [authenticate],
      config: { rateLimit: { max: PROJECT_MUTATE_RATE_LIMIT, timeWindow: 60_000 } },
    },
    async (req, reply) => {
      const { orgId, role } = req.user
      const { id } = req.params as { id: string }

      if (role !== 'owner') {
        return reply.status(403).send({ message: 'Only organisation owners can update projects' })
      }

      const parsed = updateProjectSchema.safeParse(req.body)
      if (!parsed.success) {
        const messages = parsed.error.issues.map((i) => i.message).join(', ')
        return reply.status(422).send({ message: messages })
      }

      try {
        // Transaction makes the org-ownership check and the write atomic — eliminates the TOCTOU
        // window that exists when findFirst and update run as separate DB round-trips.
        const project = await fastify.prisma.$transaction(async (tx) => {
          const existing = await tx.project.findFirst({
            where: { id, orgId, isActive: true },
            select: { id: true },
          })
          if (!existing) return null
          return tx.project.update({
            where: { id },
            data: parsed.data,
            select: PROJECT_DETAIL_SELECT,
          })
        })

        if (!project) {
          return reply.status(404).send({ message: 'Project not found' })
        }

        return reply.send(project)
      } catch (err) {
        if (err instanceof PrismaClientKnownRequestError && err.code === 'P2002') {
          // Only the (orgId, slug) unique constraint is expected here. If a different constraint
          // fires, target won't contain 'slug' and we rethrow rather than misreport the error.
          const target = String(err.meta?.target ?? '')
          if (target.includes('slug')) {
            return reply
              .status(409)
              .send({ message: 'A project with this slug already exists in your organisation' })
          }
          throw err
        }
        throw err
      }
    },
  )

  // DELETE /api/v1/projects/:id — delete project (owner only)
  fastify.delete(
    '/:id',
    {
      onRequest: [authenticate],
      config: { rateLimit: { max: PROJECT_MUTATE_RATE_LIMIT, timeWindow: 60_000 } },
    },
    async (req, reply) => {
      const { orgId, role } = req.user
      const { id } = req.params as { id: string }

      if (role !== 'owner') {
        return reply.status(403).send({ message: 'Only organisation owners can delete projects' })
      }

      // deleteMany with id+orgId enforces org-scoped ownership atomically — no separate findFirst
      // needed, eliminating the TOCTOU window of a find-then-delete pattern.
      const result = await fastify.prisma.project.deleteMany({
        where: { id, orgId },
      })

      if (result.count === 0) {
        return reply.status(404).send({ message: 'Project not found' })
      }

      return reply.status(204).send()
    },
  )
}
