import { z } from 'zod'

// Matches jsonwebtoken expiresIn format: "15m", "1h", "7d", "3600" (seconds as number string).
// Also rejects zero values (e.g. "0m") which pass the regex but would crash at startup when
// expiryToSeconds throws — better to fail here with a clear message.
const jwtExpiry = z
  .string()
  .regex(/^\d+[smhd]$|^\d+$/, 'Must be a number followed by s, m, h, or d (e.g. 15m, 1h, 7d)')
  .refine(
    (v) => {
      const n = Number(v.replace(/[smhd]$/, ''))
      return n > 0
    },
    { message: 'JWT expiry value must be greater than zero' },
  )

const baseSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(3001),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 characters'),
  JWT_ACCESS_EXPIRES_IN: jwtExpiry.default('15m'),
  JWT_REFRESH_EXPIRES_IN: jwtExpiry.default('7d'),
  // Comma-separated list of allowed origins. Each entry is validated as a URL to catch typos
  // early — a bad value would otherwise produce a silent open-redirect in the OAuth callback.
  CORS_ORIGIN: z
    .string()
    .min(1)
    .default('http://localhost:3000')
    .refine(
      (v) =>
        v
          .split(',')
          .map((s) => s.trim())
          .every((origin) => {
            try {
              const parsed = new URL(origin)
              // Origins must be scheme://host[:port] only — browsers never send a path in the
              // Origin header, so a path in CORS_ORIGIN would cause all preflight checks to fail.
              return (parsed.pathname === '/' || parsed.pathname === '') && !parsed.search && !parsed.hash
            } catch {
              return false
            }
          }),
      { message: 'CORS_ORIGIN must be a comma-separated list of origins (scheme://host[:port] only, no path)' },
    ),
  // Public URL of this backend — used to build the Google OAuth callback URL.
  // Must be registered in Google Cloud Console as an authorised redirect URI.
  APP_URL: z.string().url().default('http://localhost:3001'),

  // External services — optional at startup; validated when each service is first used
  RESEND_API_KEY: z.string().optional(),
  FRONTEND_URL: z.string().url().default('http://localhost:3000'),
  RESEND_FROM_EMAIL: z.string().email().default('notifications@updates.launchlog.app'),
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().regex(/^whsec_/, 'Must start with whsec_').optional(),
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),
  R2_BUCKET: z.string().optional(),
  R2_ENDPOINT: z.string().url().optional(),
  // Public base URL for serving R2 objects — separate from the S3 API endpoint.
  // Set to your Cloudflare R2 custom domain or the pub-*.r2.dev subdomain.
  R2_PUBLIC_URL: z.string().url().optional(),
  GOOGLE_CLIENT_ID: z
    .string()
    .refine((v) => v.endsWith('.apps.googleusercontent.com'), {
      message: 'GOOGLE_CLIENT_ID must end with .apps.googleusercontent.com',
    })
    .optional(),
  GOOGLE_CLIENT_SECRET: z
    .string()
    .min(10, 'GOOGLE_CLIENT_SECRET appears too short')
    .optional(),
})

export type Env = z.infer<typeof baseSchema>

// Enforce that optional service vars are either all set or all absent per group.
// A partial config (e.g. R2_BUCKET without R2_ENDPOINT) passes field-level validation
// but would cause obscure runtime errors in the service layer.
const envSchema = baseSchema.superRefine((data, ctx) => {
  type EnvKey = keyof typeof data
  const checkGroup = (keys: EnvKey[]) => {
    const missing = keys.filter(k => data[k] === undefined)
    if (missing.length > 0 && missing.length < keys.length) {
      missing.forEach(k => ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [k],
        message: `Required when other ${String(k).split('_')[0]} variables are set`,
      }))
    }
  }
  checkGroup(['R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET', 'R2_ENDPOINT', 'R2_PUBLIC_URL'])
  checkGroup(['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'])
  checkGroup(['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'])
})

const result = envSchema.safeParse(process.env)

if (!result.success) {
  console.error('\n[config] Invalid or missing environment variables:\n')
  result.error.issues.forEach((issue) => {
    console.error(`  ${issue.path.join('.') || 'root'}: ${issue.message}`)
  })
  console.error('\nCopy .env.example to .env and fill in the required values.\n')
  process.exit(1)
}

export const env = result.data
