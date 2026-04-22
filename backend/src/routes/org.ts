import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/library'
import { authenticate } from '../middleware/authenticate'
import { getR2Client, createLogoPresignedUrl } from '../services/r2'
import { env } from '../config/env'

const ORG_RATE_LIMIT = env.NODE_ENV === 'test' ? 100_000 : 60
const ORG_MUTATE_RATE_LIMIT = env.NODE_ENV === 'test' ? 100_000 : 10

// Regex enforces at least 2 chars (one leading + one trailing alphanumeric), no leading/trailing hyphens.
const slugSchema = z
  .string()
  .max(100, 'Slug must be at most 100 characters')
  .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/, 'Slug must be lowercase alphanumeric with hyphens, no leading or trailing hyphen')

const patchOrgSchema = z.object({
  name: z.string().min(2, 'Organisation name must be at least 2 characters').max(200, 'Organisation name must be at most 200 characters').optional(),
  slug: slugSchema.optional(),
  // Restrict to HTTPS only — HTTP logo URLs would serve mixed-content on the admin dashboard.
  logoUrl: z.string().url('logoUrl must be a valid URL').refine(
    (u) => u.startsWith('https://'),
    'logoUrl must use HTTPS',
  ).optional(),
}).refine((d) => d.name !== undefined || d.slug !== undefined || d.logoUrl !== undefined, {
  message: 'At least one field (name, slug, logoUrl) is required',
})

export default async function orgRoutes(fastify: FastifyInstance) {
  // GET /api/v1/org — return current org settings (owner or editor)
  fastify.get(
    '/',
    {
      onRequest: [authenticate],
      config: { rateLimit: { max: ORG_RATE_LIMIT, timeWindow: 60_000 } },
    },
    async (req, reply) => {
      const { orgId } = req.user

      const org = await fastify.prisma.organization.findUnique({
        where: { id: orgId },
        select: { id: true, name: true, slug: true, logoUrl: true, plan: true, createdAt: true },
      })

      if (!org) {
        return reply.status(404).send({ message: 'Organisation not found' })
      }

      return reply.send(org)
    },
  )

  // PATCH /api/v1/org — update name, slug, and/or logoUrl (owner only)
  fastify.patch(
    '/',
    {
      onRequest: [authenticate],
      // Note: rate limit is keyed by IP (default). Keying by orgId would require
      // decoding the JWT in the keyGenerator, before authenticate runs — deferred.
      config: { rateLimit: { max: ORG_MUTATE_RATE_LIMIT, timeWindow: 60_000 } },
    },
    async (req, reply) => {
      const { orgId, role } = req.user

      if (role !== 'owner') {
        return reply.status(403).send({ message: 'Only organisation owners can update settings' })
      }

      const parsed = patchOrgSchema.safeParse(req.body)
      if (!parsed.success) {
        const messages = parsed.error.issues.map((i) => i.message).join(', ')
        return reply.status(422).send({ message: messages })
      }

      const { name, slug, logoUrl } = parsed.data

      try {
        const org = await fastify.prisma.organization.update({
          where: { id: orgId },
          data: {
            ...(name !== undefined && { name }),
            ...(slug !== undefined && { slug }),
            ...(logoUrl !== undefined && { logoUrl }),
          },
          select: { id: true, name: true, slug: true, logoUrl: true, plan: true, createdAt: true },
        })

        return reply.send(org)
      } catch (err) {
        if (err instanceof PrismaClientKnownRequestError && err.code === 'P2002') {
          return reply.status(409).send({ statusCode: 409, error: 'Conflict', message: 'Slug is already taken' })
        }
        throw err
      }
    },
  )

  // POST /api/v1/org/logo-upload-url — return presigned R2 PUT URL for logo upload (owner only).
  // POST because this generates a time-limited credential — GET would be cacheable by proxies/CDNs.
  // After upload, call PATCH /org with { logoUrl: <publicUrl> } to persist the URL.
  fastify.post(
    '/logo-upload-url',
    {
      onRequest: [authenticate],
      config: { rateLimit: { max: ORG_MUTATE_RATE_LIMIT, timeWindow: 60_000 } },
    },
    async (req, reply) => {
      const { orgId, role } = req.user

      if (role !== 'owner') {
        return reply.status(403).send({ message: 'Only organisation owners can upload logos' })
      }

      if (!getR2Client()) {
        return reply.status(503).send({ message: 'Logo upload not configured' })
      }

      const result = await createLogoPresignedUrl(orgId)
      return reply.send(result)
    },
  )
}
