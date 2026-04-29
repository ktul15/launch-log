import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { authenticate } from '../middleware/authenticate'
import { env } from '../config/env'

const RATE_LIMIT = env.NODE_ENV === 'test' ? 100_000 : 60
const MUTATE_RATE_LIMIT = env.NODE_ENV === 'test' ? 100_000 : 10

const FEATURE_SELECT_BASE = {
  id: true,
  projectId: true,
  title: true,
  description: true,
  status: true,
  voteCount: true,
  createdAt: true,
  updatedAt: true,
} as const

// submitterEmail is PII — returned only to owners
const FEATURE_SELECT_OWNER = {
  ...FEATURE_SELECT_BASE,
  submitterEmail: true,
} as const

const FEATURE_STATUSES = ['open', 'planned', 'in_progress', 'shipped', 'closed'] as const

const createFeatureSchema = z
  .object({
    title: z.string().min(1, 'Title is required').max(200, 'Title must be at most 200 characters'),
    description: z
      .string()
      .min(1, 'Description must not be empty')
      .max(1000, 'Description must be at most 1000 characters')
      .nullable()
      .optional(),
    status: z.enum(FEATURE_STATUSES).optional(),
  })
  .strict()

const updateFeatureSchema = z
  .object({
    title: z.string().min(1, 'Title is required').max(200, 'Title must be at most 200 characters').optional(),
    description: z
      .string()
      .min(1, 'Description must not be empty')
      .max(1000, 'Description must be at most 1000 characters')
      .nullable()
      .optional(),
    status: z.enum(FEATURE_STATUSES).optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (Object.keys(data).length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'At least one field must be provided' })
    }
  })

const listQuerySchema = z.object({
  status: z.enum(FEATURE_STATUSES).optional(),
})

const uuidSchema = z.string().uuid()
function isUUID(s: string): boolean {
  return uuidSchema.safeParse(s).success
}

export default async function featuresRoutes(fastify: FastifyInstance) {
  // GET /api/v1/projects/:projectId/features — list all, optional ?status= filter
  fastify.get(
    '/:projectId/features',
    {
      onRequest: [authenticate],
      config: { rateLimit: { max: RATE_LIMIT, timeWindow: 60_000 } },
    },
    async (req, reply) => {
      const { orgId, role } = req.user
      const { projectId } = req.params as { projectId: string }

      if (!isUUID(projectId)) {
        return reply.status(404).send({ message: 'Project not found' })
      }

      const parsed = listQuerySchema.safeParse(req.query)
      if (!parsed.success) {
        const messages = parsed.error.issues.map((i) => i.message).join(', ')
        return reply.status(422).send({ message: messages })
      }

      const project = await fastify.prisma.project.findFirst({
        where: { id: projectId, orgId, isActive: true },
        select: { id: true },
      })
      if (!project) {
        return reply.status(404).send({ message: 'Project not found' })
      }

      const features = await fastify.prisma.featureRequest.findMany({
        where: {
          projectId,
          ...(parsed.data.status ? { status: parsed.data.status } : {}),
        },
        select: role === 'owner' ? FEATURE_SELECT_OWNER : FEATURE_SELECT_BASE,
        orderBy: { createdAt: 'desc' },
      })

      return reply.send(features)
    },
  )

  // GET /api/v1/projects/:projectId/features/:featureId — get single feature
  fastify.get(
    '/:projectId/features/:featureId',
    {
      onRequest: [authenticate],
      config: { rateLimit: { max: RATE_LIMIT, timeWindow: 60_000 } },
    },
    async (req, reply) => {
      const { orgId, role } = req.user
      const { projectId, featureId } = req.params as { projectId: string; featureId: string }

      if (!isUUID(projectId) || !isUUID(featureId)) {
        return reply.status(404).send({ message: 'Feature request not found' })
      }

      const project = await fastify.prisma.project.findFirst({
        where: { id: projectId, orgId, isActive: true },
        select: { id: true },
      })
      if (!project) {
        return reply.status(404).send({ message: 'Project not found' })
      }

      const feature = await fastify.prisma.featureRequest.findFirst({
        where: { id: featureId, projectId },
        select: role === 'owner' ? FEATURE_SELECT_OWNER : FEATURE_SELECT_BASE,
      })
      if (!feature) {
        return reply.status(404).send({ message: 'Feature request not found' })
      }

      return reply.send(feature)
    },
  )

  // POST /api/v1/projects/:projectId/features — create feature (owner only)
  fastify.post(
    '/:projectId/features',
    {
      onRequest: [authenticate],
      config: { rateLimit: { max: MUTATE_RATE_LIMIT, timeWindow: 60_000 } },
    },
    async (req, reply) => {
      const { orgId, role } = req.user
      const { projectId } = req.params as { projectId: string }

      if (role !== 'owner') {
        return reply.status(403).send({ message: 'Only organisation owners can create feature requests' })
      }

      if (!isUUID(projectId)) {
        return reply.status(404).send({ message: 'Project not found' })
      }

      const parsed = createFeatureSchema.safeParse(req.body)
      if (!parsed.success) {
        const messages = parsed.error.issues.map((i) => i.message).join(', ')
        return reply.status(422).send({ message: messages })
      }

      const project = await fastify.prisma.project.findFirst({
        where: { id: projectId, orgId, isActive: true },
        select: { id: true },
      })
      if (!project) {
        return reply.status(404).send({ message: 'Project not found' })
      }

      const feature = await fastify.prisma.featureRequest.create({
        data: {
          projectId,
          title: parsed.data.title,
          description: parsed.data.description ?? null,
          status: parsed.data.status ?? 'open',
        },
        select: FEATURE_SELECT_OWNER,
      })

      return reply.status(201).send(feature)
    },
  )

  // PATCH /api/v1/projects/:projectId/features/:featureId — update feature (owner only)
  fastify.patch(
    '/:projectId/features/:featureId',
    {
      onRequest: [authenticate],
      config: { rateLimit: { max: MUTATE_RATE_LIMIT, timeWindow: 60_000 } },
    },
    async (req, reply) => {
      const { orgId, role } = req.user
      const { projectId, featureId } = req.params as { projectId: string; featureId: string }

      if (role !== 'owner') {
        return reply.status(403).send({ message: 'Only organisation owners can update feature requests' })
      }

      if (!isUUID(projectId) || !isUUID(featureId)) {
        return reply.status(404).send({ message: 'Feature request not found' })
      }

      const parsed = updateFeatureSchema.safeParse(req.body)
      if (!parsed.success) {
        const messages = parsed.error.issues.map((i) => i.message).join(', ')
        return reply.status(422).send({ message: messages })
      }

      const project = await fastify.prisma.project.findFirst({
        where: { id: projectId, orgId, isActive: true },
        select: { id: true },
      })
      if (!project) {
        return reply.status(404).send({ message: 'Project not found' })
      }

      const txResult = await fastify.prisma.$transaction(async (tx) => {
        const existing = await tx.featureRequest.findFirst({
          where: { id: featureId, projectId },
          select: { id: true, status: true },
        })
        if (!existing) return null

        const data: Prisma.FeatureRequestUncheckedUpdateInput = {}
        if (parsed.data.title !== undefined) data.title = parsed.data.title
        if ('description' in parsed.data) data.description = parsed.data.description
        if (parsed.data.status !== undefined) data.status = parsed.data.status

        const updated = await tx.featureRequest.update({
          where: { id: featureId, projectId },
          data,
          select: FEATURE_SELECT_OWNER,
        })
        return { previousStatus: existing.status, updated }
      })

      if (!txResult) {
        return reply.status(404).send({ message: 'Feature request not found' })
      }

      const { previousStatus, updated } = txResult

      if (parsed.data.status !== undefined && updated.status !== previousStatus) {
        try {
          await fastify.emailNotificationsQueue.add(
            'feature_status_changed',
            {
              type: 'feature_status_changed',
              referenceId: featureId,
              projectId,
              newStatus: updated.status,
            },
            { jobId: `fsc:${featureId}:${updated.status}` },
          )
        } catch (err) {
          req.log.error({ featureId, err }, 'features: failed to enqueue feature_status_changed job')
        }
      }

      return reply.send(updated)
    },
  )

  // DELETE /api/v1/projects/:projectId/features/:featureId — delete feature (owner only)
  fastify.delete(
    '/:projectId/features/:featureId',
    {
      onRequest: [authenticate],
      config: { rateLimit: { max: MUTATE_RATE_LIMIT, timeWindow: 60_000 } },
    },
    async (req, reply) => {
      const { orgId, role } = req.user
      const { projectId, featureId } = req.params as { projectId: string; featureId: string }

      if (role !== 'owner') {
        return reply.status(403).send({ message: 'Only organisation owners can delete feature requests' })
      }

      if (!isUUID(projectId) || !isUUID(featureId)) {
        return reply.status(404).send({ message: 'Feature request not found' })
      }

      const project = await fastify.prisma.project.findFirst({
        where: { id: projectId, orgId, isActive: true },
        select: { id: true },
      })
      if (!project) {
        return reply.status(404).send({ message: 'Project not found' })
      }

      const result = await fastify.prisma.featureRequest.deleteMany({
        where: { id: featureId, projectId },
      })

      if (result.count === 0) {
        return reply.status(404).send({ message: 'Feature request not found' })
      }

      return reply.status(204).send()
    },
  )
}
