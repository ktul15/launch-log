import { notFound } from 'next/navigation'
import ChangelogEntryForm from '../ChangelogEntryForm'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

interface Props {
  params: { projectId: string }
}

export default async function NewChangelogEntryPage({ params }: Props) {
  const { projectId } = params
  if (!UUID_RE.test(projectId)) notFound()
  return <ChangelogEntryForm mode="new" projectId={projectId} />
}
