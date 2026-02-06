import { z } from 'zod';
import type { Env } from '../config/env.js';

/**
 * Configuration schema for the orchestrator
 */
export const configSchema = z.object({
  // Orchestrator settings
  maxSessions: z.number().int().positive().default(5),
  sessionTimeoutMs: z.number().int().positive().default(3600000), // 1 hour
  apiKey: z.string().default(''), // Generated at runtime if not set
  workspacesDir: z.string().default('/tmp/poke-orchestrator/workspaces'),

  // Poke settings
  poke: z.object({
    apiKey: z.string().min(1),
    baseUrl: z.string().url().default('https://poke.com'),
    webhookEndpoint: z.string().default('/api/v1/inbound-sms/webhook'),
    batchIntervalMs: z.number().int().positive().default(200),
  }),

  // Claude Code settings
  claude: z.object({
    bypassPermissions: z.boolean().default(true),
  }),

  // MCP server settings
  mcp: z.object({
    port: z.number().int().positive().default(3000),
  }),
});

export type OrchestratorConfig = z.infer<typeof configSchema>;

/**
 * Loads configuration from validated environment
 */
export function loadConfigFromEnv(env: Env): OrchestratorConfig {
  const config = {
    maxSessions: env.MAX_SESSIONS,
    sessionTimeoutMs: env.SESSION_TIMEOUT_MS,
    apiKey: env.ORCHESTRATOR_API_KEY ?? '',
    workspacesDir: env.WORKSPACES_DIR,

    poke: {
      apiKey: env.POKE_API_KEY,
      baseUrl: env.POKE_BASE_URL,
      webhookEndpoint: env.POKE_WEBHOOK_ENDPOINT,
      batchIntervalMs: env.WEBHOOK_BATCH_INTERVAL_MS,
    },

    claude: {
      bypassPermissions: env.BYPASS_PERMISSIONS,
    },

    mcp: {
      port: env.MCP_PORT,
    },
  };

  return configSchema.parse(config);
}

/**
 * Validates a config object
 */
export function validateConfig(config: unknown): OrchestratorConfig {
  return configSchema.parse(config);
}
