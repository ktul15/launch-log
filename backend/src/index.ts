import Fastify from 'fastify'

export const buildApp = () => {
  const app = Fastify({ logger: true })
  app.get('/health', async () => ({ status: 'ok' }))
  return app
}

const start = async () => {
  const app = buildApp()
  try {
    const port = parseInt(process.env.PORT ?? '3001', 10)
    await app.listen({ port, host: '0.0.0.0' })
  } catch (err) {
    app.log.error(err)
    process.exit(1)
  }
}

start()
