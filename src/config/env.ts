import { z } from 'zod';

/**
 * Coerce a string to boolean with explicit values only.
 * Defaults to true if not set (for BYPASS_PERMISSIONS).
 */
const coerceBooleanDefaultTrue = z
  .enum(['true', 'false', '1', '0', ''])
  .optional()
  .transform((val) => val !== 'false' && val !== '0');

/**
 * Environment variable schema with validation
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'staging', 'production']).default('development'),

  // Orchestrator settings
  ORCHESTRATOR_API_KEY: z.string().min(1).optional(),
  MAX_SESSIONS: z.coerce.number().int().positive().default(5),
  SESSION_TIMEOUT_MS: z.coerce.number().int().positive().default(3600000), // 1 hour
  MCP_PORT: z.coerce.number().int().positive().default(3000),
  WORKSPACES_DIR: z.string().default('/tmp/poke-orchestrator/workspaces'),

  // Poke settings
  POKE_API_KEY: z.string().min(1),
  POKE_BASE_URL: z.url().default('https://poke.com'),
  POKE_WEBHOOK_ENDPOINT: z.string().default('/api/v1/inbound-sms/webhook'),
  WEBHOOK_BATCH_INTERVAL_MS: z.coerce.number().int().positive().default(5000),

  // Claude Code settings (default to true)
  BYPASS_PERMISSIONS: coerceBooleanDefaultTrue,
});

export type Env = z.infer<typeof envSchema>;

let cachedEnv: Env | null = null;

/**
 * Load and validate environment variables.
 * Exits the process if validation fails.
 * Results are cached after first call.
 */
export function loadEnv(): Env {
  if (cachedEnv) {
    return cachedEnv;
  }

  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    console.error('Invalid environment variables:');
    console.error(result.error.format());
    process.exit(1);
  }

  cachedEnv = result.data;
  return cachedEnv;
}

/**
 * Get the validated environment.
 * Throws if loadEnv() hasn't been called yet.
 */
export function getEnv(): Env {
  if (!cachedEnv) {
    throw new Error('Environment not loaded. Call loadEnv() first.');
  }
  return cachedEnv;
}

/**
 * Update a cached env value (useful for API key generation)
 */
export function setEnvValue<K extends keyof Env>(key: K, value: Env[K]): void {
  if (!cachedEnv) {
    throw new Error('Environment not loaded. Call loadEnv() first.');
  }
  cachedEnv[key] = value;
}
