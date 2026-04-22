import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { env } from '../config/env'

// Cached once — S3Client maintains an internal connection pool that should be reused.
let cachedClient: S3Client | null | undefined

export function getR2Client(): S3Client | null {
  if (cachedClient !== undefined) return cachedClient
  if (!env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY || !env.R2_BUCKET || !env.R2_ENDPOINT || !env.R2_PUBLIC_URL) {
    cachedClient = null
    return null
  }
  cachedClient = new S3Client({
    region: 'auto',
    endpoint: env.R2_ENDPOINT,
    credentials: {
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    },
  })
  return cachedClient
}

export async function createLogoPresignedUrl(
  orgId: string,
): Promise<{ uploadUrl: string; publicUrl: string; key: string }> {
  const client = getR2Client()
  if (!client) {
    throw new Error('R2 not configured')
  }

  const key = `logos/${orgId}/${Date.now()}.jpg`
  // ContentType is intentionally omitted — including a wildcard like 'image/*' causes
  // R2 to reject uploads where the client sends a concrete type (e.g. 'image/png'),
  // since the presigned signature would not match. The client must set its own Content-Type.
  const command = new PutObjectCommand({
    Bucket: env.R2_BUCKET!,
    Key: key,
  })

  const uploadUrl = await getSignedUrl(client, command, { expiresIn: 300 })
  // R2_PUBLIC_URL is the public-facing base URL (custom domain or pub-*.r2.dev),
  // not the S3 API endpoint — these are different addresses.
  const publicUrl = `${env.R2_PUBLIC_URL!.replace(/\/$/, '')}/${key}`

  return { uploadUrl, publicUrl, key }
}
