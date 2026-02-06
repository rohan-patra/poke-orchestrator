import type { FastMCP } from 'fastmcp';
import { SessionManager } from './claude/session-manager.js';
import { type Env, loadEnv } from './config/env.js';
import {
  createLogger,
  ensureApiKey,
  type Logger,
  loadConfigFromEnv,
  type OrchestratorConfig,
  validateConfig,
} from './core/index.js';
import { createAndStartMcpServer } from './mcp/server.js';
import { createWebhookEventHandler, PokeWebhookSender } from './poke/webhook-sender.js';

/**
 * Options for creating the orchestrator
 */
export interface OrchestratorOptions {
  config?: Partial<OrchestratorConfig>;
  logger?: Logger;
}

/**
 * Merges a partial config override into a base config, re-validating with Zod.
 */
function mergeConfig(base: OrchestratorConfig, overrides?: Partial<OrchestratorConfig>): OrchestratorConfig {
  if (!overrides) return base;

  return validateConfig({
    ...base,
    ...overrides,
    poke: { ...base.poke, ...overrides.poke },
    claude: { ...base.claude, ...overrides.claude },
    mcp: { ...base.mcp, ...overrides.mcp },
  });
}

/**
 * Main orchestrator that ties everything together.
 * Uses FastMCP for MCP server (stateless HTTP mode for Poke compatibility).
 */
export class Orchestrator {
  private readonly config: OrchestratorConfig;
  private readonly logger: Logger;
  private readonly sessionManager: SessionManager;
  private readonly webhookSender: PokeWebhookSender;
  private mcpServer: FastMCP | null = null;
  private shutdownPromise: Promise<void> | null = null;

  constructor(env: Env, options: OrchestratorOptions = {}) {
    // Set up logger
    this.logger = options.logger ?? createLogger(env);

    // Load, merge, and validate config
    const baseConfig = loadConfigFromEnv(env);
    this.config = mergeConfig(baseConfig, options.config);

    // Ensure API key exists
    const apiKey = ensureApiKey('.env', env, this.logger);
    this.config.apiKey = apiKey;

    // Create webhook sender
    this.webhookSender = new PokeWebhookSender({
      config: {
        bearerToken: this.config.poke.apiKey,
        apiBaseUrl: this.config.poke.baseUrl,
        webhookEndpoint: this.config.poke.webhookEndpoint,
        batchIntervalMs: this.config.poke.batchIntervalMs,
      },
      logger: this.logger,
    });

    // Create session manager with webhook event handler
    this.sessionManager = new SessionManager({
      maxSessions: this.config.maxSessions,
      sessionTimeoutMs: this.config.sessionTimeoutMs,
      bypassPermissions: this.config.claude.bypassPermissions,
      workspacesDir: this.config.workspacesDir,
      logger: this.logger,
      onEvent: createWebhookEventHandler(this.webhookSender),
    });

    this.logger.info({ maxSessions: this.config.maxSessions }, 'Orchestrator initialized');
  }

  /**
   * Starts the orchestrator server.
   * FastMCP handles the HTTP server internally with stateless mode.
   */
  async start(port?: number): Promise<void> {
    const serverPort = port ?? this.config.mcp.port;

    // Start FastMCP server (handles its own HTTP server)
    this.mcpServer = await createAndStartMcpServer({
      sessionManager: this.sessionManager,
      logger: this.logger,
      apiKey: this.config.apiKey,
      port: serverPort,
    });

    this.logger.info({ port: serverPort }, 'Orchestrator server started');
  }

  /**
   * Stops the orchestrator server with a graceful shutdown timeout.
   * Safe to call multiple times — subsequent calls return the same promise.
   */
  async stop(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;

    this.shutdownPromise = this.performShutdown();
    return this.shutdownPromise;
  }

  private async performShutdown(): Promise<void> {
    this.logger.info('Shutting down orchestrator...');

    const SHUTDOWN_TIMEOUT_MS = 15_000;
    const forceTimer = setTimeout(() => {
      this.logger.error('Graceful shutdown timed out, forcing exit');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    // Don't keep the process alive just for the timer
    forceTimer.unref();

    try {
      // Shutdown session manager first (terminates all Claude processes)
      await this.sessionManager.shutdown();

      // Then flush remaining webhooks
      await this.webhookSender.shutdown();

      // Release MCP server reference
      if (this.mcpServer) {
        this.mcpServer = null;
        this.logger.info('MCP server stopped');
      }

      this.logger.info('Orchestrator shutdown complete');
    } finally {
      clearTimeout(forceTimer);
    }
  }

  /**
   * Gets the FastMCP server instance (for testing)
   */
  getMcpServer(): FastMCP | null {
    return this.mcpServer;
  }

  /**
   * Gets the session manager (for testing)
   */
  getSessionManager(): SessionManager {
    return this.sessionManager;
  }

  getLogger(): Logger {
    return this.logger;
  }
}

/**
 * Creates and starts an orchestrator
 */
export async function createOrchestrator(options?: OrchestratorOptions): Promise<Orchestrator> {
  const env = loadEnv();
  const orchestrator = new Orchestrator(env, options);
  await orchestrator.start();
  return orchestrator;
}

// Main entry point when running directly
if (import.meta.url === `file://${process.argv[1]}`) {
  // Load and validate environment first
  const env = loadEnv();

  const orchestrator = new Orchestrator(env);
  const logger = orchestrator.getLogger();

  // Handle graceful shutdown — safe against duplicate signals
  const shutdown = async () => {
    await orchestrator.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  orchestrator.start().catch((error) => {
    logger.error({ err: error }, 'Failed to start orchestrator');
    process.exit(1);
  });
}
