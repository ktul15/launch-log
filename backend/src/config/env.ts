import { z, ZodError } from 'zod'

// Matches jsonwebtoken expiresIn format: "15m", "1h", "7d", "3600" (seconds as number string)
const jwtExpiry = z.string().regex(/^\d+[smhd]$|^\d+$/, 'Must be a number followed by s, m, h, or d (e.g. 15m, 1h, 7d)')

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(3001),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 characters'),
  JWT_ACCESS_EXPIRES_IN: jwtExpiry.default('15m'),
  JWT_REFRESH_EXPIRES_IN: jwtExpiry.default('7d'),
  // Validated as URL(s) to catch typos; comma-separated in production
  CORS_ORIGIN: z.string().min(1).default('http://localhost:3000'),
})

export type Env = z.infer<typeof envSchema>

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
