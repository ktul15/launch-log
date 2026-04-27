import { cookies } from 'next/headers'
import { redirect, notFound } from 'next/navigation'
import ChangelogEntryForm from '../../ChangelogEntryForm'
import type { ChangelogEntry } from '@/types/changelog'

const BACKEND = process.env.BACKEND_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001'
const jwtShape = /^[\w-]+\.[\w-]+\.[\w-]+$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function sanitizeToken(token: string): string {
  return token.replace(/[\r\n]/g, '')
}

interface Props {
  params: { projectId: string; entryId: string }
}

export default async function EditChangelogEntryPage({ params }: Props) {
  const { projectId, entryId } = params

  if (!UUID_RE.test(projectId) || !UUID_RE.test(entryId)) notFound()

  const cookieStore = cookies()
  const accessToken = cookieStore.get('access_token')?.value
  if (!accessToken || !jwtShape.test(accessToken)) redirect('/login')

  const refreshToken = cookieStore.get('refresh_token')?.value
  const validRefreshToken = refreshToken && jwtShape.test(refreshToken) ? refreshToken : null
  const safeAccess = sanitizeToken(accessToken)
  const cookieHeader = validRefreshToken
    ? `access_token=${safeAccess}; refresh_token=${sanitizeToken(validRefreshToken)}`
    : `access_token=${safeAccess}`

  const res = await fetch(`${BACKEND}/api/v1/projects/${projectId}/changelog/${entryId}`, {
    headers: { Cookie: cookieHeader },
    cache: 'no-store',
    signal: AbortSignal.timeout(5_000),
  })

  if (res.status === 401) redirect('/login')
  if (res.status === 404) notFound()
  if (!res.ok) throw new Error(`Backend error: ${res.status}`)

  const raw = (await res.json()) as Partial<ChangelogEntry>
  if (!raw.id || !raw.title || !raw.content) throw new Error('Unexpected entry response shape')
  const entry = raw as ChangelogEntry

  return <ChangelogEntryForm mode="edit" projectId={projectId} entry={entry} />
}
