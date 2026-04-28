import { requirePlan, planLimitCheck } from '../middleware/planLimit'
import { FastifyRequest, FastifyReply } from 'fastify'

type MockOrg = { plan: 'free' | 'starter' | 'pro'; _count: { projects: number } } | null

function makeReq(orgId: string | undefined, findUniqueResult: MockOrg, rejects?: Error) {
  const findUnique = rejects
    ? jest.fn().mockRejectedValue(rejects)
    : jest.fn().mockResolvedValue(findUniqueResult)

  return {
    user: orgId ? { orgId, sub: 'user-1', role: 'owner' as const } : undefined,
    server: {
      prisma: {
        organization: { findUnique },
      },
    },
  } as unknown as FastifyRequest
}

function makeReply() {
  const reply = {
    _status: 0,
    _body: undefined as unknown,
    status(code: number) {
      this._status = code
      return this
    },
    send(body: unknown) {
      this._body = body
      return this
    },
  }
  return reply as unknown as FastifyReply & { _status: number; _body: unknown }
}

describe('requirePlan', () => {
  it('401 when req.user is absent (hook order bug)', async () => {
    const req = makeReq(undefined, null)
    const reply = makeReply()
    await requirePlan('pro')(req, reply)
    expect(reply._status).toBe(401)
    expect(reply._body).toEqual({ message: 'Unauthorized' })
  })

  it('404 when org not found', async () => {
    const req = makeReq('org-1', null)
    const reply = makeReply()
    await requirePlan('pro')(req, reply)
    expect(reply._status).toBe(404)
    expect(reply._body).toEqual({ message: 'Organisation not found' })
  })

  it('403 when free org requires starter', async () => {
    const req = makeReq('org-1', { plan: 'free', _count: { projects: 0 } })
    const reply = makeReply()
    await requirePlan('starter')(req, reply)
    expect(reply._status).toBe(403)
    expect(reply._body).toEqual({ error: 'PLAN_REQUIRED', requiredPlan: 'starter' })
  })

  it('403 when starter org requires pro', async () => {
    const req = makeReq('org-1', { plan: 'starter', _count: { projects: 0 } })
    const reply = makeReply()
    await requirePlan('pro')(req, reply)
    expect(reply._status).toBe(403)
    expect(reply._body).toEqual({ error: 'PLAN_REQUIRED', requiredPlan: 'pro' })
  })

  it('passes when org.plan equals minPlan', async () => {
    const req = makeReq('org-1', { plan: 'pro', _count: { projects: 0 } })
    const reply = makeReply()
    await requirePlan('pro')(req, reply)
    expect(reply._body).toBeUndefined()
  })

  it('passes when org.plan exceeds minPlan', async () => {
    const req = makeReq('org-1', { plan: 'pro', _count: { projects: 0 } })
    const reply = makeReply()
    await requirePlan('starter')(req, reply)
    expect(reply._body).toBeUndefined()
  })

  it('passes when free org checks free plan', async () => {
    const req = makeReq('org-1', { plan: 'free', _count: { projects: 0 } })
    const reply = makeReply()
    await requirePlan('free')(req, reply)
    expect(reply._body).toBeUndefined()
  })

  it('re-throws on DB error', async () => {
    const req = makeReq('org-1', null, new Error('DB_DOWN'))
    const reply = makeReply()
    await expect(requirePlan('pro')(req, reply)).rejects.toThrow('DB_DOWN')
  })
})

describe('planLimitCheck(projects)', () => {
  it('401 when req.user is absent (hook order bug)', async () => {
    const req = makeReq(undefined, null)
    const reply = makeReply()
    await planLimitCheck('projects')(req, reply)
    expect(reply._status).toBe(401)
    expect(reply._body).toEqual({ message: 'Unauthorized' })
  })

  it('404 when org not found', async () => {
    const req = makeReq('org-1', null)
    const reply = makeReply()
    await planLimitCheck('projects')(req, reply)
    expect(reply._status).toBe(404)
    expect(reply._body).toEqual({ message: 'Organisation not found' })
  })

  it('403 when free org at limit (count=1)', async () => {
    const req = makeReq('org-1', { plan: 'free', _count: { projects: 1 } })
    const reply = makeReply()
    await planLimitCheck('projects')(req, reply)
    expect(reply._status).toBe(403)
    expect(reply._body).toEqual({ error: 'PLAN_LIMIT_REACHED', resource: 'projects' })
  })

  it('passes when free org below limit (count=0)', async () => {
    const req = makeReq('org-1', { plan: 'free', _count: { projects: 0 } })
    const reply = makeReply()
    await planLimitCheck('projects')(req, reply)
    expect(reply._body).toBeUndefined()
  })

  it('403 when starter org at limit (count=3)', async () => {
    const req = makeReq('org-1', { plan: 'starter', _count: { projects: 3 } })
    const reply = makeReply()
    await planLimitCheck('projects')(req, reply)
    expect(reply._status).toBe(403)
    expect(reply._body).toEqual({ error: 'PLAN_LIMIT_REACHED', resource: 'projects' })
  })

  it('passes when starter org below limit (count=2)', async () => {
    const req = makeReq('org-1', { plan: 'starter', _count: { projects: 2 } })
    const reply = makeReply()
    await planLimitCheck('projects')(req, reply)
    expect(reply._body).toBeUndefined()
  })

  it('passes when pro org at large count (Infinity limit)', async () => {
    const req = makeReq('org-1', { plan: 'pro', _count: { projects: 1_000_000 } })
    const reply = makeReply()
    await planLimitCheck('projects')(req, reply)
    expect(reply._body).toBeUndefined()
  })

  it('re-throws on DB error', async () => {
    const req = makeReq('org-1', null, new Error('DB_DOWN'))
    const reply = makeReply()
    await expect(planLimitCheck('projects')(req, reply)).rejects.toThrow('DB_DOWN')
  })
})
