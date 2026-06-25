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
	  this.uploadedDocumentsPath = config.uploadedDocumentsPath || '/accountingdocuments/uploaded';
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

	async uploadDocumentAttachment(attachment, metadata = {}) {
		const headers = await this.#authHeaders();
		const form = new FormData();
		const path = this.uploadedDocumentsPath.startsWith('/')
			? this.uploadedDocumentsPath
			: `/${this.uploadedDocumentsPath}`;

		// TRIVI Files API only accepts the file field
		form.append(this.uploadFieldName, fs.createReadStream(attachment.path), {
			filename: attachment.filename,
			contentType: attachment.mimeType,
			knownLength: attachment.sizeBytes,
		});

		const fullUrl = `${this.baseUrl}${path}`;
		console.log(`[trivi] Uploading attachment to uploaded documents: ${attachment.filename}`);
		console.log(`[trivi] POST ${fullUrl}`);

		const { status, data } = await axios.post(fullUrl, form, {
			headers: {
				...headers,
				...form.getHeaders(),
			},
			maxBodyLength: Infinity,
			maxContentLength: Infinity,
		});

		// TRIVI returns the web app HTML when the endpoint does not exist — treat as error
		if (typeof data === 'string' && data.trimStart().startsWith('<!doctype')) {
			throw new Error(
				`TRIVI upload endpoint returned HTML instead of JSON. ` +
				`The endpoint "${fullUrl}" is likely wrong — check TRIVI API docs for the correct upload path.`
			);
		}

		console.log(`[trivi] Upload response HTTP ${status}: ${JSON.stringify(data)}`);

		return data;
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
