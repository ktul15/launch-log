import crypto from 'crypto'
import { buildApp } from '../index'
import { FastifyInstance } from 'fastify'
import { PrismaClient } from '@prisma/client'
import { env } from '../config/env'

const mockCustomersCreate = jest.fn()
const mockSessionsCreate = jest.fn()
const mockPortalSessionsCreate = jest.fn()
const mockWebhooksConstructEvent = jest.fn()
const mockSubscriptionsRetrieve = jest.fn()

jest.mock('stripe', () => ({
  __esModule: true,
  default: function Stripe() {
    return {
      customers: { create: mockCustomersCreate },
      checkout: { sessions: { create: mockSessionsCreate } },
      billingPortal: { sessions: { create: mockPortalSessionsCreate } },
      webhooks: { constructEvent: mockWebhooksConstructEvent },
      subscriptions: { retrieve: mockSubscriptionsRetrieve },
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
    STRIPE_WEBHOOK_SECRET: 'whsec_test_secret',
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
  mockPortalSessionsCreate.mockReset()
  mockWebhooksConstructEvent.mockReset()
  mockSubscriptionsRetrieve.mockReset()
  mockCustomersCreate.mockResolvedValue({ id: 'cus_test123' })
  mockSessionsCreate.mockResolvedValue({ url: 'https://checkout.stripe.com/pay/test_session' })
  mockPortalSessionsCreate.mockResolvedValue({ url: 'https://billing.stripe.com/session/test_portal' })
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
  it('returns 200 with url for owner on free plan (annual starter default)', async () => {
    const { cookie } = await registerAndGetCookie(app, 'hp-annual-starter')

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/checkout',
      headers: { cookie },
      payload: { plan: 'starter', success_url: SUCCESS_URL, cancel_url: CANCEL_URL },
    })

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.url).toBe('https://checkout.stripe.com/pay/test_session')
  })

  it('returns 200 with url for monthly pro', async () => {
    const { cookie } = await registerAndGetCookie(app, 'hp-monthly-pro')

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/checkout',
      headers: { cookie },
      payload: { plan: 'pro', interval: 'monthly', success_url: SUCCESS_URL, cancel_url: CANCEL_URL },
    })

    expect(res.statusCode).toBe(200)
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

    expect(res.statusCode).toBe(200)
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

    expect(res.statusCode).toBe(200)
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

      expect(res.statusCode).toBe(200)
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

    expect(res.statusCode).toBe(200)
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

  it('returns 422 for subdomain prefix bypass on success_url (startsWith attack)', async () => {
    // localhost:3000 includes a port so the bypass URL is not valid per URL spec.
    // Override to a port-free domain to test the real production attack vector:
    // "https://example.com.evil.com/" starts with "https://example.com" but has a different origin.
    const savedUrl = (env as Record<string, unknown>).FRONTEND_URL
    ;(env as Record<string, unknown>).FRONTEND_URL = 'http://launchlog-test.com'
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/billing/checkout',
        headers: { cookie: ownerCookie },
        payload: {
          plan: 'starter',
          success_url: 'http://launchlog-test.com.evil.com/steal',
          cancel_url: 'http://launchlog-test.com/cancel',
        },
      })
      expect(res.statusCode).toBe(422)
      expect(JSON.parse(res.body).message).toMatch(/application domain/)
    } finally {
      ;(env as Record<string, unknown>).FRONTEND_URL = savedUrl
    }
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

// ─── POST /api/v1/billing/portal — happy path ────────────────────────────────

const RETURN_URL = 'http://localhost:3000/settings/billing'

describe('POST /api/v1/billing/portal — happy path', () => {
  it('returns 200 with portal url for owner with stripeCustomerId', async () => {
    const { cookie, orgId } = await registerAndGetCookie(app, 'portal-hp')
    await prisma.organization.update({
      where: { id: orgId },
      data: { stripeCustomerId: 'cus_portal_happy' },
    })

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/portal',
      headers: { cookie },
      payload: { return_url: RETURN_URL },
    })

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.url).toBe('https://billing.stripe.com/session/test_portal')
  })

  it('passes correct customer and return_url to Stripe', async () => {
    const { cookie, orgId } = await registerAndGetCookie(app, 'portal-hp-args')
    await prisma.organization.update({
      where: { id: orgId },
      data: { stripeCustomerId: 'cus_portal_args_check' },
    })

    await app.inject({
      method: 'POST',
      url: '/api/v1/billing/portal',
      headers: { cookie },
      payload: { return_url: RETURN_URL },
    })

    expect(mockPortalSessionsCreate).toHaveBeenCalledWith({
      customer: 'cus_portal_args_check',
      return_url: RETURN_URL,
    })
  })
})

// ─── POST /api/v1/billing/portal — auth guards ───────────────────────────────

describe('POST /api/v1/billing/portal — auth guards', () => {
  it('returns 401 when unauthenticated', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/portal',
      payload: { return_url: RETURN_URL },
    })

    expect(res.statusCode).toBe(401)
  })

  it('returns 403 when editor calls endpoint', async () => {
    const { orgId } = await registerAndGetCookie(app, 'portal-auth-editor-org')
    const editorCookie = await createEditorCookie(app, orgId, 'portal-auth-editor')

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/portal',
      headers: { cookie: editorCookie },
      payload: { return_url: RETURN_URL },
    })

    expect(res.statusCode).toBe(403)
    expect(JSON.parse(res.body).message).toMatch(/owner/)
  })
})

// ─── POST /api/v1/billing/portal — validation ────────────────────────────────

// Shared across validation and Stripe-not-configured suites to avoid redundant registrations.
let portalSharedOwnerCookie: string

describe('POST /api/v1/billing/portal — validation', () => {
  let ownerOrgId: string

  beforeAll(async () => {
    const { cookie, orgId } = await registerAndGetCookie(app, 'portal-validation-owner')
    portalSharedOwnerCookie = cookie
    ownerOrgId = orgId
    await prisma.organization.update({
      where: { id: ownerOrgId },
      data: { stripeCustomerId: 'cus_portal_validation' },
    })
  })

  it('returns 422 for missing return_url', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/portal',
      headers: { cookie: portalSharedOwnerCookie },
      payload: {},
    })
    expect(res.statusCode).toBe(422)
  })

  it('returns 422 for non-URL return_url', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/portal',
      headers: { cookie: portalSharedOwnerCookie },
      payload: { return_url: 'not-a-url' },
    })
    expect(res.statusCode).toBe(422)
  })

  it('returns 422 for return_url on wrong origin', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/portal',
      headers: { cookie: portalSharedOwnerCookie },
      payload: { return_url: 'https://evil.com/steal' },
    })
    expect(res.statusCode).toBe(422)
    expect(JSON.parse(res.body).message).toMatch(/application domain/)
  })

  it('returns 422 for subdomain prefix bypass (startsWith attack)', async () => {
    // localhost:3000 includes a port so the bypass URL is not valid per URL spec.
    // Override to a port-free domain to test the real production attack vector:
    // "https://example.com.evil.com/" starts with "https://example.com" but has a different origin.
    const savedUrl = (env as Record<string, unknown>).FRONTEND_URL
    ;(env as Record<string, unknown>).FRONTEND_URL = 'http://launchlog-test.com'
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/billing/portal',
        headers: { cookie: portalSharedOwnerCookie },
        payload: { return_url: 'http://launchlog-test.com.evil.com/steal' },
      })
      expect(res.statusCode).toBe(422)
      expect(JSON.parse(res.body).message).toMatch(/application domain/)
    } finally {
      ;(env as Record<string, unknown>).FRONTEND_URL = savedUrl
    }
  })
})

// ─── POST /api/v1/billing/portal — no billing account ───────────────────────

describe('POST /api/v1/billing/portal — no billing account', () => {
  it('returns 422 when org has no stripeCustomerId', async () => {
    const { cookie } = await registerAndGetCookie(app, 'portal-no-customer')

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/portal',
      headers: { cookie },
      payload: { return_url: RETURN_URL },
    })

    expect(res.statusCode).toBe(422)
    expect(JSON.parse(res.body).message).toMatch(/no billing account/)
  })
})

// ─── POST /api/v1/billing/portal — Stripe not configured ─────────────────────

describe('POST /api/v1/billing/portal — Stripe not configured', () => {
  let savedKey: unknown

  beforeEach(() => {
    savedKey = (env as Record<string, unknown>).STRIPE_SECRET_KEY
    ;(env as Record<string, unknown>).STRIPE_SECRET_KEY = undefined
  })

  afterEach(() => {
    ;(env as Record<string, unknown>).STRIPE_SECRET_KEY = savedKey
  })

  it('returns 503 when STRIPE_SECRET_KEY is absent', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/portal',
      headers: { cookie: portalSharedOwnerCookie },
      payload: { return_url: RETURN_URL },
    })

    expect(res.statusCode).toBe(503)
    expect(JSON.parse(res.body).message).toMatch(/billing not configured/i)
  })
})

// ─── POST /api/v1/billing/portal — Stripe SDK errors ─────────────────────────

describe('POST /api/v1/billing/portal — Stripe SDK errors', () => {
  it('returns 500 on billingPortal.sessions.create failure', async () => {
    mockPortalSessionsCreate.mockRejectedValue(new Error('Stripe portal error'))
    const { cookie, orgId } = await registerAndGetCookie(app, 'portal-stripe-err')
    await prisma.organization.update({
      where: { id: orgId },
      data: { stripeCustomerId: 'cus_portal_err' },
    })

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/portal',
      headers: { cookie },
      payload: { return_url: RETURN_URL },
    })

    expect(res.statusCode).toBe(500)
  })

  it('returns 500 when Stripe portal session has no url', async () => {
    mockPortalSessionsCreate.mockResolvedValue({ url: null })
    const { cookie, orgId } = await registerAndGetCookie(app, 'portal-null-url')
    await prisma.organization.update({
      where: { id: orgId },
      data: { stripeCustomerId: 'cus_portal_null_url' },
    })

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/portal',
      headers: { cookie },
      payload: { return_url: RETURN_URL },
    })

    expect(res.statusCode).toBe(500)
  })
})

// ─── POST /api/v1/billing/webhook — helpers ───────────────────────────────────

function makeWebhookPayload(event: object): Buffer {
  return Buffer.from(JSON.stringify(event))
}

function buildSubscriptionEvent(
  type: string,
  customerId: string,
  priceId: string,
  status: string,
  subscriptionId = 'sub_test001',
) {
  return {
    type,
    data: {
      object: {
        id: subscriptionId,
        customer: customerId,
        status,
        items: { data: [{ price: { id: priceId } }] },
      },
    },
  }
}

// ─── POST /api/v1/billing/webhook — signature validation ─────────────────────

describe('POST /api/v1/billing/webhook — signature validation', () => {
  it('returns 400 when Stripe-Signature header is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/webhook',
      headers: { 'content-type': 'application/json' },
      body: makeWebhookPayload({ type: 'checkout.session.completed' }),
    })

    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).message).toBe('Missing Stripe-Signature header')
  })

  it('returns 400 when signature verification fails', async () => {
    mockWebhooksConstructEvent.mockImplementation(() => {
      throw new Error('Webhook signature verification failed')
    })

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/webhook',
      headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=bad' },
      body: makeWebhookPayload({ type: 'checkout.session.completed' }),
    })

    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).message).toBe('Invalid signature')
  })

  it('returns 503 when STRIPE_WEBHOOK_SECRET is not configured', async () => {
    const saved = env.STRIPE_WEBHOOK_SECRET
    Object.assign(env, { STRIPE_WEBHOOK_SECRET: undefined })

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/webhook',
      headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=sig' },
      body: makeWebhookPayload({ type: 'checkout.session.completed' }),
    })

    Object.assign(env, { STRIPE_WEBHOOK_SECRET: saved })
    expect(res.statusCode).toBe(503)
    expect(JSON.parse(res.body).message).toBe('Webhook not configured')
  })

  it('returns 503 when STRIPE_SECRET_KEY is not configured', async () => {
    const saved = env.STRIPE_SECRET_KEY
    Object.assign(env, { STRIPE_SECRET_KEY: undefined })

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/webhook',
      headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=sig' },
      body: makeWebhookPayload({ type: 'checkout.session.completed' }),
    })

    Object.assign(env, { STRIPE_SECRET_KEY: saved })
    expect(res.statusCode).toBe(503)
    expect(JSON.parse(res.body).message).toBe('Webhook not configured')
  })

  it('returns 200 for unknown event types without errors', async () => {
    const event = { type: 'invoice.paid', data: { object: {} } }
    mockWebhooksConstructEvent.mockReturnValue(event)

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/webhook',
      headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=sig' },
      body: makeWebhookPayload(event),
    })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ received: true })
  })
})

// ─── POST /api/v1/billing/webhook — checkout.session.completed ───────────────

describe('POST /api/v1/billing/webhook — checkout.session.completed', () => {
  it('saves stripeSubscriptionId when checkout completes', async () => {
    const { orgId } = await registerAndGetCookie(app, 'wh-checkout-sub-id')
    await prisma.organization.update({
      where: { id: orgId },
      data: { stripeCustomerId: 'cus_wh_checkout' },
    })

    const event = {
      type: 'checkout.session.completed',
      data: {
        object: {
          mode: 'subscription',
          customer: 'cus_wh_checkout',
          subscription: 'sub_wh_checkout',
        },
      },
    }
    mockWebhooksConstructEvent.mockReturnValue(event)

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/webhook',
      headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=sig' },
      body: makeWebhookPayload(event),
    })

    expect(res.statusCode).toBe(200)
    const org = await prisma.organization.findUnique({ where: { id: orgId } })
    expect(org?.stripeSubscriptionId).toBe('sub_wh_checkout')
    // plan is synced by customer.subscription.updated, not here
    expect(org?.plan).toBe('free')
    expect(mockSubscriptionsRetrieve).not.toHaveBeenCalled()
  })

  it('ignores sessions where mode is not subscription', async () => {
    const event = {
      type: 'checkout.session.completed',
      data: { object: { mode: 'payment', customer: 'cus_payment', subscription: null } },
    }
    mockWebhooksConstructEvent.mockReturnValue(event)

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/webhook',
      headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=sig' },
      body: makeWebhookPayload(event),
    })

    expect(res.statusCode).toBe(200)
    expect(mockSubscriptionsRetrieve).not.toHaveBeenCalled()
  })

  it('ignores sessions with null customer', async () => {
    const event = {
      type: 'checkout.session.completed',
      data: { object: { mode: 'subscription', customer: null, subscription: 'sub_orphan' } },
    }
    mockWebhooksConstructEvent.mockReturnValue(event)

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/webhook',
      headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=sig' },
      body: makeWebhookPayload(event),
    })

    expect(res.statusCode).toBe(200)
  })
})

// ─── POST /api/v1/billing/webhook — customer.subscription.updated ────────────

describe('POST /api/v1/billing/webhook — customer.subscription.updated', () => {
  it('syncs plan to starter when subscription is active', async () => {
    const { orgId } = await registerAndGetCookie(app, 'wh-sub-updated-active')
    await prisma.organization.update({
      where: { id: orgId },
      data: { stripeCustomerId: 'cus_wh_sub_active' },
    })

    const event = buildSubscriptionEvent(
      'customer.subscription.updated',
      'cus_wh_sub_active',
      'price_starter_monthly',
      'active',
      'sub_wh_updated_001',
    )
    mockWebhooksConstructEvent.mockReturnValue(event)

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/webhook',
      headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=sig' },
      body: makeWebhookPayload(event),
    })

    expect(res.statusCode).toBe(200)
    const org = await prisma.organization.findUnique({ where: { id: orgId } })
    expect(org?.plan).toBe('starter')
    expect(org?.stripeSubscriptionId).toBe('sub_wh_updated_001')
  })

  it('syncs plan when subscription status is trialing', async () => {
    const { orgId } = await registerAndGetCookie(app, 'wh-sub-updated-trialing')
    await prisma.organization.update({
      where: { id: orgId },
      data: { stripeCustomerId: 'cus_wh_sub_trial' },
    })

    const event = buildSubscriptionEvent(
      'customer.subscription.updated',
      'cus_wh_sub_trial',
      'price_pro_annual',
      'trialing',
    )
    mockWebhooksConstructEvent.mockReturnValue(event)

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/webhook',
      headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=sig' },
      body: makeWebhookPayload(event),
    })

    expect(res.statusCode).toBe(200)
    const org = await prisma.organization.findUnique({ where: { id: orgId } })
    expect(org?.plan).toBe('pro')
  })

  it('downgrades to free when subscription status is canceled', async () => {
    const { orgId } = await registerAndGetCookie(app, 'wh-sub-updated-canceled')
    await prisma.organization.update({
      where: { id: orgId },
      data: { stripeCustomerId: 'cus_wh_sub_canceled', plan: 'pro' },
    })

    const event = buildSubscriptionEvent(
      'customer.subscription.updated',
      'cus_wh_sub_canceled',
      'price_pro_annual',
      'canceled',
    )
    mockWebhooksConstructEvent.mockReturnValue(event)

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/webhook',
      headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=sig' },
      body: makeWebhookPayload(event),
    })

    expect(res.statusCode).toBe(200)
    const org = await prisma.organization.findUnique({ where: { id: orgId } })
    expect(org?.plan).toBe('free')
  })

  it('downgrades to free for active status with unknown price ID', async () => {
    const { orgId } = await registerAndGetCookie(app, 'wh-sub-updated-unknown-price')
    await prisma.organization.update({
      where: { id: orgId },
      data: { stripeCustomerId: 'cus_wh_sub_unknown', plan: 'starter' },
    })

    const event = buildSubscriptionEvent(
      'customer.subscription.updated',
      'cus_wh_sub_unknown',
      'price_legacy_plan',
      'active',
    )
    mockWebhooksConstructEvent.mockReturnValue(event)

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/webhook',
      headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=sig' },
      body: makeWebhookPayload(event),
    })

    expect(res.statusCode).toBe(200)
    const org = await prisma.organization.findUnique({ where: { id: orgId } })
    expect(org?.plan).toBe('free')
  })

  it('returns 200 without crashing when items.data is empty', async () => {
    const event = {
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: 'sub_empty_items',
          customer: 'cus_no_items',
          status: 'active',
          items: { data: [] },
        },
      },
    }
    mockWebhooksConstructEvent.mockReturnValue(event)

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/webhook',
      headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=sig' },
      body: makeWebhookPayload(event),
    })

    expect(res.statusCode).toBe(200)
  })
})

// ─── POST /api/v1/billing/webhook — customer.subscription.deleted ────────────

describe('POST /api/v1/billing/webhook — customer.subscription.deleted', () => {
  it('downgrades org to free and retains stripeCustomerId', async () => {
    const { orgId } = await registerAndGetCookie(app, 'wh-sub-deleted')
    await prisma.organization.update({
      where: { id: orgId },
      data: {
        stripeCustomerId: 'cus_wh_deleted',
        stripeSubscriptionId: 'sub_wh_deleted',
        plan: 'pro',
      },
    })

    const event = {
      type: 'customer.subscription.deleted',
      data: {
        object: {
          id: 'sub_wh_deleted',
          customer: 'cus_wh_deleted',
          status: 'canceled',
          items: { data: [{ price: { id: 'price_pro_annual' } }] },
        },
      },
    }
    mockWebhooksConstructEvent.mockReturnValue(event)

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/webhook',
      headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=sig' },
      body: makeWebhookPayload(event),
    })

    expect(res.statusCode).toBe(200)
    const org = await prisma.organization.findUnique({ where: { id: orgId } })
    expect(org?.plan).toBe('free')
    expect(org?.stripeCustomerId).toBe('cus_wh_deleted')
    expect(org?.stripeSubscriptionId).toBeNull()
  })
})
