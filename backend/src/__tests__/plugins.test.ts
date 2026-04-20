import { buildApp } from '../index'
import { FastifyInstance } from 'fastify'

describe('Plugin registration', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    app = await buildApp()
  })

  afterAll(async () => {
    await app.close()
  })

  it('decorates fastify instance with prisma client', () => {
    expect(app.prisma).toBeDefined()
    expect(typeof app.prisma.$connect).toBe('function')
    expect(typeof app.prisma.$disconnect).toBe('function')
  })

  it('decorates fastify instance with redis client', () => {
    expect(app.redis).toBeDefined()
    expect(typeof app.redis.ping).toBe('function')
  })

  it('GET /api/v1 returns version and status', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1' })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.version).toBe('1.0.0')
    expect(body.status).toBe('ok')
  })
})
