import { NextRequest, NextResponse } from 'next/server'

// BACKEND_URL is a private server-side env var so the internal address is never
// embedded in the client bundle (NEXT_PUBLIC_ vars are inlined at build time).
const BACKEND =
  process.env.BACKEND_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001'

// JWT tokens are three dot-separated base64url segments. Validating this shape
// on both cookies before any further processing prevents CRLF injection and
// catches garbage values before they reach atob() or header interpolation.
const JWT_SHAPE = /^[\w-]+\.[\w-]+\.[\w-]+$/

// Absorbs clock skew and network round-trip time so a token expiring at the
// exact boundary is refreshed before the backend rejects it mid-request.
const CLOCK_SKEW_S = 10

// Decodes the JWT payload (no signature verification — the backend verifies on
// every API call). Returns false for expired, structurally invalid, or
// non-JWT strings so they fall through to the refresh flow.
function isTokenLive(token: string): boolean {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) return false
    const padded = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const payload = JSON.parse(atob(padded)) as Record<string, unknown>
    return typeof payload.exp === 'number' && payload.exp > Date.now() / 1000 + CLOCK_SKEW_S
  } catch {
    return false
  }
}

type CookieOpts = {
  httpOnly?: boolean
  secure?: boolean
  sameSite?: 'lax' | 'strict' | 'none'
  maxAge?: number
  path?: string
  domain?: string
}

const SAME_SITE_MAP: Record<string, CookieOpts['sameSite']> = {
  lax: 'lax',
  strict: 'strict',
  none: 'none',
}

// Parses and re-serializes each Set-Cookie header through the ResponseCookies
// API instead of forwarding raw strings, so a misconfigured or compromised
// backend cannot inject arbitrary content into the browser response.
function applySetCookie(next: NextResponse, header: string): void {
  const parts = header.split(';').map(p => p.trim())
  const firstEq = parts[0].indexOf('=')
  if (firstEq === -1) return
  const name = parts[0].slice(0, firstEq).trim()
  const value = parts[0].slice(firstEq + 1).trim()
  if (!name) return

  const opts: CookieOpts = {}
  for (const attr of parts.slice(1)) {
    const eqIdx = attr.indexOf('=')
    const key = (eqIdx === -1 ? attr : attr.slice(0, eqIdx)).trim().toLowerCase()
    const val = eqIdx === -1 ? '' : attr.slice(eqIdx + 1).trim()
    if (key === 'httponly') opts.httpOnly = true
    else if (key === 'secure') opts.secure = true
    else if (key === 'samesite') opts.sameSite = SAME_SITE_MAP[val.toLowerCase()]
    else if (key === 'max-age') { const n = Number(val); if (Number.isFinite(n)) opts.maxAge = n }
    else if (key === 'path') opts.path = val
    else if (key === 'domain') opts.domain = val
  }
  next.cookies.set(name, value, opts)
}

export async function middleware(req: NextRequest): Promise<NextResponse> {
  const accessToken = req.cookies.get('access_token')?.value

  if (accessToken && JWT_SHAPE.test(accessToken) && isTokenLive(accessToken)) {
    return NextResponse.next()
  }

  const refreshToken = req.cookies.get('refresh_token')

  if (!refreshToken || !JWT_SHAPE.test(refreshToken.value)) {
    return NextResponse.redirect(new URL('/login', req.url))
  }

  try {
    const res = await fetch(`${BACKEND}/api/v1/auth/refresh`, {
      method: 'POST',
      headers: { Cookie: `refresh_token=${refreshToken.value}` },
      cache: 'no-store',
      signal: AbortSignal.timeout(5_000),
    })

    if (!res.ok) {
      return NextResponse.redirect(new URL('/login', req.url))
    }

    const headers = res.headers as Headers & { getSetCookie?(): string[] }
    const setCookies =
      headers.getSetCookie?.() ??
      [res.headers.get('set-cookie')].filter((v): v is string => v !== null)

    // A 200 with no Set-Cookie means the backend contract changed or the token
    // was already consumed; redirect rather than silently passing through with
    // no new token (which would cause an infinite refresh loop on next request).
    if (setCookies.length === 0) {
      return NextResponse.redirect(new URL('/login', req.url))
    }

    const next = NextResponse.next()
    for (const cookie of setCookies) {
      applySetCookie(next, cookie)
    }
    return next
  } catch (err) {
    console.error('[middleware] token refresh failed:', err instanceof Error ? err.message : String(err))
    return NextResponse.redirect(new URL('/login', req.url))
  }
}

export const config = {
  // SECURITY: Allowlist of path prefixes that require JWT auth.
  // Every new admin section MUST be added here — unlisted paths are unprotected.
  // Current protected prefixes: dashboard, onboarding, billing, account, team.
  // Word-boundary: require / or end-of-string after the prefix to prevent
  // /dashboardx or /onboarding-marketing from accidentally matching.
  matcher: ['/(dashboard|onboarding|billing|account|team)(/.*)?$'],
}
