import crypto from 'crypto'

// Accepts an optional structured logger so callers can pass fastify.log (pino) in production
// rather than falling back to console.warn, which bypasses the JSON log format.
type Logger = { warn: (msg: string) => void }

export function toSlug(name: string, log?: Logger): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
  if (slug.length >= 2) return slug
  // Non-ASCII names (Cyrillic, CJK, Arabic, etc.) produce an empty slug after stripping.
  // Log so this is visible in server logs — otherwise operators won't know why org URLs
  // look like random hex and users can't guess their own workspace address.
  ;(log ?? console).warn(`[toSlug] Name normalised to fewer than 2 characters — using random hex ID (original: "${name}")`)
  return crypto.randomBytes(4).toString('hex')
}
