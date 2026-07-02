import axios from 'axios';
import FormData from 'form-data';
import fs from 'node:fs';
import { paymentTypeFromMethod } from '../../domain/payment.js';
import { withRetry, defaultShouldRetry } from '../../shared/retry.js';
import type { TriviPort } from '../../ports/trivi-port.js';
import type { Attachment, TriviConfig, UploadMetadata, UploadResult } from '../../domain/types.js';
import type { TriviAuth } from './auth.js';

const RETRY_OPTS = { maxAttempts: 3, baseDelayMs: 1000, shouldRetry: defaultShouldRetry };

interface UploadsResponse {
  id?: string | number;
}

interface ScanItem {
  files: string[];
  customerInstructions: string;
  paymentType?: number;
}

export class TriviUploadAdapter implements TriviPort {
  private baseUrl: string;
  private uploadsPath: string;
  private scansPath: string;
  private uploadFieldName: string;
  private auth: TriviAuth;

  constructor(config: TriviConfig, auth: TriviAuth) {
    this.baseUrl = config.baseUrl;
    this.uploadsPath = config.uploadsPath || '/uploads';
    this.scansPath = config.scansPath || '/accountingdocuments/scans';
    this.uploadFieldName = config.uploadFieldName || 'file';
    this.auth = auth;
  }

  async #authHeaders(): Promise<{ Authorization: string }> {
    const token = await this.auth.getToken();
    return { Authorization: `Bearer ${token}` };
  }

  async uploadDocumentAttachment(attachment: Attachment, metadata: UploadMetadata = {}): Promise<UploadResult> {
    const authHeaders = await this.#authHeaders();
    const normalize = (p: string): string => (p.startsWith('/') ? p : `/${p}`);

    const uploadsUrl = `${this.baseUrl}${normalize(this.uploadsPath)}`;
    const scansUrl = `${this.baseUrl}${normalize(this.scansPath)}`;

    const runUpload = withRetry(async (): Promise<string | number> => {
      const form = new FormData();
      form.append(this.uploadFieldName, fs.createReadStream(attachment.path), {
        filename: attachment.filename,
        contentType: attachment.mimeType,
        knownLength: attachment.sizeBytes,
      });

      console.log(`[trivi] Uploading file: ${attachment.filename} → POST ${uploadsUrl}`);

      const { data: uploadData } = await axios.post<UploadsResponse | string>(uploadsUrl, form, {
        headers: { ...authHeaders, ...form.getHeaders() },
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
      });

      if (typeof uploadData === 'string' && uploadData.trimStart().startsWith('<!doctype')) {
        throw new Error(
          `TRIVI /uploads returned HTML instead of JSON. ` +
          `The endpoint "${uploadsUrl}" is likely wrong — check TRIVI API docs.`
        );
      }

      const fileId = (uploadData as UploadsResponse)?.id;
      if (!fileId) {
        throw new Error(`TRIVI /uploads did not return a file id: ${JSON.stringify(uploadData)}`);
      }
      return fileId;
    }, RETRY_OPTS);

    const fileId = await runUpload();
    console.log(`[trivi] File uploaded: id=${fileId}`);

    const note = `${metadata.subject || ''}`.trim();
    const paymentType = paymentTypeFromMethod(metadata.classification?.paymentMethod);
    const item: ScanItem = { files: [String(fileId)], customerInstructions: note };
    if (paymentType) item.paymentType = paymentType;
    const body = [item];

    const runScan = withRetry(async (): Promise<{ status: number; data: unknown }> => {
      console.log(`[trivi] Creating accounting document from scan → POST ${scansUrl}`);

      const { status, data } = await axios.post<unknown>(scansUrl, body, {
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
      });

      if (typeof data === 'string' && data.trimStart().startsWith('<!doctype')) {
        throw new Error(
          `TRIVI /accountingdocuments/scans returned HTML instead of JSON. ` +
          `The endpoint "${scansUrl}" is likely wrong — check TRIVI API docs.`
        );
      }

      return { status, data };
    }, RETRY_OPTS);

    const { status, data } = await runScan();
    console.log(`[trivi] Scan document created HTTP ${status}: ${JSON.stringify(data)}`);
    return { fileId, scan: data };
  }
}
