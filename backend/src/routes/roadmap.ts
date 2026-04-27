import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { authenticate } from '../middleware/authenticate'
import { env } from '../config/env'

const RATE_LIMIT = env.NODE_ENV === 'test' ? 100_000 : 60
const MUTATE_RATE_LIMIT = env.NODE_ENV === 'test' ? 100_000 : 10

const ITEM_SELECT = {
  id: true,
  projectId: true,
  title: true,
  description: true,
  status: true,
  displayOrder: true,
  createdBy: true,
  createdAt: true,
  updatedAt: true,
} as const

const createItemSchema = z.object({
  title: z.string().min(1, 'Title is required').max(200, 'Title must be at most 200 characters'),
  description: z.string().max(1000, 'Description must be at most 1000 characters').nullable().optional(),
  status: z.enum(['planned', 'in_progress', 'shipped']).optional(),
})

const updateItemSchema = z
  .object({
    title: z.string().min(1, 'Title is required').max(200, 'Title must be at most 200 characters').optional(),
    description: z.string().max(1000, 'Description must be at most 1000 characters').nullable().optional(),
    status: z.enum(['planned', 'in_progress', 'shipped']).optional(),
  })
  .superRefine((data, ctx) => {
    if (Object.keys(data).length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'At least one field must be provided' })
    }
  })

const listQuerySchema = z.object({
  status: z.enum(['planned', 'in_progress', 'shipped']).optional(),
})

const reorderSchema = z.object({
  items: z
    .array(
      z.object({
        id: z.string().uuid('Invalid item ID'),
        displayOrder: z.number().int('displayOrder must be an integer').min(0).max(2147483647, 'displayOrder exceeds maximum value'),
      }),
    )
    .min(1, 'At least one item must be provided'),
})

const uuidSchema = z.string().uuid()
function isUUID(s: string): boolean {
  return uuidSchema.safeParse(s).success
}

export default async function roadmapRoutes(fastify: FastifyInstance) {
  // GET /api/v1/projects/:projectId/roadmap — list items, optional ?status= filter
  fastify.get(
    '/:projectId/roadmap',
    {
      onRequest: [authenticate],
      config: { rateLimit: { max: RATE_LIMIT, timeWindow: 60_000 } },
    },
    async (req, reply) => {
      const { orgId } = req.user
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

      const items = await fastify.prisma.roadmapItem.findMany({
        where: {
          projectId,
          ...(parsed.data.status ? { status: parsed.data.status } : {}),
        },
        select: ITEM_SELECT,
        orderBy: [{ displayOrder: 'asc' }, { createdAt: 'asc' }],
      })

      return reply.send(items)
    },
  )

  // GET /api/v1/projects/:projectId/roadmap/:itemId — get single item
  fastify.get(
    '/:projectId/roadmap/:itemId',
    {
      onRequest: [authenticate],
      config: { rateLimit: { max: RATE_LIMIT, timeWindow: 60_000 } },
    },
    async (req, reply) => {
      const { orgId } = req.user
      const { projectId, itemId } = req.params as { projectId: string; itemId: string }

      if (!isUUID(projectId) || !isUUID(itemId)) {
        return reply.status(404).send({ message: 'Roadmap item not found' })
      }

      const project = await fastify.prisma.project.findFirst({
        where: { id: projectId, orgId, isActive: true },
        select: { id: true },
      })
      if (!project) {
        return reply.status(404).send({ message: 'Project not found' })
      }

      const item = await fastify.prisma.roadmapItem.findFirst({
        where: { id: itemId, projectId },
        select: ITEM_SELECT,
      })
      if (!item) {
        return reply.status(404).send({ message: 'Roadmap item not found' })
      }

      return reply.send(item)
    },
  )

  // POST /api/v1/projects/:projectId/roadmap — create item (owner only)
  fastify.post(
    '/:projectId/roadmap',
    {
      onRequest: [authenticate],
      config: { rateLimit: { max: MUTATE_RATE_LIMIT, timeWindow: 60_000 } },
    },
    async (req, reply) => {
      const { orgId, role, sub: userId } = req.user
      const { projectId } = req.params as { projectId: string }

      if (role !== 'owner') {
        return reply.status(403).send({ message: 'Only organisation owners can create roadmap items' })
      }

      if (!isUUID(projectId)) {
        return reply.status(404).send({ message: 'Project not found' })
      }

      const parsed = createItemSchema.safeParse(req.body)
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

      // Count + create in a transaction so displayOrder assignment is atomic.
      const item = await fastify.prisma.$transaction(async (tx) => {
        const count = await tx.roadmapItem.count({ where: { projectId } })
        return tx.roadmapItem.create({
          data: {
            projectId,
            title: parsed.data.title,
            description: parsed.data.description ?? null,
            status: parsed.data.status ?? 'planned',
            displayOrder: count,
            createdBy: userId,
          },
          select: ITEM_SELECT,
        })
      })

      return reply.status(201).send(item)
    },
  )

  // PATCH /api/v1/projects/:projectId/roadmap/reorder — bulk update displayOrder (owner only)
  // Must be registered before /:itemId so "reorder" is not matched as an itemId param.
  fastify.patch(
    '/:projectId/roadmap/reorder',
    {
      onRequest: [authenticate],
      config: { rateLimit: { max: MUTATE_RATE_LIMIT, timeWindow: 60_000 } },
    },
    async (req, reply) => {
      const { orgId, role } = req.user
      const { projectId } = req.params as { projectId: string }

      if (role !== 'owner') {
        return reply.status(403).send({ message: 'Only organisation owners can reorder roadmap items' })
      }

      if (!isUUID(projectId)) {
        return reply.status(404).send({ message: 'Project not found' })
      }

      const parsed = reorderSchema.safeParse(req.body)
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

      // updateMany scopes each write to projectId so cross-project items are silently skipped
      // (count reflects only items that actually belong to this project).
      const results = await fastify.prisma.$transaction(
        parsed.data.items.map(({ id, displayOrder }) =>
          fastify.prisma.roadmapItem.updateMany({
            where: { id, projectId },
            data: { displayOrder },
          }),
        ),
      )

      const updated = results.reduce((sum, r) => sum + r.count, 0)
      return reply.send({ updated })
    },
  )

  // PATCH /api/v1/projects/:projectId/roadmap/:itemId — update item (owner only)
  fastify.patch(
    '/:projectId/roadmap/:itemId',
    {
      onRequest: [authenticate],
      config: { rateLimit: { max: MUTATE_RATE_LIMIT, timeWindow: 60_000 } },
    },
    async (req, reply) => {
      const { orgId, role } = req.user
      const { projectId, itemId } = req.params as { projectId: string; itemId: string }

      if (role !== 'owner') {
        return reply.status(403).send({ message: 'Only organisation owners can update roadmap items' })
      }

      if (!isUUID(projectId) || !isUUID(itemId)) {
        return reply.status(404).send({ message: 'Roadmap item not found' })
      }

      const parsed = updateItemSchema.safeParse(req.body)
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

      const result = await fastify.prisma.$transaction(async (tx) => {
        const existing = await tx.roadmapItem.findFirst({
          where: { id: itemId, projectId },
          select: { id: true, status: true },
        })
        if (!existing) return null

        const data: Prisma.RoadmapItemUncheckedUpdateInput = {}
        if (parsed.data.title !== undefined) data.title = parsed.data.title
        if ('description' in parsed.data) data.description = parsed.data.description
        if (parsed.data.status !== undefined) data.status = parsed.data.status

        const updated = await tx.roadmapItem.update({
          where: { id: itemId },
          data,
          select: ITEM_SELECT,
        })

        return { previousStatus: existing.status, updated }
      })

      if (!result) {
        return reply.status(404).send({ message: 'Roadmap item not found' })
      }

      const { previousStatus, updated } = result

      if (previousStatus !== 'shipped' && updated.status === 'shipped') {
        try {
          await fastify.notificationQueue.add('feature_shipped', {
            type: 'feature_shipped',
            referenceId: itemId,
            projectId,
          })
        } catch (err) {
          req.log.error({ itemId, err }, 'roadmap: failed to enqueue feature_shipped job')
        }
      }

      return reply.send(updated)
    },
  )

  // DELETE /api/v1/projects/:projectId/roadmap/:itemId — delete item (owner only)
  fastify.delete(
    '/:projectId/roadmap/:itemId',
    {
      onRequest: [authenticate],
      config: { rateLimit: { max: MUTATE_RATE_LIMIT, timeWindow: 60_000 } },
    },
    async (req, reply) => {
      const { orgId, role } = req.user
      const { projectId, itemId } = req.params as { projectId: string; itemId: string }

      if (role !== 'owner') {
        return reply.status(403).send({ message: 'Only organisation owners can delete roadmap items' })
      }

      if (!isUUID(projectId) || !isUUID(itemId)) {
        return reply.status(404).send({ message: 'Roadmap item not found' })
      }

      const project = await fastify.prisma.project.findFirst({
        where: { id: projectId, orgId, isActive: true },
        select: { id: true },
      })
      if (!project) {
        return reply.status(404).send({ message: 'Project not found' })
      }

      const result = await fastify.prisma.roadmapItem.deleteMany({
        where: { id: itemId, projectId },
      })

      if (result.count === 0) {
        return reply.status(404).send({ message: 'Roadmap item not found' })
      }

      return reply.status(204).send()
    },
  )
}
