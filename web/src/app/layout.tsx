import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  metadataBase: (() => {
    try {
      return new URL(process.env.APP_URL ?? 'http://localhost:3000')
    } catch {
      return new URL('http://localhost:3000')
    }
  })(),
  title: 'LaunchLog',
  description: 'Public changelog, roadmap, and feedback hub for startups',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
