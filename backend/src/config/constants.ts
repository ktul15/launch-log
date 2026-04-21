export const ALLOWED_ROLES = ['owner', 'editor'] as const
export type Role = (typeof ALLOWED_ROLES)[number]
