import type { AppConfig } from '../domain/types.js';
import type { EmailPort } from './email-port.js';
import type { TriviPort } from './trivi-port.js';
import type { ClassifierPort } from './classifier-port.js';
import type { StoragePort } from './storage-port.js';
import type { NotificationPort } from './notification-port.js';
export interface Services {
  cfg: AppConfig;
  email: EmailPort;
  trivi: TriviPort;
  classifier: ClassifierPort | null;
  storage: StoragePort;
  notification: NotificationPort;
}
