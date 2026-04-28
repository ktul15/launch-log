import { FastifyInstance } from 'fastify'
import Stripe from 'stripe'
import { z } from 'zod'
import { authenticate } from '../middleware/authenticate'
import { env } from '../config/env'
import { PLAN_LIMITS } from '../utils/planLimits'

const BILLING_RATE_LIMIT = env.NODE_ENV === 'test' ? 100_000 : 10

const portalSchema = z.object({
  return_url: z.string().url('return_url must be a valid URL'),
})

const checkoutSchema = z.object({
  plan: z.enum(['starter', 'pro'], { required_error: 'plan is required' }),
  interval: z.enum(['monthly', 'annual']).default('annual'),
  success_url: z.string().url('success_url must be a valid URL'),
  cancel_url: z.string().url('cancel_url must be a valid URL'),
})

// Compares URL origins rather than using startsWith, which is vulnerable to
// subdomain prefix bypass (e.g. "http://app.com.evil.com/" starts with "http://app.com").
function isSameOrigin(url: string, base: string): boolean {
  return new URL(url).origin === new URL(base).origin
}

// env.ts enforces all-or-nothing for Stripe checkout vars — all four price IDs
// are present whenever STRIPE_SECRET_KEY is set, so non-null assertions are safe.
function getPriceId(plan: 'starter' | 'pro', interval: 'monthly' | 'annual'): string {
  if (plan === 'starter' && interval === 'monthly') return env.STRIPE_STARTER_MONTHLY_PRICE_ID!
  if (plan === 'starter' && interval === 'annual')  return env.STRIPE_STARTER_ANNUAL_PRICE_ID!
  if (plan === 'pro'     && interval === 'monthly') return env.STRIPE_PRO_MONTHLY_PRICE_ID!
  return env.STRIPE_PRO_ANNUAL_PRICE_ID!
}

// Reverse map: Stripe price ID → internal plan name.
// Returns null for unknown price IDs (e.g. one-off charges, legacy prices).
function planFromPriceId(priceId: string): 'starter' | 'pro' | null {
  const map: Record<string, 'starter' | 'pro'> = {
    [env.STRIPE_STARTER_MONTHLY_PRICE_ID!]: 'starter',
    [env.STRIPE_STARTER_ANNUAL_PRICE_ID!]:  'starter',
    [env.STRIPE_PRO_MONTHLY_PRICE_ID!]:     'pro',
    [env.STRIPE_PRO_ANNUAL_PRICE_ID!]:      'pro',
  }
  return map[priceId] ?? null
}

// Lazy singleton — created on first request so the Stripe SDK's internal HTTP
// connection pool is reused across requests rather than rebuilt per call.
let stripeInstance: Stripe | undefined

export default async function billingRoutes(fastify: FastifyInstance) {
  fastify.post('/checkout', {
    onRequest: [authenticate],
    config: { rateLimit: { max: BILLING_RATE_LIMIT, timeWindow: 60_000 } },
    handler: async (req, reply) => {
      if (!env.STRIPE_SECRET_KEY) {
        return reply.status(503).send({ message: 'Billing not configured' })
      }

      const { orgId, role } = req.user
      if (role !== 'owner') {
        return reply.status(403).send({ message: 'Only organisation owners can start a checkout' })
      }

      const parsed = checkoutSchema.safeParse(req.body)
      if (!parsed.success) {
        return reply.status(422).send({ message: parsed.error.issues.map(i => i.message).join(', ') })
      }
      const { plan, interval, success_url, cancel_url } = parsed.data

      if (!isSameOrigin(success_url, env.FRONTEND_URL) || !isSameOrigin(cancel_url, env.FRONTEND_URL)) {
        return reply.status(422).send({ message: 'Redirect URLs must be on the application domain' })
      }

      const priceId = getPriceId(plan, interval)

      const org = await fastify.prisma.organization.findUnique({
        where: { id: orgId },
        select: { id: true, plan: true, stripeCustomerId: true },
      })
      if (!org) {
        return reply.status(404).send({ message: 'Organisation not found' })
      }

      if (org.plan !== 'free') {
        return reply.status(409).send({ message: 'Organisation already has an active subscription' })
      }

      stripeInstance ??= new Stripe(env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' })
      const stripe = stripeInstance

      let customerId = org.stripeCustomerId
      if (!customerId) {
        const customer = await stripe.customers.create({ metadata: { orgId } })
        // Conditional update guards against duplicate customer creation from concurrent requests.
        // If another request already persisted a customer ID, count=0 and we use theirs.
        const updated = await fastify.prisma.organization.updateMany({
          where: { id: orgId, stripeCustomerId: null },
          data: { stripeCustomerId: customer.id },
        })
        if (updated.count === 0) {
          const fresh = await fastify.prisma.organization.findUnique({
            where: { id: orgId },
            select: { stripeCustomerId: true },
          })
          customerId = fresh!.stripeCustomerId!
        } else {
          customerId = customer.id
        }
      }

      const session = await stripe.checkout.sessions.create({
        mode: 'subscription',
        customer: customerId,
        line_items: [{ price: priceId, quantity: 1 }],
        success_url,
        cancel_url,
      })

      if (!session.url) {
        throw new Error('No checkout URL returned from Stripe')
      }

      return reply.status(200).send({ url: session.url })
    },
  })

  fastify.post('/portal', {
    onRequest: [authenticate],
    config: { rateLimit: { max: BILLING_RATE_LIMIT, timeWindow: 60_000 } },
    handler: async (req, reply) => {
      if (!env.STRIPE_SECRET_KEY) {
        return reply.status(503).send({ message: 'Billing not configured' })
      }

      const { orgId, role } = req.user
      if (role !== 'owner') {
        return reply.status(403).send({ message: 'Only organisation owners can manage billing' })
      }

      const parsed = portalSchema.safeParse(req.body)
      if (!parsed.success) {
        return reply.status(422).send({ message: parsed.error.issues.map(i => i.message).join(', ') })
      }
      const { return_url } = parsed.data

      if (!isSameOrigin(return_url, env.FRONTEND_URL)) {
        return reply.status(422).send({ message: 'Redirect URLs must be on the application domain' })
      }

      const org = await fastify.prisma.organization.findUnique({
        where: { id: orgId },
        select: { id: true, stripeCustomerId: true },
      })
      if (!org) {
        return reply.status(404).send({ message: 'Organisation not found' })
      }

      if (!org.stripeCustomerId) {
        // Free orgs with no prior Stripe customer have nothing to manage in the portal.
        // Orgs that cancelled (plan downgraded to free by webhook but stripeCustomerId retained)
        // are intentionally allowed through — the portal lets them resubscribe, and the
        // subscription.created webhook will update org.plan on completion.
        return reply.status(422).send({ message: 'Organisation has no billing account' })
      }

      stripeInstance ??= new Stripe(env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' })
      const stripe = stripeInstance

      const session = await stripe.billingPortal.sessions.create({
        customer: org.stripeCustomerId,
        return_url,
      })

      if (!session.url) {
        throw new Error('No portal URL returned from Stripe')
      }

      return reply.status(200).send({ url: session.url })
    },
  })

  fastify.get('/', {
    onRequest: [authenticate],
    config: { rateLimit: { max: BILLING_RATE_LIMIT, timeWindow: 60_000 } },
    handler: async (req, reply) => {
      const { orgId } = req.user

      const org = await fastify.prisma.organization.findUnique({
        where: { id: orgId },
        select: {
          plan: true,
          stripeSubscriptionId: true,
          _count: { select: { projects: { where: { isActive: true } } } },
        },
      })
      if (!org) {
        return reply.status(404).send({ message: 'Organisation not found' })
      }

      const projectCount = org._count.projects
      const rawLimit = PLAN_LIMITS.projects[org.plan]
      const projectLimit = rawLimit === Infinity ? null : rawLimit

      let nextBillingDate: string | null = null
      if (org.stripeSubscriptionId && env.STRIPE_SECRET_KEY) {
        try {
          stripeInstance ??= new Stripe(env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' })
          const sub = await stripeInstance.subscriptions.retrieve(org.stripeSubscriptionId)
          // Only return a date for subscriptions that will actually renew.
          // cancel_at_period_end=true means the period end is a cancellation date, not a billing date.
          if ((sub.status === 'active' || sub.status === 'trialing') && !sub.cancel_at_period_end) {
            nextBillingDate = new Date(sub.current_period_end * 1000).toISOString()
          }
        } catch {
          // Stale subscription ID (e.g. deleted in Stripe without webhook) — degrade gracefully.
        }
      }

      return reply.send({ plan: org.plan, projectCount, projectLimit, nextBillingDate })
    },
  })

  // Webhook route runs in a child scope so the raw-body content type parser
  // doesn't override the default JSON parser used by /checkout and /portal.
  fastify.register(async (webhookScope) => {
    // Parse application/json as a raw Buffer — Stripe signature verification
    // requires the exact bytes that were signed, before any JSON parsing.
    webhookScope.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer' },
      (_req, body, done) => { done(null, body) },
    )

    webhookScope.post('/webhook', {
      handler: async (req, reply) => {
        if (!env.STRIPE_WEBHOOK_SECRET || !env.STRIPE_SECRET_KEY) {
          return reply.status(503).send({ message: 'Webhook not configured' })
        }

        const sig = req.headers['stripe-signature']
        if (!sig || Array.isArray(sig)) {
          return reply.status(400).send({ message: 'Missing Stripe-Signature header' })
        }

        stripeInstance ??= new Stripe(env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' })
        const stripe = stripeInstance

        let event: Stripe.Event
        try {
          event = stripe.webhooks.constructEvent(req.body as Buffer, sig, env.STRIPE_WEBHOOK_SECRET)
        } catch {
          return reply.status(400).send({ message: 'Invalid signature' })
        }

        switch (event.type) {
          case 'checkout.session.completed': {
            // Only record the subscription ID — plan is synced by customer.subscription.updated,
            // which Stripe fires immediately after. This avoids an extra subscriptions.retrieve
            // call that would create a second independent failure point for the same payment.
            const session = event.data.object as Stripe.Checkout.Session
            if (session.mode !== 'subscription' || !session.subscription || !session.customer) break
            await fastify.prisma.organization.updateMany({
              where: { stripeCustomerId: session.customer as string },
              data: { stripeSubscriptionId: session.subscription as string },
            })
            break
          }

          case 'customer.subscription.updated': {
            const sub = event.data.object as Stripe.Subscription
            if (!sub.items.data[0]) break
            const plan = planFromPriceId(sub.items.data[0].price.id)
            const active = ['active', 'trialing'].includes(sub.status)
            await fastify.prisma.organization.updateMany({
              where: { stripeCustomerId: sub.customer as string },
              data: {
                plan: active && plan ? plan : 'free',
                stripeSubscriptionId: sub.id,
              },
            })
            break
          }

          case 'customer.subscription.deleted': {
            const sub = event.data.object as Stripe.Subscription
            // Downgrade to free and clear the subscription ID. stripeCustomerId is retained
            // so the portal lets the org resubscribe without creating a duplicate customer.
            await fastify.prisma.organization.updateMany({
              where: { stripeCustomerId: sub.customer as string },
              data: { plan: 'free', stripeSubscriptionId: null },
            })
            break
          }

          default:
            break
        }

        return reply.status(200).send({ received: true })
      },
    })
  })
}
