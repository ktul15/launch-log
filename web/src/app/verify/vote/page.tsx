import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Verify Vote — LaunchLog',
}

type Props = {
  searchParams: Promise<{ token?: string }>
}

export default async function VerifyVotePage({ searchParams }: Props) {
  const { token } = await searchParams

  if (!token) {
    return (
      <StatusCard
        title="Invalid link"
        message="This verification link is not valid."
        success={false}
      />
    )
  }

  // API_URL is a server-only env var for internal network routing.
  // Falls back to NEXT_PUBLIC_API_URL so no extra config is needed in dev.
  const apiBase = process.env.API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001'
  const url = `${apiBase}/api/v1/public/verify-vote?token=${encodeURIComponent(token)}`

  let success = false
  let message = 'Something went wrong. Please try again.'

  try {
    const res = await fetch(url, { cache: 'no-store' })
    const body = await res.json().catch(() => ({})) as { message?: unknown }
    if (res.ok) {
      success = true
      message =
        body.message === 'Already verified'
          ? 'Your vote was already verified.'
          : 'Your vote has been verified. Thank you!'
    } else {
      message = typeof body.message === 'string' ? body.message : 'Invalid or expired link.'
    }
  } catch {
    message = 'Unable to connect. Please try again.'
  }

  return (
    <StatusCard
      title={success ? 'Vote Verified' : 'Verification Failed'}
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
