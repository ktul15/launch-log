import { Plan } from '@prisma/client'

export type PlanResource = 'projects' | 'helpArticles' | 'surveys'

// Record<Plan, number> enforces exhaustiveness — adding a new Plan enum value without
// a corresponding entry here is a compile error, not a silent runtime 500.
// Object.freeze prevents accidental mutation that would silently affect all callers.
export const PLAN_LIMITS = Object.freeze({
  projects:     Object.freeze({ free: 1,  starter: 3,   pro: Infinity }),
  helpArticles: Object.freeze({ free: 50, starter: 200, pro: Infinity }),
  surveys:      Object.freeze({ free: 1,  starter: 3,   pro: Infinity }),
}) as Record<PlanResource, Record<Plan, number>>

export class PlanLimitExceededError extends Error {
  constructor() {
    super('Plan limit exceeded')
    this.name = 'PlanLimitExceededError'
  }
}

// Designed to be called inside a Prisma serializable transaction so the check and
// the subsequent insert are atomic. Throws PlanLimitExceededError when count >= limit.
export function assertPlanLimit(resource: PlanResource, plan: Plan, count: number): void {
  const limit = PLAN_LIMITS[resource]?.[plan]
  if (limit === undefined) throw new Error(`No plan limit defined for resource=${resource} plan=${plan}`)
  if (count >= limit) throw new PlanLimitExceededError()
}
