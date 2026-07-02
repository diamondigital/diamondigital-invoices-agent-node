import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import type { NotificationPort } from '../../ports/notification-port.js';
import type { NotificationConfig } from '../../domain/types.js';

export class SnsNotificationAdapter implements NotificationPort {
  private readonly topicArn: string;
  private readonly sns: SNSClient | null;

  constructor(config: NotificationConfig) {
    this.topicArn = config.snsTopicArn;
    this.sns = this.topicArn ? new SNSClient({}) : null;
  }

  async sendSummary(message: string): Promise<void> {
    if (!this.sns || !this.topicArn) {
      console.log('[notification] SNS not configured, logging:\n' + message);
      return;
    }

    await this.sns.send(new PublishCommand({
      TopicArn: this.topicArn,
      Subject: 'Diamondigital Documents Upload Agent — Daily Report',
      Message: message,
    }));
    console.log('[notification] Summary sent');
  }

  async sendAlert(subject: string, body: string): Promise<void> {
    const message = `⚠️ ${subject}\n\n${body}`;

    if (!this.sns || !this.topicArn) {
      console.error('[notification] ALERT (SNS not configured):\n' + message);
      return;
    }

    await this.sns.send(new PublishCommand({
      TopicArn: this.topicArn,
      Subject: `ALERT: ${subject}`,
      Message: message,
    }));
    console.log('[notification] Alert sent');
  }
}
