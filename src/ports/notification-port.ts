export interface NotificationPort {
  sendSummary(message: string): Promise<void>;
  sendAlert(subject: string, body: string): Promise<void>;
}
