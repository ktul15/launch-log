'use client'

import { useState, FormEvent } from 'react'
import { apiFetch } from '@/lib/api'

type SubscribeState = 'idle' | 'loading' | 'success' | 'already_subscribed' | 'error'

export default function SubscribeForm({ projectKey }: { projectKey: string }) {
  const [email, setEmail] = useState('')
  const [state, setState] = useState<SubscribeState>('idle')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setState('loading')
    setErrorMessage(null)

    try {
      const res = await apiFetch(`/api/v1/public/${projectKey}/subscribe`, {
        method: 'POST',
        body: JSON.stringify({ email }),
      })

      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { message?: string }
        setErrorMessage(body.message ?? 'Something went wrong. Please try again.')
        setState('error')
        return
      }

      const data = (await res.json()) as { status: string }
      if (data.status === 'already_subscribed') {
        setState('already_subscribed')
      } else {
        setState('success')
      }
    } catch {
      setErrorMessage('Something went wrong. Please try again.')
      setState('error')
    }
  }

  function reset() {
    setState('idle')
    setEmail('')
    setErrorMessage(null)
  }

  if (state === 'success') {
    return (
      <div className="rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">
        Check your inbox — we sent you a verification link.
      </div>
    )
  }

  if (state === 'already_subscribed') {
    return (
      <div className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-800">
        You&apos;re already subscribed.
      </div>
    )
  }

  return (
    <div>
      <p className="mb-2 text-sm font-medium text-gray-700">Get notified about updates</p>
      <form onSubmit={handleSubmit} className="flex gap-2">
        <input
          type="email"
          required
          placeholder="you@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={state === 'loading'}
          className="min-w-0 flex-1 rounded-md border border-gray-300 px-3 py-2 text-sm placeholder-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={state === 'loading'}
          className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {state === 'loading' ? 'Subscribing…' : 'Subscribe'}
        </button>
      </form>
      {state === 'error' && (
        <p className="mt-2 text-sm text-red-600">
          {errorMessage}{' '}
          <button onClick={reset} className="underline hover:no-underline">
            Try again
          </button>
        </p>
      )}
    </div>
  )
}
