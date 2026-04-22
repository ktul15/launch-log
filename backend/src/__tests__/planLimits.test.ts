import { PLAN_LIMITS, PlanLimitExceededError, assertPlanLimit, PlanResource } from '../utils/planLimits'

describe('PLAN_LIMITS', () => {
  it('projects: free=1, starter=3, pro=Infinity', () => {
    expect(PLAN_LIMITS.projects.free).toBe(1)
    expect(PLAN_LIMITS.projects.starter).toBe(3)
    expect(PLAN_LIMITS.projects.pro).toBe(Infinity)
  })

  it('helpArticles: free=50, starter=200, pro=Infinity', () => {
    expect(PLAN_LIMITS.helpArticles.free).toBe(50)
    expect(PLAN_LIMITS.helpArticles.starter).toBe(200)
    expect(PLAN_LIMITS.helpArticles.pro).toBe(Infinity)
  })

  it('surveys: free=1, starter=3, pro=Infinity', () => {
    expect(PLAN_LIMITS.surveys.free).toBe(1)
    expect(PLAN_LIMITS.surveys.starter).toBe(3)
    expect(PLAN_LIMITS.surveys.pro).toBe(Infinity)
  })

  it('is frozen — mutation throws in strict mode', () => {
    expect(() => {
      ;(PLAN_LIMITS as Record<string, unknown>).projects = { free: 999, starter: 999, pro: 999 }
    }).toThrow(TypeError)
    expect(() => {
      ;(PLAN_LIMITS.projects as Record<string, unknown>).free = 999
    }).toThrow(TypeError)
    // Confirm originals unchanged
    expect(PLAN_LIMITS.projects.free).toBe(1)
  })
})

describe('assertPlanLimit', () => {
  const resources: PlanResource[] = ['projects', 'helpArticles', 'surveys']

  it('does not throw when count is below limit', () => {
    expect(() => assertPlanLimit('projects', 'free', 0)).not.toThrow()
    expect(() => assertPlanLimit('projects', 'starter', 2)).not.toThrow()
    expect(() => assertPlanLimit('helpArticles', 'free', 49)).not.toThrow()
    expect(() => assertPlanLimit('surveys', 'starter', 0)).not.toThrow()
  })

  it('throws PlanLimitExceededError when count equals limit', () => {
    expect(() => assertPlanLimit('projects', 'free', 1)).toThrow(PlanLimitExceededError)
    expect(() => assertPlanLimit('projects', 'starter', 3)).toThrow(PlanLimitExceededError)
    expect(() => assertPlanLimit('helpArticles', 'free', 50)).toThrow(PlanLimitExceededError)
    expect(() => assertPlanLimit('surveys', 'starter', 3)).toThrow(PlanLimitExceededError)
  })

  it('throws PlanLimitExceededError when count exceeds limit', () => {
    expect(() => assertPlanLimit('projects', 'free', 5)).toThrow(PlanLimitExceededError)
    expect(() => assertPlanLimit('helpArticles', 'starter', 999)).toThrow(PlanLimitExceededError)
  })

  it('never throws for pro plan on any resource', () => {
    for (const resource of resources) {
      expect(() => assertPlanLimit(resource, 'pro', 1_000_000)).not.toThrow()
    }
  })

  it('throws generic Error (not PlanLimitExceededError) for unknown resource/plan', () => {
    expect(() => assertPlanLimit('projects' as PlanResource, 'free' as never, 0)).not.toThrow()
    // Force an undefined lookup via type coercion
    expect(() => assertPlanLimit('unknown' as PlanResource, 'free', 0)).toThrow(Error)
    expect(() => assertPlanLimit('unknown' as PlanResource, 'free', 0)).not.toThrow(PlanLimitExceededError)
  })
})
