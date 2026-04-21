import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Dashboard — LaunchLog',
}

export default function DashboardPage() {
  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center">
      <div className="text-center">
        <h1 className="text-3xl font-bold text-gray-900">Welcome to LaunchLog</h1>
        <p className="mt-2 text-gray-500">Your dashboard is coming soon.</p>
      </div>
    </div>
  )
}
