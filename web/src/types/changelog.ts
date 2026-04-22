export interface ChangelogEntry {
  id: string
  projectId: string
  title: string
  version: string | null
  status: 'draft' | 'published' | 'archived'
  publishedAt: string | null
  createdAt: string
}
