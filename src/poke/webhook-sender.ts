import { Pool } from 'undici';
import type { SessionEvent } from '../claude/types.js';
import type { Logger } from '../core/logger.js';
import type { BatchedWebhookRequest, PokeConfig, PokeWebhookRequest, WebhookPayload } from './types.js';

/**
 * Options for the webhook sender
 */
export interface WebhookSenderOptions {
  config: PokeConfig;
  logger: Logger;
}

/**
 * Connection pool configuration
 */
interface PoolConfig {
  connections: number;
  pipelining: number;
  keepAliveTimeout: number;
  keepAliveMaxTimeout: number;
}

const DEFAULT_POOL_CONFIG: PoolConfig = {
  connections: 10, // Max concurrent connections
  pipelining: 1, // HTTP/1.1 pipelining
  keepAliveTimeout: 30000, // 30 seconds
  keepAliveMaxTimeout: 60000, // 60 seconds max
};

/**
 * Sends webhook updates to Poke with batching and connection pooling
 */
export class PokeWebhookSender {
  private readonly config: PokeConfig;
  private readonly logger: Logger;
  private readonly queue: WebhookPayload[] = [];
  private timer: NodeJS.Timeout | null = null;
  private readonly batchIntervalMs: number;
  private readonly pool: Pool;
  private readonly poolConfig: PoolConfig;

  constructor(options: WebhookSenderOptions) {
    this.config = options.config;
    this.logger = options.logger;
    this.batchIntervalMs = options.config.batchIntervalMs;
    this.poolConfig = DEFAULT_POOL_CONFIG;

    // Create connection pool for Poke API
    this.pool = new Pool(this.config.apiBaseUrl, {
      connections: this.poolConfig.connections,
      pipelining: this.poolConfig.pipelining,
      keepAliveTimeout: this.poolConfig.keepAliveTimeout,
      keepAliveMaxTimeout: this.poolConfig.keepAliveMaxTimeout,
    });

    this.logger.info(
      {
        baseUrl: this.config.apiBaseUrl,
        connections: this.poolConfig.connections,
        keepAliveTimeout: this.poolConfig.keepAliveTimeout,
      },
      'Webhook connection pool initialized'
    );
  }

  /**
   * Converts a session event to a webhook payload
   * Formats the payload as a JSON string in the `message` field for Poke compatibility
   */
  private eventToPayload(sessionId: string, event: SessionEvent): WebhookPayload {
    const timestamp = new Date().toISOString();

    switch (event.type) {
      case 'message_chunk':
        return {
          sessionId,
          type: 'message_chunk',
          content: event.content,
          timestamp,
        };

      case 'thinking':
        return {
          sessionId,
          type: 'thinking',
          content: event.content,
          timestamp,
        };

      case 'tool_call':
        return {
          sessionId,
          type: 'tool_call',
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          toolInput: event.toolInput,
          timestamp,
        };

      case 'tool_result':
        return {
          sessionId,
          type: 'tool_result',
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          result: event.result,
          isError: event.isError,
          timestamp,
        };

      case 'plan_update':
        return {
          sessionId,
          type: 'plan_update',
          entries: event.entries,
          timestamp,
        };

      case 'plan_mode_change':
        return {
          sessionId,
          type: 'plan_mode_change',
          inPlanMode: event.inPlanMode,
          timestamp,
        };

      case 'question':
        return {
          sessionId,
          type: 'question',
          questionId: event.questionId,
          question: event.question,
          options: event.options,
          multiSelect: event.multiSelect,
          timestamp,
        };

      case 'permission_request':
        return {
          sessionId,
          type: 'permission_request',
          permissionId: event.permissionId,
          toolName: event.toolName,
          toolInput: event.toolInput,
          options: event.options,
          timestamp,
        };

      case 'session_ended':
        return {
          sessionId,
          type: 'session_ended',
          reason: event.reason,
          timestamp,
        };

      case 'error':
        return {
          sessionId,
          type: 'error',
          message: event.message,
          timestamp,
        };
    }
  }

  /**
   * Formats payloads as a Poke-compatible webhook request
   * Poke expects { message: string } format
   */
  private formatAsPokeMessage(payloads: WebhookPayload[]): PokeWebhookRequest {
    return {
      message: JSON.stringify({ updates: payloads }),
    };
  }

  /**
   * Determines if an event is relevant for Poke orchestration
   * Only sends events that Poke needs to:
   * - Give input (questions, permission requests)
   * - Monitor direction (tool calls, plan updates)
   * - Get results (session ended, errors)
   */
  private isRelevantForPoke(event: SessionEvent): boolean {
    switch (event.type) {
      // Poke needs to respond to these
      case 'question':
      case 'permission_request':
        return true;

      // Poke needs to monitor progress/direction
      case 'plan_mode_change':
        return true;

      // Poke needs to know when session ends or errors
      case 'session_ended':
      case 'error':
        return true;

      // Skip streaming content - too noisy
      case 'message_chunk':
      case 'tool_call':
      case 'tool_result':
      case 'thinking':
      case 'plan_update':
        return false;

      default:
        return false;
    }
  }

  /**
   * Queues an event for sending to Poke
   * Only queues events relevant for orchestration
   */
  queueEvent(sessionId: string, event: SessionEvent): void {
    // Filter out noisy events
    if (!this.isRelevantForPoke(event)) {
      return;
    }

    const payload = this.eventToPayload(sessionId, event);
    this.queue.push(payload);

    // Start the batch timer if not already running
    if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), this.batchIntervalMs);
    }
  }

  /**
   * Sends a payload immediately (bypassing batch queue)
   */
  async sendImmediate(payload: WebhookPayload): Promise<void> {
    await this.sendToPoke({ updates: [payload] });
  }

  /**
   * Flushes the queue and sends batched updates
   */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    if (this.queue.length === 0) {
      return;
    }

    const batch = this.queue.splice(0);
    await this.sendToPoke({ updates: batch });
  }

  /**
   * Sends a batched request to Poke using connection pool
   * Formats the payload as { message: string } for Poke compatibility
   * Includes retry logic with exponential backoff
   */
  private async sendToPoke(request: BatchedWebhookRequest, maxRetries = 3): Promise<void> {
    const path = this.config.webhookEndpoint;

    // Format as Poke-compatible message
    const pokePayload = this.formatAsPokeMessage(request.updates);
    const body = JSON.stringify(pokePayload);

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        this.logger.debug(
          { path, count: request.updates.length, attempt: attempt + 1 },
          'Sending webhook batch to Poke'
        );

        const response = await this.pool.request({
          path,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.config.bearerToken}`,
          },
          body,
        });

        // Read the response body to free up the connection
        const responseBody = await response.body.text();

        if (response.statusCode >= 200 && response.statusCode < 300) {
          this.logger.debug({ count: request.updates.length }, 'Webhook batch sent successfully');
          return;
        }

        // 4xx errors - don't retry (client error)
        if (response.statusCode >= 400 && response.statusCode < 500) {
          this.logger.error(
            { status: response.statusCode, body: responseBody },
            'Failed to send webhook to Poke (client error, not retrying)'
          );
          return;
        }

        // 5xx errors - retry with backoff
        this.logger.warn(
          { status: response.statusCode, attempt: attempt + 1, maxRetries },
          'Server error sending webhook, will retry'
        );

        if (attempt < maxRetries - 1) {
          const backoffMs = 2 ** attempt * 100; // 100ms, 200ms, 400ms
          await this.sleep(backoffMs);
        }
      } catch (error) {
        this.logger.error({ error, attempt: attempt + 1, maxRetries }, 'Error sending webhook to Poke');

        if (attempt < maxRetries - 1) {
          const backoffMs = 2 ** attempt * 100;
          await this.sleep(backoffMs);
        }
      }
    }

    this.logger.error({ count: request.updates.length }, 'Failed to send webhook after all retries');
  }

  /**
   * Sleep helper for retry backoff
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Shuts down the webhook sender and closes connection pool
   */
  async shutdown(): Promise<void> {
    // Flush any remaining items
    await this.flush();

    // Close the connection pool
    await this.pool.close();
    this.logger.info('Webhook connection pool closed');
  }
}

/**
 * Creates a webhook event handler for the session manager
 */
export function createWebhookEventHandler(sender: PokeWebhookSender) {
  return (sessionId: string, event: SessionEvent): void => {
    sender.queueEvent(sessionId, event);
  };
}
