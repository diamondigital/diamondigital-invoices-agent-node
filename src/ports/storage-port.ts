export interface StoragePort {
  archiveEmail(emailId: string, content: string): Promise<void>;
}
