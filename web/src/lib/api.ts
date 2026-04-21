const BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001'

export const API_BASE = BASE

export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    ...init,
    credentials: 'include',
    headers: {
      ...(init?.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  })
}
