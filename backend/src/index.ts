import dotenv from 'dotenv'
import path from 'path'

// Load .env anchored to this file so the path is correct regardless of cwd.
// quiet: true suppresses dotenv v17's "injected env (N) from .env" stdout line.
// In production, env vars are injected directly — dotenv skips silently if file is absent.
dotenv.config({ path: path.resolve(__dirname, '../.env'), quiet: true })

import Fastify, { FastifyInstance } from 'fastify'
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/library'
import { env } from './config/env'
import { registerPlugins } from './plugins'
import { registerRoutes } from './routes'

export const buildApp = async (): Promise<FastifyInstance> => {
  const app = Fastify({
    logger: {
      level: env.NODE_ENV === 'test' ? 'silent' : env.LOG_LEVEL,
      transport:
        env.NODE_ENV === 'development'
          ? { target: 'pino-pretty' }
          : undefined,
    },
    // trustProxy resolves request.ip from X-Forwarded-For correctly when
    // behind Nginx or Cloudflare — required for accurate rate-limit keying
    trustProxy: true,
  })

  await registerPlugins(app)
  await registerRoutes(app)

  app.get(
    '/health',
    { config: { rateLimit: { max: 1000, timeWindow: '1 minute' } } },
    async () => ({ status: 'ok', timestamp: new Date().toISOString() }),
  )

  // Normalize errors so internal details (table names, stack traces) are never
  // returned to clients. Prisma error codes are mapped to HTTP semantics.
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof PrismaClientKnownRequestError) {
      if (error.code === 'P2002') {
        return reply.status(409).send({ statusCode: 409, error: 'Conflict', message: 'A record with this value already exists' })
      }
      if (error.code === 'P2025') {
        return reply.status(404).send({ statusCode: 404, error: 'Not Found', message: 'Record not found' })
      }
    }

    const statusCode = error.statusCode ?? 500
    request.log.error(error)
    return reply.status(statusCode).send({
      statusCode,
      error: error.name ?? 'Error',
      // Only surface the message for 4xx errors; 5xx returns a generic message
      message: statusCode < 500 ? error.message : 'Internal Server Error',
    })
  })

  return app
}

let runningApp: FastifyInstance | null = null

const start = async () => {
  try {
    runningApp = await buildApp()
    await runningApp.listen({ port: env.PORT, host: '0.0.0.0' })
  } catch (err) {
    // runningApp may be null if buildApp() threw before assigning
    if (runningApp) {
      runningApp.log.error(err)
    } else {
      console.error(err)
    }
    process.exit(1)
  }
}

const gracefulShutdown = async (signal: string) => {
  console.warn(`Received ${signal}, shutting down…`)
  // runningApp may be null if signal arrives before buildApp() resolves
  if (runningApp) {
    // Fastify.close() triggers all onClose hooks (prisma.$disconnect, redis.quit)
    await runningApp.close()
  }
  process.exit(0)
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))
process.on('SIGINT', () => gracefulShutdown('SIGINT'))

// Guard: only start the server when this file is the entry point.
// When imported by tests (import { buildApp } from '../index'), start() must NOT run
// — it would bind to port 3001 and cause EADDRINUSE across test workers.
if (require.main === module) {
  start()
}
