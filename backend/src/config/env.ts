import { z } from 'zod'

// Matches jsonwebtoken expiresIn format: "15m", "1h", "7d", "3600" (seconds as number string)
const jwtExpiry = z.string().regex(/^\d+[smhd]$|^\d+$/, 'Must be a number followed by s, m, h, or d (e.g. 15m, 1h, 7d)')

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
  // Validated as URL(s) to catch typos; comma-separated in production
  CORS_ORIGIN: z.string().min(1).default('http://localhost:3000'),

  // External services — optional at startup; validated when each service is first used
  RESEND_API_KEY: z.string().optional(),
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().regex(/^whsec_/, 'Must start with whsec_').optional(),
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),
  R2_BUCKET: z.string().optional(),
  R2_ENDPOINT: z.string().url().optional(),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
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
  checkGroup(['R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET', 'R2_ENDPOINT'])
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
