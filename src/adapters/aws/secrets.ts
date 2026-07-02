import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import type { AppConfig } from '../../domain/types.js';

export async function loadFromSecretsManager(secretName: string): Promise<AppConfig> {
  const client = new SecretsManagerClient({});
  const response = await client.send(new GetSecretValueCommand({ SecretId: secretName }));
  return JSON.parse(response.SecretString ?? '{}') as AppConfig;
}
