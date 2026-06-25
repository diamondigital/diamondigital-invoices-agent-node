// src/document-classifier.js — Mistral: classify whether an attachment is an accounting document.
// Cost-optimised routing (verified by eval, see memory: document-classifier):
//   • images (png/jpg) → vision chat directly, NO OCR (~100× cheaper than OCR)
//   • PDFs/others      → OCR to text, then the same cheap model classifies the text
// One multimodal model handles both. ministral-8b is the cheapest model that
// scored 9/9 on PDFs (via OCR text) and 5/5 on logo/promo images (via vision).
import { Mistral } from '@mistralai/mistralai';
import convertHeic from 'heic-convert';
import fs from 'node:fs/promises';

export const DEFAULT_CLASSIFIER_MODEL = 'ministral-8b-latest';
export const OCR_MODEL = 'mistral-ocr-latest';

const VISION_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

function guessMimeType(filename, fallback) {
  const ext = filename.toLowerCase().slice(filename.lastIndexOf('.'));
  switch (ext) {
    case '.pdf': return 'application/pdf';
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.webp': return 'image/webp';
    case '.heic': return 'image/heic';
    case '.heif': return 'image/heif';
    case '.tif':
    case '.tiff': return 'image/tiff';
    default: return fallback || 'application/octet-stream';
  }
}

const INSTRUCTIONS =
  `Rozhodni, zda jde o ÚČETNÍ DOKLAD (faktura, daňový doklad, účtenka, dobropis, ` +
  `proforma faktura, bankovní výpis). Loga, ikony, podpisové obrázky, marketingové ` +
  `bannery, screenshoty a oznámení/notifikace NEJSOU účetní doklady.\n` +
  `ZPŮSOB PLATBY (paymentMethod): U dokladů za nákup MATERIÁLU nebo zboží ` +
  `(stavební materiál, drobné nákupy, maloobchodní účtenky/paragony) je výchozí ` +
  `platba HOTOVOST (cash), pokud doklad VÝSLOVNĚ neuvádí jinak — platbu kartou (card), ` +
  `převodem (bank_transfer) nebo dobírku (cod). Samotná přítomnost bankovního účtu/spojení ` +
  `na dokladu NEznamená platbu převodem. Pouze pokud opravdu nelze určit a nejde o ` +
  `materiál/zboží, vrať unknown.`;

const JSON_SPEC =
  `Odpověz POUZE JSON: {"isAccountingDocument": true/false, ` +
  `"confidence": 0.0-1.0 (pravděpodobnost, že JDE o účetní doklad; 0=určitě ne, 1=určitě ano), ` +
  `"docType": "invoice|receipt|credit_note|proforma|order|delivery_note|statement|other", ` +
  `"paymentMethod": "cash|card|bank_transfer|cod|unknown (dle pravidla výše; materiál/zboží = cash, není-li výslovně jinak)", ` +
  `"reason": "krátké zdůvodnění"}`;

export class DocumentClassifier {
  /**
   * @param {{ apiKey: string, classifierModel?: string }} config
   */
  constructor(config) {
    this.mistral = new Mistral({ apiKey: config.apiKey });
    this.model = config.classifierModel || DEFAULT_CLASSIFIER_MODEL;
  }

  /**
   * Classify a single attachment by its actual content.
   * @param {{filename:string, path:string, mimeType?:string}} attachment
   * @param {{subject?:string, from?:string}} [context]
   * @returns {Promise<{isAccountingDocument:boolean, confidence:number, docType:string, paymentMethod:string, reason:string}>}
   */
  async classifyAttachment(attachment, context = {}) {
    let buffer = await fs.readFile(attachment.path);
    let mimeType = guessMimeType(attachment.filename, attachment.mimeType);

    // Apple HEIC/HEIF isn't accepted by Mistral vision — transcode to JPEG first.
    if (mimeType === 'image/heic' || mimeType === 'image/heif') {
      const jpeg = await convertHeic({ buffer, format: 'JPEG', quality: 0.9 });
      buffer = Buffer.from(jpeg);
      mimeType = 'image/jpeg';
    }

    const ctx =
      `Název souboru: ${attachment.filename}\n` +
      `Předmět e-mailu: ${context.subject || '(neznámý)'}\n` +
      `Odesílatel: ${context.from || '(neznámý)'}`;

    // Images: classify the picture directly — no OCR needed (much cheaper).
    if (VISION_MIME_TYPES.has(mimeType)) {
      const dataUri = `data:${mimeType};base64,${buffer.toString('base64')}`;
      return this.#chatClassify([
        { type: 'text', text: `${INSTRUCTIONS}\n${ctx}\n${JSON_SPEC}` },
        { type: 'image_url', imageUrl: dataUri },
      ]);
    }

    // PDFs (and anything else): OCR to text first, then classify the text.
    const text = await this.#ocrToText(buffer, mimeType, attachment.filename);
    return this.#chatClassify(
      `${INSTRUCTIONS}\n${ctx}\n--- OBSAH (z OCR) ---\n${text.slice(0, 6000)}\n--- KONEC ---\n${JSON_SPEC}`
    );
  }

  /** Run OCR and return the concatenated page markdown. */
  async #ocrToText(buffer, mimeType, filename) {
    const dataUri = `data:${mimeType};base64,${buffer.toString('base64')}`;
    const document = mimeType === 'application/pdf'
      ? { type: 'document_url', documentUrl: dataUri, documentName: filename }
      : { type: 'image_url', imageUrl: dataUri };
    const res = await this.mistral.ocr.process({ model: OCR_MODEL, document });
    return (res.pages || []).map((p) => p.markdown || '').join('\n');
  }

  /** @param {string|Array} content chat message content (text or multimodal parts) */
  async #chatClassify(content) {
    const res = await this.mistral.chat.complete({
      model: this.model,
      messages: [{ role: 'user', content }],
      responseFormat: { type: 'json_object' },
      temperature: 0,
    });
    const raw = res.choices?.[0]?.message?.content;
    if (typeof raw === 'string') {
      try {
        const parsed = JSON.parse(raw);
        return {
          isAccountingDocument: Boolean(parsed.isAccountingDocument),
          confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || 0)),
          docType: parsed.docType || 'other',
          paymentMethod: parsed.paymentMethod || 'unknown',
          reason: parsed.reason || '',
        };
      } catch {
        /* fall through */
      }
    }
    return { isAccountingDocument: false, confidence: 0, docType: 'other', paymentMethod: 'unknown', reason: 'classification_unavailable' };
  }
}
