// src/invoice-extractor.js — Mistral LLM: classify emails + extract structured order data
import { Mistral } from '@mistralai/mistralai';

export class InvoiceExtractor {
  /**
   * @param {{ apiKey: string, model: string }} config
   */
  constructor(config) {
    this.mistral = new Mistral({ apiKey: config.apiKey });
    this.model = config.model;
  }

  /**
   * Classify whether an email contains order/invoice data.
   * @returns {Promise<{isOrder: boolean, confidence: number}>}
   */
  async classifyEmail(subject, bodyPreview) {
    const prompt = `Jsi klasifikátor e-mailů pro účetní systém. Urči, zda tento e-mail obsahuje objednávku nebo podklady pro vystavení faktury.

Předmět: ${subject}
Tělo (náhled): ${bodyPreview.substring(0, 2000)}

Odpověz POUZE JSON: {"isOrder": true/false, "confidence": 0.0-1.0}`;

    const response = await this.mistral.chat.complete({
      model: this.model,
      messages: [{ role: 'user', content: prompt }],
      responseFormat: { type: 'json_object' },
      temperature: 0,
    });

    const content = response.choices?.[0]?.message?.content;
    if (typeof content === 'string') {
      try { return JSON.parse(content); } catch { /* fall through */ }
    }
    return { isOrder: false, confidence: 0 };
  }

  /**
   * Extract structured order/invoice data from email body text.
   * @param {string} subject
   * @param {string} bodyText
   * @returns {Promise<Object>} extracted order data
   */
  async extractOrder(subject, bodyText) {
    console.log(`[extractor] Extracting order data from: ${subject}`);

    const prompt = `Extrahuj strukturovaná data objednávky/faktury z tohoto e-mailu. Vrať POUZE JSON (bez markdown, bez vysvětlení).

Předmět: ${subject}
Tělo e-mailu: ${bodyText.substring(0, 6000)}

Požadovaná JSON struktura:
{
  "isOrder": boolean,
  "confidence": number (0-1),
  "customer": {
    "firstName": string | null,
    "lastName": string | null,
    "companyName": string | null,
    "email": string | null,
    "phone": string | null,
    "street": string | null,
    "city": string | null,
    "zipCode": string | null,
    "country": "CZ" | "SK" | string | null,
    "externalId": string | null
  },
  "orderNumber": string | null,
  "orderDate": "YYYY-MM-DD",
  "dueDate": "YYYY-MM-DD" | null,
  "lineItems": [
    {
      "description": string,
      "quantity": number,
      "unitPrice": number (včetně DPH),
      "vatRate": number (21, 12, 0),
      "category": "product" | "service" | "goods" | "shipping" | "discount" | null
    }
  ],
  "totalAmount": number (včetně DPH),
  "currency": "CZK" | "EUR",
  "paymentType": "bank_transfer" | "cash" | "card" | "cod" | null,
  "variableSymbol": string | null,
  "paymentGatewayOperationId": string | null,
  "paid": boolean
}`;

    const response = await this.mistral.chat.complete({
      model: this.model,
      messages: [{ role: 'user', content: prompt }],
      responseFormat: { type: 'json_object' },
      temperature: 0,
    });

    const content = response.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
      throw new Error('Mistral returned empty response');
    }

    return JSON.parse(content);
  }
}
