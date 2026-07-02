import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';

export class NotificationService {
  constructor(config) {
    this.topicArn = config.snsTopicArn;
    this.sns = this.topicArn ? new SNSClient({}) : null;
  }

  async sendSummary(message) {
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

  async sendAlert(subject, body) {
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
