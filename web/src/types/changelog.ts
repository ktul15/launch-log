export interface TipTapDoc {
  type: 'doc'
  content: unknown[]
}

export interface ChangelogEntry {
  id: string
  projectId: string
  title: string
  content: TipTapDoc
  version: string | null
  categoryId: string | null
  status: 'draft' | 'published' | 'archived'
  publishedAt: string | null
  createdAt: string
}
