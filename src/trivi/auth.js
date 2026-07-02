import axios from 'axios';

export class TriviAuth {
  #accessToken = null;
  #expiresAt = 0;

  constructor(config) {
    this.config = config;
  }

  async getToken() {
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
