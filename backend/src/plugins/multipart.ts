import fp from 'fastify-plugin'
import { FastifyPluginAsync } from 'fastify'
import multipart from '@fastify/multipart'

// Allowed MIME types for file uploads (avatars, logos, rich-text images)
export const ALLOWED_IMAGE_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  // SVG excluded: can contain embedded JavaScript (stored XSS via file upload)
]

const multipartPlugin: FastifyPluginAsync = fp(async (fastify) => {
  await fastify.register(multipart, {
    limits: {
      fileSize: 5 * 1024 * 1024, // 5MB
      // files: not set globally — each route handler specifies its own file count limit
    },
  })
})

export default multipartPlugin
