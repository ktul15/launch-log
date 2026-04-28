import crypto from 'crypto'
import { buildApp } from '../index'
import { FastifyInstance } from 'fastify'
import { PrismaClient } from '@prisma/client'
import { env } from '../config/env'

const mockCustomersCreate = jest.fn()
const mockSessionsCreate = jest.fn()

jest.mock('stripe', () => ({
  __esModule: true,
  default: function Stripe() {
    return {
      customers: { create: mockCustomersCreate },
      checkout: { sessions: { create: mockSessionsCreate } },
    }
  },
}))

const prisma = new PrismaClient()
const RUN = crypto.randomUUID().replace(/-/g, '').slice(0, 12)

const createdOrgIds: string[] = []

function testEmail(label: string) {
  return `${RUN}-${label}@test.invalid`
}

function testOrgName(label: string) {
  return `Test Org ${RUN} ${label}`
}

async function registerAndGetCookie(
  app: FastifyInstance,
  label: string,
): Promise<{ cookie: string; orgId: string; userId: string }> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: {
      orgName: testOrgName(label),
      name: 'TestUser',
      email: testEmail(label),
      password: 'password123',
    },
  })
  expect(res.statusCode).toBe(201)
  const body = JSON.parse(res.body)
  createdOrgIds.push(body.org.id)
  const setCookie = res.headers['set-cookie']
  const cookies = Array.isArray(setCookie) ? setCookie : [setCookie ?? '']
  const cookie = cookies.map((c) => c.split(';')[0]).join('; ')
  return { cookie, orgId: body.org.id, userId: body.user.id }
}

async function createEditorCookie(
  app: FastifyInstance,
  orgId: string,
  label: string,
): Promise<string> {
  const bcrypt = await import('bcrypt')
  const hash = await bcrypt.hash('password123', 1)
  await prisma.user.create({
    data: {
      orgId,
      email: testEmail(label),
      passwordHash: hash,
      name: 'Editor',
      role: 'editor',
    },
  })

  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email: testEmail(label), password: 'password123' },
  })
  expect(res.statusCode).toBe(200)
  const setCookie = res.headers['set-cookie']
  const cookies = Array.isArray(setCookie) ? setCookie : [setCookie ?? '']
  return cookies.map((c) => c.split(';')[0]).join('; ')
}

let app: FastifyInstance

beforeAll(async () => {
  // Patch env object so billing handler sees Stripe as configured.
  // ts-jest uses CommonJS — env is the same object reference across all modules.
  Object.assign(env, {
    STRIPE_SECRET_KEY: 'sk_test_billing_test',
    STRIPE_STARTER_MONTHLY_PRICE_ID: 'price_starter_monthly',
    STRIPE_STARTER_ANNUAL_PRICE_ID: 'price_starter_annual',
    STRIPE_PRO_MONTHLY_PRICE_ID: 'price_pro_monthly',
    STRIPE_PRO_ANNUAL_PRICE_ID: 'price_pro_annual',
  })

  await prisma.organization.deleteMany({ where: { name: { contains: RUN } } })
  app = await buildApp()
})

beforeEach(() => {
  mockCustomersCreate.mockReset()
  mockSessionsCreate.mockReset()
  mockCustomersCreate.mockResolvedValue({ id: 'cus_test123' })
  mockSessionsCreate.mockResolvedValue({ url: 'https://checkout.stripe.com/pay/test_session' })
})

afterAll(async () => {
  await app.close()
  try {
    if (createdOrgIds.length > 0) {
      await prisma.organization.deleteMany({ where: { id: { in: createdOrgIds } } })
    }
  } finally {
    await prisma.$disconnect()
  }
})

// env.FRONTEND_URL defaults to 'http://localhost:3000' — all redirect URLs must use this origin.
const SUCCESS_URL = 'http://localhost:3000/success'
const CANCEL_URL  = 'http://localhost:3000/cancel'

// ─── POST /api/v1/billing/checkout — happy path ──────────────────────────────

describe('POST /api/v1/billing/checkout — happy path', () => {
  it('returns 201 with url for owner on free plan (annual starter default)', async () => {
    const { cookie } = await registerAndGetCookie(app, 'hp-annual-starter')

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/checkout',
      headers: { cookie },
      payload: { plan: 'starter', success_url: SUCCESS_URL, cancel_url: CANCEL_URL },
    })

    expect(res.statusCode).toBe(201)
    const body = JSON.parse(res.body)
    expect(body.url).toBe('https://checkout.stripe.com/pay/test_session')
  })

  it('returns 201 with url for monthly pro', async () => {
    const { cookie } = await registerAndGetCookie(app, 'hp-monthly-pro')

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/checkout',
      headers: { cookie },
      payload: { plan: 'pro', interval: 'monthly', success_url: SUCCESS_URL, cancel_url: CANCEL_URL },
    })

    expect(res.statusCode).toBe(201)
    expect(mockSessionsCreate.mock.calls[0][0].line_items[0].price).toBe('price_pro_monthly')
  })

  it('creates a Stripe customer when stripeCustomerId is null and persists it', async () => {
    const { cookie, orgId } = await registerAndGetCookie(app, 'hp-new-customer')

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/checkout',
      headers: { cookie },
      payload: { plan: 'starter', interval: 'annual', success_url: SUCCESS_URL, cancel_url: CANCEL_URL },
    })

    expect(res.statusCode).toBe(201)
    expect(mockCustomersCreate).toHaveBeenCalledTimes(1)
    expect(mockCustomersCreate).toHaveBeenCalledWith({ metadata: { orgId } })

    const org = await prisma.organization.findUnique({
      where: { id: orgId },
      select: { stripeCustomerId: true },
    })
    expect(org?.stripeCustomerId).toBe('cus_test123')
  })

  it('reuses existing stripeCustomerId — does not call customers.create', async () => {
    const { cookie, orgId } = await registerAndGetCookie(app, 'hp-reuse-customer')
    await prisma.organization.update({
      where: { id: orgId },
      data: { stripeCustomerId: 'cus_existing456' },
    })

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/checkout',
      headers: { cookie },
      payload: { plan: 'starter', interval: 'annual', success_url: SUCCESS_URL, cancel_url: CANCEL_URL },
    })

    expect(res.statusCode).toBe(201)
    expect(mockCustomersCreate).not.toHaveBeenCalled()
    expect(mockSessionsCreate.mock.calls[0][0].customer).toBe('cus_existing456')
  })

  it('passes correct priceId for each plan+interval combo', async () => {
    const combos = [
      { plan: 'starter', interval: 'monthly', expected: 'price_starter_monthly' },
      { plan: 'starter', interval: 'annual',  expected: 'price_starter_annual'  },
      { plan: 'pro',     interval: 'monthly', expected: 'price_pro_monthly'     },
      { plan: 'pro',     interval: 'annual',  expected: 'price_pro_annual'      },
    ] as const

    for (const combo of combos) {
      mockSessionsCreate.mockReset()
      mockCustomersCreate.mockReset()
      mockCustomersCreate.mockResolvedValue({ id: 'cus_test123' })
      mockSessionsCreate.mockResolvedValue({ url: 'https://checkout.stripe.com/pay/x' })

      const { cookie } = await registerAndGetCookie(app, `hp-priceid-${combo.plan}-${combo.interval}`)

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/billing/checkout',
        headers: { cookie },
        payload: { plan: combo.plan, interval: combo.interval, success_url: SUCCESS_URL, cancel_url: CANCEL_URL },
      })

      expect(res.statusCode).toBe(201)
      expect(mockSessionsCreate.mock.calls[0][0].line_items[0].price).toBe(combo.expected)
    }
  })

  it('passes success_url and cancel_url through to Stripe', async () => {
    const { cookie } = await registerAndGetCookie(app, 'hp-urls')
    const successWithToken = `${SUCCESS_URL}?session_id={CHECKOUT_SESSION_ID}`

    await app.inject({
      method: 'POST',
      url: '/api/v1/billing/checkout',
      headers: { cookie },
      payload: { plan: 'starter', interval: 'annual', success_url: successWithToken, cancel_url: CANCEL_URL },
    })

    const callArgs = mockSessionsCreate.mock.calls[0][0]
    expect(callArgs.success_url).toBe(successWithToken)
    expect(callArgs.cancel_url).toBe(CANCEL_URL)
  })

  it('defaults interval to annual when omitted', async () => {
    const { cookie } = await registerAndGetCookie(app, 'hp-default-interval')

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/checkout',
      headers: { cookie },
      payload: { plan: 'pro', success_url: SUCCESS_URL, cancel_url: CANCEL_URL },
    })

    expect(res.statusCode).toBe(201)
    expect(mockSessionsCreate.mock.calls[0][0].line_items[0].price).toBe('price_pro_annual')
  })
})

// ─── POST /api/v1/billing/checkout — auth guards ─────────────────────────────

describe('POST /api/v1/billing/checkout — auth guards', () => {
  it('returns 401 when unauthenticated', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/checkout',
      payload: { plan: 'starter', success_url: SUCCESS_URL, cancel_url: CANCEL_URL },
    })

    expect(res.statusCode).toBe(401)
  })

  it('returns 403 when editor calls endpoint', async () => {
    const { orgId } = await registerAndGetCookie(app, 'auth-editor-org')
    const editorCookie = await createEditorCookie(app, orgId, 'auth-editor')

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/checkout',
      headers: { cookie: editorCookie },
      payload: { plan: 'starter', success_url: SUCCESS_URL, cancel_url: CANCEL_URL },
    })

    expect(res.statusCode).toBe(403)
    expect(JSON.parse(res.body).message).toMatch(/owner/)
  })
})

// ─── POST /api/v1/billing/checkout — validation ──────────────────────────────

describe('POST /api/v1/billing/checkout — validation', () => {
  let ownerCookie: string

  beforeAll(async () => {
    const { cookie } = await registerAndGetCookie(app, 'validation-owner')
    ownerCookie = cookie
  })

  it('returns 422 for missing plan', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/checkout',
      headers: { cookie: ownerCookie },
      payload: { success_url: SUCCESS_URL, cancel_url: CANCEL_URL },
    })
    expect(res.statusCode).toBe(422)
  })

  it('returns 422 for invalid plan value', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/checkout',
      headers: { cookie: ownerCookie },
      payload: { plan: 'enterprise', success_url: SUCCESS_URL, cancel_url: CANCEL_URL },
    })
    expect(res.statusCode).toBe(422)
  })

  it('returns 422 for invalid interval value', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/checkout',
      headers: { cookie: ownerCookie },
      payload: { plan: 'starter', interval: 'weekly', success_url: SUCCESS_URL, cancel_url: CANCEL_URL },
    })
    expect(res.statusCode).toBe(422)
  })

  it('returns 422 for missing success_url', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/checkout',
      headers: { cookie: ownerCookie },
      payload: { plan: 'starter', cancel_url: CANCEL_URL },
    })
    expect(res.statusCode).toBe(422)
  })

  it('returns 422 for non-URL success_url', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/checkout',
      headers: { cookie: ownerCookie },
      payload: { plan: 'starter', success_url: 'not-a-url', cancel_url: CANCEL_URL },
    })
    expect(res.statusCode).toBe(422)
  })

  it('returns 422 for missing cancel_url', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/checkout',
      headers: { cookie: ownerCookie },
      payload: { plan: 'starter', success_url: SUCCESS_URL },
    })
    expect(res.statusCode).toBe(422)
  })

  it('returns 422 for non-URL cancel_url', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/checkout',
      headers: { cookie: ownerCookie },
      payload: { plan: 'starter', success_url: SUCCESS_URL, cancel_url: 'not-a-url' },
    })
    expect(res.statusCode).toBe(422)
  })

  it('returns 422 for redirect URL on wrong origin', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/checkout',
      headers: { cookie: ownerCookie },
      payload: {
        plan: 'starter',
        success_url: 'https://evil.com/steal',
        cancel_url: CANCEL_URL,
      },
    })
    expect(res.statusCode).toBe(422)
    expect(JSON.parse(res.body).message).toMatch(/application domain/)
  })
})

// ─── POST /api/v1/billing/checkout — conflict guard ──────────────────────────

describe('POST /api/v1/billing/checkout — conflict guard', () => {
  it('returns 409 when org plan is already starter', async () => {
    const { cookie, orgId } = await registerAndGetCookie(app, 'conflict-starter')
    await prisma.organization.update({ where: { id: orgId }, data: { plan: 'starter' } })

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/checkout',
      headers: { cookie },
      payload: { plan: 'pro', success_url: SUCCESS_URL, cancel_url: CANCEL_URL },
    })

    expect(res.statusCode).toBe(409)
    expect(JSON.parse(res.body).message).toMatch(/active subscription/)
  })

  it('returns 409 when org plan is already pro', async () => {
    const { cookie, orgId } = await registerAndGetCookie(app, 'conflict-pro')
    await prisma.organization.update({ where: { id: orgId }, data: { plan: 'pro' } })

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/checkout',
      headers: { cookie },
      payload: { plan: 'starter', success_url: SUCCESS_URL, cancel_url: CANCEL_URL },
    })

    expect(res.statusCode).toBe(409)
  })
})

// ─── POST /api/v1/billing/checkout — Stripe not configured ───────────────────

describe('POST /api/v1/billing/checkout — Stripe not configured', () => {
  let savedKey: unknown

  // Save/restore in beforeEach+afterEach so env is always restored even if a test throws.
  beforeEach(() => {
    savedKey = (env as Record<string, unknown>).STRIPE_SECRET_KEY
    ;(env as Record<string, unknown>).STRIPE_SECRET_KEY = undefined
  })

  afterEach(() => {
    ;(env as Record<string, unknown>).STRIPE_SECRET_KEY = savedKey
  })

  it('returns 503 when STRIPE_SECRET_KEY is absent', async () => {
    const { cookie } = await registerAndGetCookie(app, 'no-stripe')

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/checkout',
      headers: { cookie },
      payload: { plan: 'starter', success_url: SUCCESS_URL, cancel_url: CANCEL_URL },
    })

    expect(res.statusCode).toBe(503)
    expect(JSON.parse(res.body).message).toMatch(/billing not configured/i)
  })
})

// ─── POST /api/v1/billing/checkout — Stripe SDK errors ───────────────────────

describe('POST /api/v1/billing/checkout — Stripe SDK errors', () => {
  it('returns 500 on Stripe customers.create failure', async () => {
    mockCustomersCreate.mockRejectedValue(new Error('Stripe network error'))
    const { cookie } = await registerAndGetCookie(app, 'stripe-err-customers')

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/checkout',
      headers: { cookie },
      payload: { plan: 'starter', success_url: SUCCESS_URL, cancel_url: CANCEL_URL },
    })

    expect(res.statusCode).toBe(500)
  })

  it('returns 500 on Stripe sessions.create failure', async () => {
    mockSessionsCreate.mockRejectedValue(new Error('Stripe session error'))
    const { cookie, orgId } = await registerAndGetCookie(app, 'stripe-err-sessions')
    await prisma.organization.update({
      where: { id: orgId },
      data: { stripeCustomerId: 'cus_existing_for_err' },
    })

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/checkout',
      headers: { cookie },
      payload: { plan: 'starter', success_url: SUCCESS_URL, cancel_url: CANCEL_URL },
    })

    expect(res.statusCode).toBe(500)
  })

  it('returns 500 when Stripe session has no url', async () => {
    mockSessionsCreate.mockResolvedValue({ url: null })
    const { cookie, orgId } = await registerAndGetCookie(app, 'stripe-null-url')
    await prisma.organization.update({
      where: { id: orgId },
      data: { stripeCustomerId: 'cus_null_url' },
    })

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/checkout',
      headers: { cookie },
      payload: { plan: 'starter', success_url: SUCCESS_URL, cancel_url: CANCEL_URL },
    })

    expect(res.statusCode).toBe(500)
  })
})
