import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Unsubscribe — LaunchLog',
}

type Props = {
  searchParams: Promise<{ token?: string }>
}

export default async function UnsubscribePage({ searchParams }: Props) {
  const { token } = await searchParams

  if (!token) {
    return (
      <StatusCard
        title="Invalid link"
        message="This unsubscribe link is not valid."
        success={false}
      />
    )
  }

  const apiBase = process.env.API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001'
  const url = `${apiBase}/api/v1/public/unsubscribe?token=${encodeURIComponent(token)}`

  let success = false
  let message = 'Something went wrong. Please try again.'

  try {
    const res = await fetch(url, { cache: 'no-store' })
    if (res.ok) {
      success = true
      message = 'You have been unsubscribed and will no longer receive updates.'
    } else {
      const body = await res.json().catch(() => ({})) as { message?: unknown }
      message = typeof body.message === 'string' ? body.message : 'Invalid link.'
    }
  } catch {
    message = 'Unable to connect. Please try again.'
  }

  return (
    <StatusCard
      title={success ? 'Unsubscribed' : 'Unsubscribe Failed'}
      message={message}
      success={success}
    />
  )
}

function StatusCard({
  title,
  message,
  success,
}: {
  title: string
  message: string
  success: boolean
}) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="w-full max-w-md bg-white rounded-xl shadow-md p-8 text-center">
        <h1 className={`text-2xl font-bold mb-2 ${success ? 'text-gray-900' : 'text-red-700'}`}>
          {title}
        </h1>
        <p className="text-sm text-gray-500">{message}</p>
      </div>
    </div>
  )
}
