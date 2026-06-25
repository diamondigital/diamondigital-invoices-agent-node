// src/trivi-auth.js — TRIVI bearer token management (cached, auto-refresh)
import axios from 'axios';

export class TriviAuth {
  #accessToken = null;
  #expiresAt = 0;

  /**
   * @param {{ appId: string, appSecret: string }} config
   */
  constructor(config) {
    this.config = config;
  }

  async getToken() {
    // Return cached token if still valid (5 min buffer)
    if (this.#accessToken && Date.now() < this.#expiresAt - 300_000) {
      return this.#accessToken;
    }

    console.log('[trivi-auth] Obtaining new access token...');
    const { data } = await axios.post('https://api.trivi.com/auth/token', {
      appId: this.config.appId,
      appSecret: this.config.appSecret,
    });

    this.#accessToken = data.access_token;
    this.#expiresAt = Date.now() + data.expires_in * 1000;
    console.log(`[trivi-auth] Token obtained, expires in ${data.expires_in}s`);

    return this.#accessToken;
  }
}
