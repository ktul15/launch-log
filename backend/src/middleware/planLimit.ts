import { Plan } from '@prisma/client'
import { FastifyRequest, FastifyReply } from 'fastify'
import { PLAN_LIMITS } from '../utils/planLimits'

// Record<Plan, number> enforces exhaustiveness — adding a new Plan enum value without
// a corresponding entry here is a compile error, not a silent runtime 500.
const PLAN_ORDER: Record<Plan, number> = {
  free: 0,
  starter: 1,
  pro: 2,
}

export function requirePlan(
  minPlan: Plan,
): (req: FastifyRequest, reply: FastifyReply) => Promise<void> {
  return async (req, reply) => {
    if (!req.user?.orgId) {
      return reply.status(401).send({ message: 'Unauthorized' })
    }

    const org = await req.server.prisma.organization.findUnique({
      where: { id: req.user.orgId },
      select: { plan: true },
    })

    if (!org) {
      return reply.status(404).send({ message: 'Organisation not found' })
    }

    if (PLAN_ORDER[org.plan] < PLAN_ORDER[minPlan]) {
      return reply.status(403).send({ error: 'PLAN_REQUIRED', requiredPlan: minPlan })
    }
  }
}

// Non-atomic fast-fail for count-based limits. Must run after authenticate.
// The in-transaction assertPlanLimit in the route handler remains the authoritative
// atomic guard — this only avoids acquiring locks for clearly over-limit orgs.
// IMPORTANT: the isActive filter here must match the transaction query in routes/projects.ts.
export function planLimitCheck(
  resource: 'projects',
): (req: FastifyRequest, reply: FastifyReply) => Promise<void> {
  return async (req, reply) => {
    if (!req.user?.orgId) {
      return reply.status(401).send({ message: 'Unauthorized' })
    }

    const org = await req.server.prisma.organization.findUnique({
      where: { id: req.user.orgId },
      select: {
        plan: true,
        _count: { select: { projects: { where: { isActive: true } } } },
      },
    })

    if (!org) {
      return reply.status(404).send({ message: 'Organisation not found' })
    }

    const limit = PLAN_LIMITS[resource][org.plan]
    const count = org._count?.projects ?? 0
    if (count >= limit) {
      return reply.status(403).send({ error: 'PLAN_LIMIT_REACHED', resource })
    }
  }
}
