import axios from 'axios';
import FormData from 'form-data';
import fs from 'node:fs';

export class TriviService {
  constructor(config, auth) {
    this.baseUrl = config.baseUrl;
	  this.uploadsPath = config.uploadsPath || '/uploads';
	  this.scansPath = config.scansPath || '/accountingdocuments/scans';
	  this.uploadFieldName = config.uploadFieldName || 'file';
    this.auth = auth;
  }

	async #authHeaders() {
		const token = await this.auth.getToken();
		return { Authorization: `Bearer ${token}` };
	}

	async uploadDocumentAttachment(attachment, metadata = {}) {
		const authHeaders = await this.#authHeaders();
		const normalize = (p) => (p.startsWith('/') ? p : `/${p}`);

		const form = new FormData();
		form.append(this.uploadFieldName, fs.createReadStream(attachment.path), {
			filename: attachment.filename,
			contentType: attachment.mimeType,
			knownLength: attachment.sizeBytes,
		});

		const uploadsUrl = `${this.baseUrl}${normalize(this.uploadsPath)}`;
		console.log(`[trivi] Uploading file: ${attachment.filename} → POST ${uploadsUrl}`);

		const { data: uploadData } = await axios.post(uploadsUrl, form, {
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

		const fileId = uploadData?.id;
		if (!fileId) {
			throw new Error(`TRIVI /uploads did not return a file id: ${JSON.stringify(uploadData)}`);
		}
		console.log(`[trivi] File uploaded: id=${fileId}`);

		const scansUrl = `${this.baseUrl}${normalize(this.scansPath)}`;
		const note = `${metadata.subject || ''}`.trim();
		const PAYMENT_TYPE_CODES = { bank_transfer: 1, cash: 2, cod: 3, card: 4 };
		const paymentType = PAYMENT_TYPE_CODES[metadata.classification?.paymentMethod];
		const item = { files: [String(fileId)], customerInstructions: note };
		if (paymentType) item.paymentType = paymentType;
		const body = [item];
		console.log(`[trivi] Creating accounting document from scan → POST ${scansUrl}`);

		const { status, data } = await axios.post(scansUrl, body, {
			headers: { ...authHeaders, 'Content-Type': 'application/json' },
		});

		if (typeof data === 'string' && data.trimStart().startsWith('<!doctype')) {
			throw new Error(
				`TRIVI /accountingdocuments/scans returned HTML instead of JSON. ` +
				`The endpoint "${scansUrl}" is likely wrong — check TRIVI API docs.`
			);
		}

		console.log(`[trivi] Scan document created HTTP ${status}: ${JSON.stringify(data)}`);
		return { fileId, scan: data };
	}
}
