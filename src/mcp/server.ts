import type { IncomingMessage } from 'node:http';
import { FastMCP } from 'fastmcp';
import type { SessionManager } from '../claude/session-manager.js';
import type { Logger } from '../core/logger.js';
import { createToolHandlers, type ToolResult } from './handlers.js';
import { toolDefinitions } from './tools.js';

/**
 * Options for creating the MCP server
 */
export interface McpServerOptions {
  sessionManager: SessionManager;
  logger: Logger;
  apiKey: string;
  port: number;
}

/**
 * Authentication result type.
 * Must extend Record<string, unknown> to satisfy FastMCPSessionAuth.
 */
type AuthResult = {
  authenticated: boolean;
  [key: string]: unknown;
};

/**
 * Helper to get text content from tool result.
 */
function getResultText(result: ToolResult): string {
  return result.content[0]?.text ?? JSON.stringify({ error: 'INTERNAL_ERROR', message: 'No content' });
}

/**
 * Creates and starts the FastMCP server with all tools registered.
 * Uses stateless HTTP mode for Poke compatibility.
 */
export async function createAndStartMcpServer(options: McpServerOptions): Promise<FastMCP> {
  const { sessionManager, logger, apiKey, port } = options;

  // Wrap pino logger to match FastMCP's console-like Logger interface,
  // suppressing the noisy "could not infer client capabilities" warning
  // that fires on every stateless HTTP request (expected in stateless mode).
  const SUPPRESSED_WARNINGS = ['could not infer client capabilities'];
  const fastmcpLogger = {
    debug: (...args: unknown[]) => logger.debug(args.join(' ')),
    info: (...args: unknown[]) => logger.info(args.join(' ')),
    log: (...args: unknown[]) => logger.info(args.join(' ')),
    warn: (...args: unknown[]) => {
      const msg = args.join(' ');
      if (SUPPRESSED_WARNINGS.some((s) => msg.includes(s))) return;
      logger.warn(msg);
    },
    error: (...args: unknown[]) => logger.error(args.join(' ')),
  };

  const server = new FastMCP<AuthResult>({
    name: 'poke-orchestrator',
    version: '1.0.0',
    logger: fastmcpLogger,
    authenticate: async (request: IncomingMessage): Promise<AuthResult> => {
      const authHeader = request.headers.authorization;
      if (!authHeader?.startsWith('Bearer ')) {
        throw new Error('Missing API key');
      }
      const providedKey = authHeader.slice(7);
      if (providedKey !== apiKey) {
        throw new Error('Invalid API key');
      }
      return { authenticated: true };
    },
  });

  // Create handlers
  const handlers = createToolHandlers(sessionManager, logger);

  // Register all tools from definitions — descriptions come from toolDefinitions,
  // handlers come from createToolHandlers. Both keyed by tool name.
  for (const [name, def] of Object.entries(toolDefinitions)) {
    const handlerFn = handlers[name as keyof typeof handlers];
    if (!handlerFn) {
      logger.warn({ tool: name }, 'Tool definition exists but no handler found, skipping');
      continue;
    }

    server.addTool({
      name: def.name,
      description: def.description,
      parameters: def.inputSchema,
      execute: async (args: unknown) => {
        const result = await (handlerFn as (input: unknown) => Promise<ToolResult>)(args);
        return getResultText(result);
      },
    });
  }

  // Start with stateless HTTP streaming for Poke compatibility
  await server.start({
    transportType: 'httpStream',
    httpStream: {
      port,
      stateless: true,
    },
  });

  logger.info({ port }, 'FastMCP server started with stateless HTTP transport');
  logger.info(`MCP endpoint: http://localhost:${port}/mcp`);
  logger.info(`SSE endpoint: http://localhost:${port}/sse`);

  return server;
}
