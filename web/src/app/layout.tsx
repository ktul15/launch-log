import type { Metadata } from 'next'

export const metadata: Metadata = {
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
