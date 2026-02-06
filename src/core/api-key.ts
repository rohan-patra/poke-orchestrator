import { randomBytes } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, readFileSync } from 'node:fs';
import { type Env, setEnvValue } from '../config/env.js';
import type { Logger } from './logger.js';

/**
 * Generates a cryptographically secure API key
 */
export function generateApiKey(): string {
  return randomBytes(32).toString('hex');
}

/**
 * Ensures an API key exists, generating one if necessary.
 * Appends the key to .env file if generated and sets secure file permissions.
 * Never logs the key value itself.
 */
export function ensureApiKey(envPath: string, env: Env, logger: Logger): string {
  // Check if already set in environment
  if (env.ORCHESTRATOR_API_KEY) {
    logger.debug('Using existing ORCHESTRATOR_API_KEY from environment');
    return env.ORCHESTRATOR_API_KEY;
  }

  // Check if .env file exists and contains the key
  if (existsSync(envPath)) {
    try {
      const content = readFileSync(envPath, 'utf-8');
      const match = content.match(/ORCHESTRATOR_API_KEY=([^\n\r]+)/);
      if (match?.[1]) {
        const key = match[1].trim();
        if (key) {
          setEnvValue('ORCHESTRATOR_API_KEY', key);
          logger.debug('Loaded ORCHESTRATOR_API_KEY from .env file');
          return key;
        }
      }
    } catch (error) {
      logger.warn({ error }, 'Failed to read .env file');
    }
  }

  // Generate a new key
  const apiKey = generateApiKey();

  // Append to .env file with secure permissions
  try {
    const newLine = existsSync(envPath) ? '\n' : '';
    appendFileSync(envPath, `${newLine}ORCHESTRATOR_API_KEY=${apiKey}\n`);
    try {
      chmodSync(envPath, 0o600);
    } catch {
      logger.warn('Could not set secure permissions on .env file');
    }
    logger.info({ envPath }, 'Generated new ORCHESTRATOR_API_KEY and saved to .env file');
  } catch (error) {
    logger.warn({ error }, 'Failed to save API key to .env file (using in-memory key)');
  }

  // Update cached env
  setEnvValue('ORCHESTRATOR_API_KEY', apiKey);

  return apiKey;
}
