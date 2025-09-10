// lib/s3.ts
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export const S3_BUCKET = process.env.S3_BUCKET!;
if (!S3_BUCKET) throw new Error("S3_BUCKET missing");

export const s3 = new S3Client({
  region: process.env.S3_REGION ?? "eu-central",   // Hetzner'de bu değer problemsiz
  endpoint: process.env.S3_ENDPOINT!,              // https://nbg1.your-objectstorage.com
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY!,       // Hetzner key
    secretAccessKey: process.env.S3_SECRET_KEY!,
  },
  forcePathStyle: true,                            // Hetzner/R2 için güvenli
});

// Presigned PUT (tarayıcıdan direkt yükleme)
export async function presignPutUrl(opts: {
  key: string;
  contentType?: string;
  expiresIn?: number; // seconds
}) {
  const { key, contentType, expiresIn = 300 } = opts;
  const cmd = new PutObjectCommand({
    Bucket: S3_BUCKET,
    Key: key,
    ContentType: contentType,
    // ACL: "private", // Bucket'ta Object Ownership/ACL disabled ise bunu EKLEME.
  });
  const uploadUrl = await getSignedUrl(s3, cmd, { expiresIn });
  return { uploadUrl, key };
}

// Presigned GET (kısa süreli erişim için)
export async function presignGetUrl(opts: { key: string; expiresIn?: number }) {
  const { key, expiresIn = 600 } = opts;
  const cmd = new GetObjectCommand({ Bucket: S3_BUCKET, Key: key });
  return getSignedUrl(s3, cmd, { expiresIn });
}

// Results anahtarı üretimi
export function s3KeyResult(userId: string, jobId: string, idx: number, ext = "jpg") {
  const env = process.env.NODE_ENV === "production" ? "prod" : "dev";
  return `${env}/users/${userId}/results/${jobId}/${idx}.${ext}`;
}

// Buffer'ı S3'e yaz
export async function putBuffer(key: string, body: Buffer, contentType?: string) {
  await s3.send(
    new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType,
    })
  );
}