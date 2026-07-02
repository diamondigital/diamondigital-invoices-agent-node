export interface Attachment {
  filename: string;
  path: string;
  mimeType: string;
  sizeBytes: number;
}
export type PaymentMethod = 'cash' | 'card' | 'bank_transfer' | 'cod' | 'unknown';
export interface Classification {
  isAccountingDocument: boolean;
  confidence: number;
  docType: string;
  paymentMethod: PaymentMethod;
  reason: string;
}
export interface ClassificationResult {
  filename: string;
  isAccountingDocument: boolean;
  confidence: number;
  docType: string;
  paymentMethod?: PaymentMethod;
  reason: string;
  uploaded: boolean;
}
export interface EmailMessage {
  emailId: string;
  subject: string;
  from: string;
  receivedDate: Date;
  bodyText: string;
  bodyHtml?: string;
  attachments: Attachment[];
}
export interface ProcessResult {
  emailId: string;
  subject: string;
  success: boolean;
  classifications?: ClassificationResult[];
  uploadedCount?: number;
  uploadedNames?: string[];
  skipped?: boolean;
  skipReason?: string;
  error?: string;
}
export interface UploadMetadata {
  subject?: string;
  from?: string;
  receivedDate?: string;
  classification?: Partial<Classification>;
}
export interface UploadResult {
  fileId: string | number;
  scan: unknown;
}
export interface EmailConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
  processedLabel: string;
  skippedFolder: string;
}
export interface TriviConfig {
  appId: string;
  appSecret: string;
  baseUrl: string;
  uploadsPath: string;
  scansPath: string;
  uploadFieldName: string;
}
export interface MistralConfig {
  apiKey: string;
  classifierModel: string;
  uploadThreshold: number;
}
export interface NotificationConfig {
  snsTopicArn: string;
  adminEmail: string;
}
export interface S3Config {
  bucketName: string;
}
export interface AppConfig {
  email: EmailConfig;
  trivi: TriviConfig;
  mistral: MistralConfig;
  notification: NotificationConfig;
  s3: S3Config;
}
