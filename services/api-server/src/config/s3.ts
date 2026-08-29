import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

const isProduction = process.env['NODE_ENV'] === 'production'

export const S3_BUCKET = process.env['AWS_S3_BUCKET'] ?? ''
export const S3_REGION = process.env['AWS_REGION'] ?? 'ap-southeast-1'

if (isProduction && !process.env['AWS_S3_BUCKET']) {
  throw new Error('AWS_S3_BUCKET environment variable is required in production')
}

export const ALLOWED_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
] as const

export type AllowedMimeType = (typeof ALLOWED_MIME_TYPES)[number]

const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024 // 10MB

export const s3Client = new S3Client({
  region: S3_REGION,
  credentials:
    process.env['AWS_ACCESS_KEY_ID'] && process.env['AWS_SECRET_ACCESS_KEY']
      ? {
          accessKeyId: process.env['AWS_ACCESS_KEY_ID'],
          secretAccessKey: process.env['AWS_SECRET_ACCESS_KEY'],
        }
      : undefined,
})

interface UploadUrlOptions {
  key: string
  contentType: AllowedMimeType
  expiresIn?: number // seconds, default 900 (15 min)
}

/** Generate a pre-signed PUT URL for client-side uploads */
export async function generateUploadUrl(options: UploadUrlOptions): Promise<string> {
  const { key, contentType, expiresIn = 900 } = options

  const command = new PutObjectCommand({
    Bucket: S3_BUCKET,
    Key: key,
    ContentType: contentType,
    ContentLength: MAX_FILE_SIZE_BYTES,
  })

  return getSignedUrl(s3Client, command, { expiresIn })
}

interface UploadObjectOptions {
  key: string
  body: Uint8Array
  contentType: AllowedMimeType
}

/**
 * Uploads a server-generated object (e.g., a rendered PDF quotation) directly to
 * S3 via PutObject. Used for artifacts the API server produces itself — never for
 * client uploads, which must go through pre-signed URLs. The S3 key is not exposed
 * to clients; callers persist it and hand out pre-signed GET URLs via
 * generateDownloadUrl.
 */
export async function uploadObject(options: UploadObjectOptions): Promise<void> {
  const { key, body, contentType } = options

  const command = new PutObjectCommand({
    Bucket: S3_BUCKET,
    Key: key,
    Body: body,
    ContentType: contentType,
  })

  await s3Client.send(command)
}

interface DownloadUrlOptions {
  key: string
  expiresIn?: number // seconds, default 3600 (1 hour)
}

/** Generate a pre-signed GET URL for retrieving uploaded files */
export async function generateDownloadUrl(options: DownloadUrlOptions): Promise<string> {
  const { key, expiresIn = 3600 } = options

  const command = new GetObjectCommand({
    Bucket: S3_BUCKET,
    Key: key,
  })

  return getSignedUrl(s3Client, command, { expiresIn })
}

type S3Category = 'attendance' | 'visits/photos' | 'visits/signatures' | 'orders/quotations' | 'customers/bulk-imports'

interface S3KeyOptions {
  companyId: string
  category: S3Category
  fileId: string
  extension: string
}

/** Generate an S3 key following the pattern: {company_id}/{category}/{year}/{uuid}.{ext} */
export function buildS3Key(options: S3KeyOptions): string {
  const { companyId, category, fileId, extension } = options
  const year = new Date().getFullYear()
  const ext = extension.startsWith('.') ? extension.slice(1) : extension
  return `${companyId}/${category}/${year}/${fileId}.${ext}`
}
