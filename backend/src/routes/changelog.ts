import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { authenticate } from '../middleware/authenticate'
import { env } from '../config/env'

const RATE_LIMIT = env.NODE_ENV === 'test' ? 100_000 : 60
const MUTATE_RATE_LIMIT = env.NODE_ENV === 'test' ? 100_000 : 10

// Sentinel strings thrown inside transactions so handlers can map them to HTTP responses.
const TXN_ERR = {
  ARCHIVED: 'TXN_ARCHIVED',
  INVALID_CATEGORY: 'TXN_INVALID_CATEGORY',
} as const

const ENTRY_SELECT = {
  id: true,
  projectId: true,
  title: true,
  content: true,
  version: true,
  categoryId: true,
  status: true,
  publishedAt: true,
  authorId: true,
  createdAt: true,
  updatedAt: true,
} as const

// Require valid ProseMirror/TipTap document shape to prevent storing unrenderable content.
const contentSchema = z.object({
  type: z.literal('doc', { errorMap: () => ({ message: 'Content must be a TipTap doc node' }) }),
  content: z.array(z.unknown()),
})

const createEntrySchema = z.object({
  title: z.string().min(1, 'Title is required').max(200, 'Title must be at most 200 characters'),
  content: contentSchema,
  version: z
    .string()
    .min(1, 'Version cannot be empty')
    .max(50, 'Version must be at most 50 characters')
    .optional(),
  categoryId: z.string().uuid('Invalid category ID').nullable().optional(),
})

const updateEntrySchema = z
  .object({
    title: z.string().min(1, 'Title is required').max(200).optional(),
    content: contentSchema.optional(),
    version: z.string().min(1, 'Version cannot be empty').max(50).nullable().optional(),
    categoryId: z.string().uuid('Invalid category ID').nullable().optional(),
  })
  // Object.keys counts only keys Zod kept after stripping unknowns and undefined optionals.
  // This guard is only reliable with the default .strip() mode.
  .superRefine((data, ctx) => {
    if (Object.keys(data).length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'At least one field must be provided' })
    }
  })

const listQuerySchema = z.object({
  status: z.enum(['draft', 'published', 'archived']).optional(),
})

const uuidSchema = z.string().uuid()
function isUUID(s: string): boolean {
  return uuidSchema.safeParse(s).success
}

export default async function changelogRoutes(fastify: FastifyInstance) {
  // GET /api/v1/projects/:projectId/changelog — list entries for a project
  fastify.get(
    '/:projectId/changelog',
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

      const entries = await fastify.prisma.changelogEntry.findMany({
        where: {
          projectId,
          ...(parsed.data.status ? { status: parsed.data.status } : {}),
        },
        select: ENTRY_SELECT,
        orderBy: [
          { publishedAt: { sort: 'desc', nulls: 'last' } },
          { createdAt: 'desc' },
        ],
      })

      return reply.send(entries)
    },
  )

  // POST /api/v1/projects/:projectId/changelog — create entry (owner only)
  fastify.post(
    '/:projectId/changelog',
    {
      onRequest: [authenticate],
      config: { rateLimit: { max: MUTATE_RATE_LIMIT, timeWindow: 60_000 } },
    },
    async (req, reply) => {
      const { orgId, role, sub: userId } = req.user
      const { projectId } = req.params as { projectId: string }

      if (role !== 'owner') {
        return reply.status(403).send({ message: 'Only organisation owners can create changelog entries' })
      }

      if (!isUUID(projectId)) {
        return reply.status(404).send({ message: 'Project not found' })
      }

      const parsed = createEntrySchema.safeParse(req.body)
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

      // Reject categoryId that belongs to a different project to prevent cross-project data links
      // that would leak category names across org boundaries on the public widget page.
      if (parsed.data.categoryId) {
        const cat = await fastify.prisma.changelogCategory.findFirst({
          where: { id: parsed.data.categoryId, projectId },
          select: { id: true },
        })
        if (!cat) return reply.status(422).send({ message: 'Category not found in this project' })
      }

      const entry = await fastify.prisma.changelogEntry.create({
        data: {
          projectId,
          title: parsed.data.title,
          content: parsed.data.content as unknown as Prisma.InputJsonValue,
          ...(parsed.data.version !== undefined ? { version: parsed.data.version } : {}),
          ...(parsed.data.categoryId !== undefined ? { categoryId: parsed.data.categoryId } : {}),
          authorId: userId,
        },
        select: ENTRY_SELECT,
      })

      return reply.status(201).send(entry)
    },
  )

  // GET /api/v1/projects/:projectId/changelog/:entryId — get entry detail
  fastify.get(
    '/:projectId/changelog/:entryId',
    {
      onRequest: [authenticate],
      config: { rateLimit: { max: RATE_LIMIT, timeWindow: 60_000 } },
    },
    async (req, reply) => {
      const { orgId } = req.user
      const { projectId, entryId } = req.params as { projectId: string; entryId: string }

      if (!isUUID(projectId) || !isUUID(entryId)) {
        return reply.status(404).send({ message: 'Project not found' })
      }

      const project = await fastify.prisma.project.findFirst({
        where: { id: projectId, orgId, isActive: true },
        select: { id: true },
      })
      if (!project) {
        return reply.status(404).send({ message: 'Project not found' })
      }

      const entry = await fastify.prisma.changelogEntry.findFirst({
        where: { id: entryId, projectId },
        select: ENTRY_SELECT,
      })
      if (!entry) {
        return reply.status(404).send({ message: 'Changelog entry not found' })
      }

      return reply.send(entry)
    },
  )

  // PATCH /api/v1/projects/:projectId/changelog/:entryId — update entry (owner only)
  fastify.patch(
    '/:projectId/changelog/:entryId',
    {
      onRequest: [authenticate],
      config: { rateLimit: { max: MUTATE_RATE_LIMIT, timeWindow: 60_000 } },
    },
    async (req, reply) => {
      const { orgId, role } = req.user
      const { projectId, entryId } = req.params as { projectId: string; entryId: string }

      if (role !== 'owner') {
        return reply.status(403).send({ message: 'Only organisation owners can update changelog entries' })
      }

      if (!isUUID(projectId) || !isUUID(entryId)) {
        return reply.status(404).send({ message: 'Changelog entry not found' })
      }

      const parsed = updateEntrySchema.safeParse(req.body)
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

      try {
        // Transaction makes the existence check, archive guard, category validation, and write atomic.
        const updated = await fastify.prisma.$transaction(async (tx) => {
          const existing = await tx.changelogEntry.findFirst({
            where: { id: entryId, projectId },
            select: { id: true, status: true },
          })
          if (!existing) return null
          if (existing.status === 'archived') throw new Error(TXN_ERR.ARCHIVED)

          if ('categoryId' in parsed.data && parsed.data.categoryId != null) {
            const cat = await tx.changelogCategory.findFirst({
              where: { id: parsed.data.categoryId, projectId },
              select: { id: true },
            })
            if (!cat) throw new Error(TXN_ERR.INVALID_CATEGORY)
          }

          const data: Prisma.ChangelogEntryUncheckedUpdateInput = {}
          if (parsed.data.title !== undefined) data.title = parsed.data.title
          if (parsed.data.content !== undefined) {
            data.content = parsed.data.content as unknown as Prisma.InputJsonValue
          }
          if ('version' in parsed.data) data.version = parsed.data.version
          if ('categoryId' in parsed.data) data.categoryId = parsed.data.categoryId

          return tx.changelogEntry.update({
            where: { id: entryId },
            data,
            select: ENTRY_SELECT,
          })
        })

        if (!updated) {
          return reply.status(404).send({ message: 'Changelog entry not found' })
        }

        return reply.send(updated)
      } catch (err) {
        if (err instanceof Error) {
          if (err.message === TXN_ERR.ARCHIVED) {
            return reply.status(409).send({ message: 'Archived entries cannot be edited' })
          }
          if (err.message === TXN_ERR.INVALID_CATEGORY) {
            return reply.status(422).send({ message: 'Category not found in this project' })
          }
        }
        throw err
      }
    },
  )

  // DELETE /api/v1/projects/:projectId/changelog/:entryId — delete entry (owner only)
  fastify.delete(
    '/:projectId/changelog/:entryId',
    {
      onRequest: [authenticate],
      config: { rateLimit: { max: MUTATE_RATE_LIMIT, timeWindow: 60_000 } },
    },
    async (req, reply) => {
      const { orgId, role } = req.user
      const { projectId, entryId } = req.params as { projectId: string; entryId: string }

      if (role !== 'owner') {
        return reply.status(403).send({ message: 'Only organisation owners can delete changelog entries' })
      }

      if (!isUUID(projectId) || !isUUID(entryId)) {
        return reply.status(404).send({ message: 'Changelog entry not found' })
      }

      const project = await fastify.prisma.project.findFirst({
        where: { id: projectId, orgId, isActive: true },
        select: { id: true },
      })
      if (!project) {
        return reply.status(404).send({ message: 'Project not found' })
      }

      // deleteMany with projectId enforces project-scoped ownership atomically.
      const result = await fastify.prisma.changelogEntry.deleteMany({
        where: { id: entryId, projectId },
      })

      if (result.count === 0) {
        return reply.status(404).send({ message: 'Changelog entry not found' })
      }

      return reply.status(204).send()
    },
  )

  // POST /api/v1/projects/:projectId/changelog/:entryId/publish — publish entry (owner only)
  fastify.post(
    '/:projectId/changelog/:entryId/publish',
    {
      onRequest: [authenticate],
      config: { rateLimit: { max: MUTATE_RATE_LIMIT, timeWindow: 60_000 } },
    },
    async (req, reply) => {
      const { orgId, role } = req.user
      const { projectId, entryId } = req.params as { projectId: string; entryId: string }

      if (role !== 'owner') {
        return reply.status(403).send({ message: 'Only organisation owners can publish changelog entries' })
      }

      if (!isUUID(projectId) || !isUUID(entryId)) {
        return reply.status(404).send({ message: 'Changelog entry not found' })
      }

      const project = await fastify.prisma.project.findFirst({
        where: { id: projectId, orgId, isActive: true },
        select: { id: true },
      })
      if (!project) {
        return reply.status(404).send({ message: 'Project not found' })
      }

      // Transaction makes the existence check and write atomic. publishedAt is only set when
      // it was null — either the true first publish, or a re-publish after unpublish (unpublish
      // clears publishedAt). This preserves the original timestamp for RSS feed ordering.
      const result = await fastify.prisma.$transaction(async (tx) => {
        const existing = await tx.changelogEntry.findFirst({
          where: { id: entryId, projectId },
          select: { id: true, publishedAt: true },
        })
        if (!existing) return null

        // publishedAtWasNull is true for both the true first publish AND any re-publish after
        // unpublish (which clears publishedAt). The notification worker deduplicates via
        // notification_logs, so subscribers who already received an email are not re-notified.
        const publishedAtWasNull = existing.publishedAt === null
        const entry = await tx.changelogEntry.update({
          where: { id: entryId },
          data: {
            status: 'published',
            ...(publishedAtWasNull ? { publishedAt: new Date() } : {}),
          },
          select: ENTRY_SELECT,
        })
        return { entry, publishedAtWasNull }
      })

      if (!result) {
        return reply.status(404).send({ message: 'Changelog entry not found' })
      }

      // Enqueue notification job when publishedAt was null. Await ensures the job is durably
      // written to Redis before responding — if Redis is down, the caller gets a 500 and can
      // retry rather than silently losing the notification.
      if (result.publishedAtWasNull) {
        await fastify.notificationQueue.add('changelog_published', {
          type: 'changelog_published',
          referenceId: entryId,
          projectId,
        })
      }

      return reply.send(result.entry)
    },
  )

  // POST /api/v1/projects/:projectId/changelog/:entryId/unpublish — revert to draft (owner only)
  fastify.post(
    '/:projectId/changelog/:entryId/unpublish',
    {
      onRequest: [authenticate],
      config: { rateLimit: { max: MUTATE_RATE_LIMIT, timeWindow: 60_000 } },
    },
    async (req, reply) => {
      const { orgId, role } = req.user
      const { projectId, entryId } = req.params as { projectId: string; entryId: string }

      if (role !== 'owner') {
        return reply.status(403).send({ message: 'Only organisation owners can unpublish changelog entries' })
      }

      if (!isUUID(projectId) || !isUUID(entryId)) {
        return reply.status(404).send({ message: 'Changelog entry not found' })
      }

      const project = await fastify.prisma.project.findFirst({
        where: { id: projectId, orgId, isActive: true },
        select: { id: true },
      })
      if (!project) {
        return reply.status(404).send({ message: 'Project not found' })
      }

      // Transaction makes the existence check and write atomic.
      const entry = await fastify.prisma.$transaction(async (tx) => {
        const existing = await tx.changelogEntry.findFirst({
          where: { id: entryId, projectId },
          select: { id: true },
        })
        if (!existing) return null

        return tx.changelogEntry.update({
          where: { id: entryId },
          data: { status: 'draft', publishedAt: null },
          select: ENTRY_SELECT,
        })
      })

      if (!entry) {
        return reply.status(404).send({ message: 'Changelog entry not found' })
      }

      return reply.send(entry)
    },
  )
}
