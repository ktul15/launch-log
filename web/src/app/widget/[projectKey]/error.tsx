'use client'

import { useEffect } from 'react'

interface Props {
  error: Error & { digest?: string }
  reset: () => void
}

export default function WidgetError({ error, reset }: Props) {
  useEffect(() => {
    console.error('[widget page] render error:', error)
  }, [error])

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-3 px-4 text-center">
      <h2 className="text-sm font-semibold text-gray-900">Something went wrong</h2>
      <p className="text-xs text-gray-500">This widget failed to load. Please try again.</p>
      <button
        onClick={reset}
        className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700"
      >
        Try again
      </button>
    </div>
  )
}
