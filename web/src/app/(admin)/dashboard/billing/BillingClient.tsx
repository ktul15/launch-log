'use client'

import { useState, useEffect } from 'react'
import { useSearchParams } from 'next/navigation'
import { apiFetch } from '@/lib/api'
import type { BillingData } from './page'

const PLAN_LABELS: Record<string, string> = {
  free: 'Free',
  starter: 'Starter',
  pro: 'Pro',
}

const PLAN_BADGE_COLORS: Record<string, string> = {
  free: 'bg-gray-100 text-gray-700',
  starter: 'bg-indigo-100 text-indigo-700',
  pro: 'bg-violet-100 text-violet-700',
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return 'Unknown'
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
}

function isSafeRedirectUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:'
  } catch {
    return false
  }
}

export default function BillingClient({ plan, projectCount, projectLimit, nextBillingDate }: BillingData) {
  const searchParams = useSearchParams()
  const [error, setError] = useState<string | null>(null)
  const [loadingPlan, setLoadingPlan] = useState<string | null>(null)
  const [portalLoading, setPortalLoading] = useState(false)
  const [showSuccess, setShowSuccess] = useState(false)

  const anyLoading = loadingPlan !== null || portalLoading

  useEffect(() => {
    if (searchParams.get('success') === '1') {
      setShowSuccess(true)
      window.history.replaceState({}, '', '/dashboard/billing')
      const timer = setTimeout(() => setShowSuccess(false), 5000)
      return () => clearTimeout(timer)
    }
  }, [searchParams])

  async function handleUpgrade(targetPlan: 'starter' | 'pro') {
    setError(null)
    setLoadingPlan(targetPlan)
    try {
      const origin = window.location.origin
      const res = await apiFetch('/api/v1/billing/checkout', {
        method: 'POST',
        body: JSON.stringify({
          plan: targetPlan,
          interval: 'monthly',
          success_url: `${origin}/dashboard/billing?success=1`,
          cancel_url: `${origin}/dashboard/billing`,
        }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        setError((body as { message?: string }).message ?? 'Failed to start checkout.')
        return
      }
      const data = await res.json() as { url: string }
      if (!isSafeRedirectUrl(data.url)) {
        setError('Received invalid redirect URL.')
        return
      }
      window.location.href = data.url
    } catch {
      setError('Something went wrong. Please try again.')
    } finally {
      setLoadingPlan(null)
    }
  }

  async function handleManageSubscription() {
    setError(null)
    setPortalLoading(true)
    try {
      const origin = window.location.origin
      const res = await apiFetch('/api/v1/billing/portal', {
        method: 'POST',
        body: JSON.stringify({ return_url: `${origin}/dashboard/billing` }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        setError((body as { message?: string }).message ?? 'Failed to open billing portal.')
        return
      }
      const data = await res.json() as { url: string }
      if (!isSafeRedirectUrl(data.url)) {
        setError('Received invalid redirect URL.')
        return
      }
      window.location.href = data.url
    } catch {
      setError('Something went wrong. Please try again.')
    } finally {
      setPortalLoading(false)
    }
  }

  const usagePct = projectLimit != null && projectLimit > 0
    ? Math.min((projectCount / projectLimit) * 100, 100)
    : 0

  return (
    <div className="max-w-2xl mx-auto px-6 py-10 space-y-6">
      <h1 className="text-2xl font-bold text-gray-900">Billing</h1>

      {showSuccess && (
        <div className="rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">
          Subscription activated! Your plan has been updated.
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* Current Plan */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
        <h2 className="text-sm font-medium text-gray-500 uppercase tracking-wide mb-4">Current Plan</h2>
        <div className="flex items-center justify-between">
          <span className={`inline-flex items-center px-3 py-1 rounded-full text-sm font-semibold ${PLAN_BADGE_COLORS[plan] ?? 'bg-gray-100 text-gray-700'}`}>
            {PLAN_LABELS[plan] ?? plan}
          </span>
          {nextBillingDate && (
            <span className="text-sm text-gray-500">
              Next billing: <span className="text-gray-700 font-medium">{formatDate(nextBillingDate)}</span>
            </span>
          )}
          {!nextBillingDate && plan === 'free' && (
            <span className="text-sm text-gray-400">No active subscription</span>
          )}
        </div>
      </div>

      {/* Usage */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
        <h2 className="text-sm font-medium text-gray-500 uppercase tracking-wide mb-4">Usage</h2>
        <div className="space-y-3">
          <div className="flex items-center justify-between text-sm">
            <span className="text-gray-700 font-medium">Projects</span>
            <span className="text-gray-500">
              {projectCount} / {projectLimit != null ? projectLimit : '∞'}
            </span>
          </div>
          {projectLimit != null && (
            <div className="w-full bg-gray-100 rounded-full h-2">
              <div
                className="bg-indigo-600 h-2 rounded-full transition-all"
                style={{ width: `${usagePct}%` }}
              />
            </div>
          )}
        </div>
      </div>

      {/* Actions */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
        <h2 className="text-sm font-medium text-gray-500 uppercase tracking-wide mb-4">Actions</h2>
        <div className="flex flex-wrap gap-3">
          {plan === 'free' && (
            <>
              <button
                onClick={() => handleUpgrade('starter')}
                disabled={anyLoading}
                className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-60 text-white text-sm font-medium rounded-lg transition-colors"
              >
                {loadingPlan === 'starter' ? 'Redirecting…' : 'Upgrade to Starter — $9/mo'}
              </button>
              <button
                onClick={() => handleUpgrade('pro')}
                disabled={anyLoading}
                className="px-4 py-2 bg-violet-600 hover:bg-violet-700 disabled:opacity-60 text-white text-sm font-medium rounded-lg transition-colors"
              >
                {loadingPlan === 'pro' ? 'Redirecting…' : 'Upgrade to Pro — $19/mo'}
              </button>
            </>
          )}
          {/* Starter/Pro plan changes go through the Stripe portal — /checkout rejects non-free orgs. */}
          {(plan === 'starter' || plan === 'pro') && (
            <button
              onClick={handleManageSubscription}
              disabled={anyLoading}
              className="px-4 py-2 bg-white hover:bg-gray-50 disabled:opacity-60 text-gray-700 text-sm font-medium rounded-lg border border-gray-300 transition-colors"
            >
              {portalLoading ? 'Redirecting…' : 'Manage Subscription'}
            </button>
          )}
        </div>
        {plan === 'starter' && (
          <p className="mt-3 text-xs text-gray-400">To upgrade to Pro, use Manage Subscription above.</p>
        )}
      </div>
    </div>
  )
}
