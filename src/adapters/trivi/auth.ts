import axios from 'axios';
import type { TriviConfig } from '../../domain/types.js';

interface TokenResponse {
  access_token: string;
  expires_in: number;
}

export class TriviAuth {
  #accessToken: string | null = null;
  #expiresAt: number = 0;
  private config: Pick<TriviConfig, 'appId' | 'appSecret'>;

  constructor(config: Pick<TriviConfig, 'appId' | 'appSecret'>) {
    this.config = config;
  }

  async getToken(): Promise<string> {
    if (this.#accessToken && Date.now() < this.#expiresAt - 300_000) {
      return this.#accessToken;
    }

    console.log('[trivi-auth] Obtaining new access token...');
    const { data } = await axios.post<TokenResponse>('https://api.trivi.com/auth/token', {
      appId: this.config.appId,
      appSecret: this.config.appSecret,
    });

    this.#accessToken = data.access_token;
    this.#expiresAt = Date.now() + data.expires_in * 1000;
    console.log(`[trivi-auth] Token obtained, expires in ${data.expires_in}s`);

    return this.#accessToken;
  }
}
