import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';

export function createPhotoStorage(env = process.env) {
  const names = ['S3_ENDPOINT','S3_BUCKET','S3_ACCESS_KEY','S3_SECRET_KEY'];
  if (names.every(name => !env[name])) return null;
  if (names.some(name => !env[name])) throw new Error('Photo storage configuration is incomplete');
  const endpoint = new URL(env.S3_ENDPOINT);
  if (!['http:','https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.pathname !== '/') throw new Error('Invalid photo storage endpoint');
  const client = new S3Client({
    endpoint: endpoint.origin, region: env.S3_REGION || 'us-east-1', forcePathStyle: true,
    credentials: { accessKeyId: env.S3_ACCESS_KEY, secretAccessKey: env.S3_SECRET_KEY },
    maxAttempts: 2, requestHandler: { connectionTimeout: 3000, requestTimeout: 15000 },
  });
  const Bucket = env.S3_BUCKET;
  return {
    async put(key,bytes) { await client.send(new PutObjectCommand({ Bucket,Key: key,Body: bytes,ContentType: 'image/webp',CacheControl: 'public, max-age=31536000, immutable' })); },
    async get(key) { const result = await client.send(new GetObjectCommand({ Bucket,Key: key })); return result.Body; },
    async remove(key) { await client.send(new DeleteObjectCommand({ Bucket,Key: key })); },
    close() { client.destroy(); },
  };
}
