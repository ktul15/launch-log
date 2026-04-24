export type FeatureStatus = 'open' | 'planned' | 'in_progress' | 'shipped' | 'closed'

const FEATURE_STATUS_VALUES: readonly string[] = ['open', 'planned', 'in_progress', 'shipped', 'closed']

export function isFeatureStatus(value: unknown): value is FeatureStatus {
  return typeof value === 'string' && FEATURE_STATUS_VALUES.includes(value)
}

export interface FeatureRequest {
  id: string
  projectId: string
  title: string
  description: string | null
  status: FeatureStatus
  voteCount: number
  submitterEmail: string | null
  createdAt: string
  updatedAt: string
}
