import type { Metadata } from 'next'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import BillingClient from './BillingClient'

export const metadata: Metadata = { title: 'Billing — LaunchLog' }

const BACKEND = process.env.BACKEND_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001'
const jwtShape = /^[\w-]+\.[\w-]+\.[\w-]+$/

function sanitizeToken(token: string): string | null {
  const stripped = token.replace(/[\r\n]/g, '')
  if (!/^[A-Za-z0-9\-_.]+$/.test(stripped)) return null
  return stripped
}

export interface BillingData {
  plan: 'free' | 'starter' | 'pro'
  projectCount: number
  projectLimit: number | null
  nextBillingDate: string | null
}

export default async function BillingPage() {
  const cookieStore = cookies()

  const rawAccess = cookieStore.get('access_token')?.value
  const safeAccess = rawAccess ? sanitizeToken(rawAccess) : null
  if (!safeAccess || !jwtShape.test(safeAccess)) redirect('/login')

  const rawRefresh = cookieStore.get('refresh_token')?.value
  const safeRefresh = rawRefresh ? sanitizeToken(rawRefresh) : null
  const validRefreshToken = safeRefresh && jwtShape.test(safeRefresh) ? safeRefresh : null

  const cookieHeader = validRefreshToken
    ? `access_token=${safeAccess}; refresh_token=${validRefreshToken}`
    : `access_token=${safeAccess}`

  const res = await fetch(`${BACKEND}/api/v1/billing`, {
    headers: { Cookie: cookieHeader },
    cache: 'no-store',
    signal: AbortSignal.timeout(5_000),
  })

  if (res.status === 401) redirect('/login')
  if (!res.ok) throw new Error(`Backend error: ${res.status}`)

  const raw = await res.json() as Record<string, unknown>

  if (
    !['free', 'starter', 'pro'].includes(raw.plan as string) ||
    typeof raw.projectCount !== 'number' ||
    (raw.projectLimit !== null && typeof raw.projectLimit !== 'number') ||
    (raw.nextBillingDate !== null && typeof raw.nextBillingDate !== 'string')
  ) {
    throw new Error('Unexpected billing response shape')
  }

  const data = raw as unknown as BillingData

  return <BillingClient {...data} />
}
