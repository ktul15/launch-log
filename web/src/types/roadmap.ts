export type RoadmapStatus = 'planned' | 'in_progress' | 'shipped'

export interface RoadmapItem {
  id: string
  projectId: string
  title: string
  description: string | null
  status: RoadmapStatus
  displayOrder: number
  createdAt: string
}
