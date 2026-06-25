// src/storage-service.js — S3 audit trail archive
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

export class StorageService {
  /**
   * @param {{ bucketName: string }} config
   */
  constructor(config) {
    this.bucket = config.bucketName;
    this.s3 = this.bucket ? new S3Client({}) : null;
  }

  async archiveEmail(emailId, content) {
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
