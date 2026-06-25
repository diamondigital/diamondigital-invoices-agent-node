// src/trivi-service.js — TRIVI REST API v2 client
import axios from 'axios';
import FormData from 'form-data';
import fs from 'node:fs';

export class TriviService {
  /**
   * @param {import('./config.js').AppConfig['trivi']} config
   * @param {import('./trivi-auth.js').TriviAuth} auth
   */
  constructor(config, auth) {
    this.baseUrl = config.baseUrl;
    this.bankAccountId = config.bankAccountId;
	  this.uploadsPath = config.uploadsPath || '/uploads';
	  this.scansPath = config.scansPath || '/accountingdocuments/scans';
	  this.uploadFieldName = config.uploadFieldName || 'file';
    this.auth = auth;
  }

  async #headers() {
    const token = await this.auth.getToken();
    return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  }

	async #authHeaders() {
		const token = await this.auth.getToken();
		return { Authorization: `Bearer ${token}` };
	}

  // ─── Accounting Documents ────────────────────────────────

  async createInvoice(invoice) {
    const headers = await this.#headers();
    const label = invoice.orderNo || invoice.explicitNo || 'new';
    console.log(`[trivi] Creating issued invoice: ${label}`);

    const { data } = await axios.post(
      `${this.baseUrl}/accountingdocuments`,
      invoice,
      { headers }
    );

    console.log(`[trivi] Invoice created: ID=${data.id}, No=${data.accountingDocumentNo}, state=${data.processingState}`);
    return data;
  }

  async getDocument(id) {
    const headers = await this.#headers();
    const { data } = await axios.get(
      `${this.baseUrl}/accountingdocuments/${id}`,
      { headers }
    );
    return data;
  }

  async getDocumentIssues(id) {
    const headers = await this.#headers();
    const { data } = await axios.get(
      `${this.baseUrl}/accountingdocuments/${id}/issues`,
      { headers }
    );
    return (data || []).map(i => i.message || JSON.stringify(i));
  }

	/**
	 * Upload an email attachment to TRIVI as a scanned accounting document.
	 * Two-step flow per TRIVI Public API v2:
	 *   1. POST {uploadsPath} (multipart/form-data) → returns { id }
	 *   2. POST {scansPath} (JSON [{ files: [id] }]) → creates the document
	 * @returns {Promise<{ fileId: number|string, scan: any }>}
	 */
	async uploadDocumentAttachment(attachment, metadata = {}) {
		const authHeaders = await this.#authHeaders();
		const normalize = (p) => (p.startsWith('/') ? p : `/${p}`);

		// ── Step 1: upload the raw file → returns a numeric file id ──
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

		// TRIVI returns the web app HTML when the endpoint does not exist — treat as error
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

		// ── Step 2: create an accounting document from the uploaded scan ──
		// Field mapping verified against the API: scans `customerInstructions`
		// surfaces as the document's POZNÁMKA, and `paymentType` (singular) sets
		// the payment method. (`note` lands in `description`, not shown as note.)
		const scansUrl = `${this.baseUrl}${normalize(this.scansPath)}`;
		const note = `[Vytěženo AI] ${metadata.subject || ''}`.trim();
		// TRIVI PaymentType enum: 1=BankTransfer, 2=Cash, 3=COD, 4=Card.
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

  // ─── Contacts ────────────────────────────────────────────

  async findContactByExternalId(externalId) {
    const headers = await this.#headers();
    try {
      const { data } = await axios.get(`${this.baseUrl}/contacts`, {
        headers,
        params: { externalId },
      });
      return data.length > 0 ? data[0] : null;
    } catch (error) {
      if (error.response?.status === 404) return null;
      throw error;
    }
  }

  async findContactByEmail(email) {
    const headers = await this.#headers();
    try {
      const { data } = await axios.get(`${this.baseUrl}/contacts`, {
        headers,
        params: { email },
      });
      return data.length > 0 ? data[0] : null;
    } catch (error) {
      if (error.response?.status === 404) return null;
      throw error;
    }
  }

  async createContact(contact) {
    const headers = await this.#headers();
    console.log(`[trivi] Creating contact: ${contact.email || contact.companyName}`);
    const { data } = await axios.post(
      `${this.baseUrl}/contacts`,
      contact,
      { headers }
    );
    console.log(`[trivi] Contact created: ID=${data.id}`);
    return data;
  }

  /**
   * Get existing contact or create new one.
   * Priority: contactId > externalId > email > create new.
   * @returns {Promise<number>} contact ID
   */
  async getOrCreateContact(contact) {
    // If contactId already known, return it
    if (contact.contactId) return contact.contactId;

    // Try externalId first (CRITICAL for repeat customers)
    if (contact.externalId) {
      const existing = await this.findContactByExternalId(contact.externalId);
      if (existing) {
        console.log(`[trivi] Found contact by externalId: ${existing.id}`);
        return existing.id;
      }
    }

    // Try email
    if (contact.email) {
      const existing = await this.findContactByEmail(contact.email);
      if (existing) {
        console.log(`[trivi] Found contact by email: ${existing.id}`);
        return existing.id;
      }
    }

    // Create new
    const created = await this.createContact(contact);
    return created.id;
  }

  // ─── Lookups ─────────────────────────────────────────────

  async getSequences() {
    const headers = await this.#headers();
    const { data } = await axios.get(`${this.baseUrl}/sequences`, {
      headers,
      params: { type: 'noncashregister' },
    });
    return data;
  }

  async getVatRates() {
    const headers = await this.#headers();
    const { data } = await axios.get(`${this.baseUrl}/vatrates`, { headers });
    return data;
  }

  async getBankAccounts() {
    const headers = await this.#headers();
    const { data } = await axios.get(`${this.baseUrl}/bankaccounts`, { headers });
    return data;
  }
}
