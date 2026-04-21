import { FastifyInstance } from 'fastify'

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  // Route modules registered here as features are built:
  await app.register(import('./auth'), { prefix: '/api/v1/auth' })
  // await app.register(import('./org'), { prefix: '/api/v1/org' })
  // await app.register(import('./projects'), { prefix: '/api/v1/projects' })
  // await app.register(import('./public'), { prefix: '/api/v1/public' })
  // await app.register(import('./billing'), { prefix: '/api/v1/billing' })

  app.get('/api/v1', async () => ({ version: '1.0.0', status: 'ok' }))
}
