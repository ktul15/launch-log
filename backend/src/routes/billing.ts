import { FastifyInstance } from 'fastify'
import Stripe from 'stripe'
import { z } from 'zod'
import { authenticate } from '../middleware/authenticate'
import { env } from '../config/env'

const BILLING_RATE_LIMIT = env.NODE_ENV === 'test' ? 100_000 : 10

const checkoutSchema = z.object({
  plan: z.enum(['starter', 'pro'], { required_error: 'plan is required' }),
  interval: z.enum(['monthly', 'annual']).default('annual'),
  success_url: z.string().url('success_url must be a valid URL'),
  cancel_url: z.string().url('cancel_url must be a valid URL'),
})

// env.ts enforces all-or-nothing for Stripe checkout vars — all four price IDs
// are present whenever STRIPE_SECRET_KEY is set, so non-null assertions are safe.
function getPriceId(plan: 'starter' | 'pro', interval: 'monthly' | 'annual'): string {
  if (plan === 'starter' && interval === 'monthly') return env.STRIPE_STARTER_MONTHLY_PRICE_ID!
  if (plan === 'starter' && interval === 'annual')  return env.STRIPE_STARTER_ANNUAL_PRICE_ID!
  if (plan === 'pro'     && interval === 'monthly') return env.STRIPE_PRO_MONTHLY_PRICE_ID!
  return env.STRIPE_PRO_ANNUAL_PRICE_ID!
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

      const { origin } = new URL(env.FRONTEND_URL)
      if (!success_url.startsWith(origin) || !cancel_url.startsWith(origin)) {
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

      return reply.status(201).send({ url: session.url })
    },
  })
}
