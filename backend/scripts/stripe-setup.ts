/**
 * One-time script to create LaunchLog products and prices in Stripe.
 * Safe to re-run — uses metadata slugs for products, lookup_key for prices.
 *
 * Usage:
 *   1. Add STRIPE_SECRET_KEY to backend/.env
 *   2. npm run stripe:setup
 *   3. Paste the printed price IDs into backend/.env
 */

import Stripe from 'stripe'

const key = process.env.STRIPE_SECRET_KEY
if (!key) {
  console.error('Error: STRIPE_SECRET_KEY is not set. Add it to backend/.env first.')
  process.exit(1)
}

// Pin API version to match the installed SDK's type definitions.
const stripe = new Stripe(key, { apiVersion: '2024-06-20' })

async function findProductBySlug(slug: string): Promise<Stripe.Product | undefined> {
  // Use list (strongly consistent) filtered by metadata instead of search (eventually consistent).
  const all = await stripe.products.list({ active: true, limit: 100 })
  return all.data.find((p) => p.metadata?.slug === slug)
}

async function upsertPrice(params: {
  productId: string
  lookupKey: string
  unitAmount: number
  interval: 'month' | 'year'
}): Promise<string> {
  const existing = await stripe.prices.list({ lookup_keys: [params.lookupKey], limit: 1 })
  if (existing.data.length > 0) {
    console.log(`  [skip] ${params.lookupKey} already exists: ${existing.data[0].id}`)
    return existing.data[0].id
  }
  const price = await stripe.prices.create({
    product: params.productId,
    unit_amount: params.unitAmount,
    currency: 'usd',
    recurring: { interval: params.interval },
    lookup_key: params.lookupKey,
  })
  console.log(`  [created] ${params.lookupKey}: ${price.id}`)
  return price.id
}

async function upsertProduct(slug: string, name: string, description: string): Promise<Stripe.Product> {
  const existing = await findProductBySlug(slug)
  if (existing) {
    console.log(`[skip] ${name} already exists: ${existing.id}`)
    return existing
  }
  const product = await stripe.products.create({ name, description, metadata: { slug } })
  console.log(`[created] ${name}: ${product.id}`)
  return product
}

async function run() {
  console.log('\nSetting up LaunchLog Stripe products and prices...\n')

  const [freeProduct, starterProduct, proProduct] = await Promise.all([
    upsertProduct('launchlog-free', 'LaunchLog Free', 'Free tier — 1 project, community features, branded widget'),
    upsertProduct('launchlog-starter', 'LaunchLog Starter', '3 projects, white-labeled widget, full theming, 200 help articles, 3 surveys'),
    upsertProduct('launchlog-pro', 'LaunchLog Pro', 'Unlimited projects, team members, custom domain, advanced analytics, integrations, API access'),
  ])

  // Free product exists for dashboard clarity — free tier is never billed, no price needed.
  void freeProduct

  console.log('\nCreating prices...')
  const [starterMonthlyId, starterAnnualId, proMonthlyId, proAnnualId] = await Promise.all([
    upsertPrice({ productId: starterProduct.id, lookupKey: 'starter_monthly', unitAmount: 900,   interval: 'month' }),
    upsertPrice({ productId: starterProduct.id, lookupKey: 'starter_annual',  unitAmount: 9000,  interval: 'year'  }),
    upsertPrice({ productId: proProduct.id,     lookupKey: 'pro_monthly',     unitAmount: 1900,  interval: 'month' }),
    upsertPrice({ productId: proProduct.id,     lookupKey: 'pro_annual',      unitAmount: 18000, interval: 'year'  }),
  ])

  console.log('\n── Copy these into backend/.env ──────────────────────────\n')
  console.log(`STRIPE_STARTER_MONTHLY_PRICE_ID=${starterMonthlyId}`)
  console.log(`STRIPE_STARTER_ANNUAL_PRICE_ID=${starterAnnualId}`)
  console.log(`STRIPE_PRO_MONTHLY_PRICE_ID=${proMonthlyId}`)
  console.log(`STRIPE_PRO_ANNUAL_PRICE_ID=${proAnnualId}`)
  console.log('\n──────────────────────────────────────────────────────────\n')
}

run().catch((err: unknown) => {
  const stripe_err = err as Stripe.errors.StripeError
  if (stripe_err.type) {
    console.error(`Stripe setup failed [${stripe_err.type}] code=${stripe_err.code ?? 'none'}: ${stripe_err.message}`)
  } else {
    console.error('Stripe setup failed:', err instanceof Error ? err.message : err)
  }
  process.exit(1)
})
