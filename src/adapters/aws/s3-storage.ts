import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import type { StoragePort } from '../../ports/storage-port.js';
import type { S3Config } from '../../domain/types.js';

export class S3StorageAdapter implements StoragePort {
  private readonly bucket: string;
  private readonly s3: S3Client | null;

  constructor(config: S3Config) {
    this.bucket = config.bucketName;
    this.s3 = this.bucket ? new S3Client({}) : null;
  }

  async archiveEmail(emailId: string, content: string): Promise<void> {
    if (!this.s3 || !this.bucket) {
      console.log('[storage] S3 not configured, skipping archive');
      return;
    }

    const dateStr = new Date().toISOString().split('T')[0];
    const key = `emails/${dateStr}/${emailId}.json`;

    console.log(`[storage] Archiving to S3: ${key}`);
    await this.s3.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: content,
      ContentType: 'application/json',
    }));
  }
}
