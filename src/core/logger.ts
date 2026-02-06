import pino from 'pino';
import type { Env } from '../config/env.js';

export type Logger = pino.Logger;

/**
 * Sensitive field patterns to redact from logs.
 * Uses pino's path syntax: wildcards match any nested key.
 */
const REDACT_PATHS = [
  'req.headers.authorization',
  'res.headers.authorization',
  '*.token',
  '*.bearerToken',
  '*.apiKey',
  '*.password',
  '*.secret',
  '*.credential',
  '*.jwt',
  '*.POKE_API_KEY',
  '*.ORCHESTRATOR_API_KEY',
];

export function createLogger(env: Env): Logger {
  const isDev = env.NODE_ENV === 'development';

  return pino({
    level: isDev ? 'debug' : 'info',
    ...(isDev
      ? {
          transport: {
            target: 'pino-pretty',
            options: { colorize: true },
          },
        }
      : {}),
    base: {
      service: 'poke-orchestrator',
      environment: env.NODE_ENV,
    },
    redact: REDACT_PATHS,
  });
}
