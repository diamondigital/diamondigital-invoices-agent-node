import { Mistral } from '@mistralai/mistralai';
import convertHeic from 'heic-convert';
import fs from 'node:fs/promises';
import { guessMimeType, parseClassification } from '../../domain/classification.js';
import type { Attachment, Classification, MistralConfig } from '../../domain/types.js';
import type { ClassifierPort, ClassifyContext } from '../../ports/classifier-port.js';

export const DEFAULT_CLASSIFIER_MODEL = 'ministral-8b-latest';
export const OCR_MODEL = 'mistral-ocr-latest';

const VISION_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

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

type ChatContent = string | Array<{ type: 'text'; text: string } | { type: 'image_url'; imageUrl: string }>;

export class MistralClassifierAdapter implements ClassifierPort {
  private readonly mistral: Mistral;
  private readonly model: string;

  constructor(config: Pick<MistralConfig, 'apiKey' | 'classifierModel'>) {
    this.mistral = new Mistral({ apiKey: config.apiKey });
    this.model = config.classifierModel || DEFAULT_CLASSIFIER_MODEL;
  }

  async classifyAttachment(attachment: Attachment, context: ClassifyContext = {}): Promise<Classification> {
    let buffer = await fs.readFile(attachment.path);
    let mimeType = guessMimeType(attachment.filename, attachment.mimeType);

    if (mimeType === 'image/heic' || mimeType === 'image/heif') {
      const jpeg = await convertHeic({ buffer, format: 'JPEG', quality: 0.9 });
      buffer = Buffer.from(jpeg);
      mimeType = 'image/jpeg';
    }

    const ctx =
      `Název souboru: ${attachment.filename}\n` +
      `Předmět e-mailu: ${context.subject || '(neznámý)'}\n` +
      `Odesílatel: ${context.from || '(neznámý)'}`;

    if (VISION_MIME_TYPES.has(mimeType)) {
      const dataUri = `data:${mimeType};base64,${buffer.toString('base64')}`;
      return this.chatClassify([
        { type: 'text', text: `${INSTRUCTIONS}\n${ctx}\n${JSON_SPEC}` },
        { type: 'image_url', imageUrl: dataUri },
      ]);
    }

    const text = await this.ocrToText(buffer, mimeType, attachment.filename);
    return this.chatClassify(
      `${INSTRUCTIONS}\n${ctx}\n--- OBSAH (z OCR) ---\n${text.slice(0, 6000)}\n--- KONEC ---\n${JSON_SPEC}`
    );
  }

  private async ocrToText(buffer: Buffer, mimeType: string, filename: string): Promise<string> {
    const dataUri = `data:${mimeType};base64,${buffer.toString('base64')}`;
    const document = mimeType === 'application/pdf'
      ? { type: 'document_url' as const, documentUrl: dataUri, documentName: filename }
      : { type: 'image_url' as const, imageUrl: dataUri };
    const res = await this.mistral.ocr.process({ model: OCR_MODEL, document });
    return (res.pages || []).map((p) => p.markdown || '').join('\n');
  }

  private async chatClassify(content: ChatContent): Promise<Classification> {
    const res = await this.mistral.chat.complete({
      model: this.model,
      messages: [{ role: 'user', content }],
      responseFormat: { type: 'json_object' },
      temperature: 0,
    });
    const raw = res.choices?.[0]?.message?.content as string | undefined;
    return parseClassification(raw);
  }
}
