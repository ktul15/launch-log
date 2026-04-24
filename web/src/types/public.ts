export interface PublicProject {
  name: string
  slug: string
  description: string | null
  widgetKey: string
  orgName: string
}

export interface PublicChangelogEntry {
  id: string
  title: string
  version: string | null
  status: string
  publishedAt: string | null
  categoryId: string | null
}

export interface PublicRoadmapItem {
  id: string
  title: string
  description: string | null
  status: 'planned' | 'in_progress' | 'shipped'
  displayOrder: number
}

export interface PublicFeature {
  id: string
  projectId: string
  title: string
  description: string | null
  status: string
  voteCount: number
  createdAt: string
  updatedAt: string
}
