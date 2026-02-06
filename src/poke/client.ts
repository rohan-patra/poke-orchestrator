import { PokeApiError } from '../core/errors.js';
import type { Logger } from '../core/logger.js';
import type { PokeConfig } from './types.js';

export class PokeClient {
  private baseUrl: string;
  private bearerToken: string;
  private webhookEndpoint: string;

  constructor(
    config: PokeConfig,
    private logger: Logger
  ) {
    this.baseUrl = config.apiBaseUrl;
    this.bearerToken = config.bearerToken;
    this.webhookEndpoint = config.webhookEndpoint;
  }

  async sendInboundMessage(message: string): Promise<void> {
    const url = `${this.baseUrl}${this.webhookEndpoint}`;

    this.logger.debug({ url }, 'Sending message to Poke');

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.bearerToken}`,
      },
      body: JSON.stringify({ message }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new PokeApiError(`Poke API error: ${response.statusText}`, response.status, {
        body: errorBody,
      });
    }

    this.logger.info('Message sent to Poke successfully');
  }
}
