import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  type Options,
  type Query,
  query,
  type SDKUserMessage,
  type SpawnedProcess,
  type SpawnOptions,
} from '@anthropic-ai/claude-agent-sdk';
import type { Logger } from '../core/logger.js';
import type {
  ClaudeSession,
  CreateSessionOptions,
  McpServerConfig,
  PermissionMode,
  Pushable,
  SessionEvent,
  SessionStatus,
} from './types.js';
import { createPushable, createSlashCommandMessage, createUserMessage } from './utils.js';

/**
 * Callback for session events
 */
export type SessionEventCallback = (sessionId: string, event: SessionEvent) => void | Promise<void>;

/**
 * Options for the Session class
 */
export interface SessionOptions extends CreateSessionOptions {
  id?: string;
  bypassPermissions?: boolean;
  onEvent?: SessionEventCallback;
  logger: Logger;
}

/**
 * Wraps a single Claude Code session.
 */
export class Session implements ClaudeSession {
  readonly id: string;
  readonly query: Query;
  readonly input: Pushable<SDKUserMessage> & AsyncIterable<SDKUserMessage>;
  status: SessionStatus;
  permissionMode: PermissionMode;
  readonly cwd: string;
  readonly mcpServers: McpServerConfig[];
  readonly createdAt: Date;
  lastActivityAt: Date;
  inPlanMode: boolean;

  private readonly logger: Logger;
  private readonly onEvent?: SessionEventCallback;
  private messageLoop: Promise<void> | null = null;
  private cancelled = false;

  // Message chunk aggregation — buffer text and flush every 50ms
  private textBuffer = '';
  private textFlushTimeout: NodeJS.Timeout | null = null;
  private readonly textFlushIntervalMs = 50;

  // Tool result tracking — map tool call IDs to tool names, with TTL cleanup
  private readonly toolCallNames: Map<string, string> = new Map();
  private readonly toolCallTimers: Map<string, NodeJS.Timeout> = new Map();
  private static readonly TOOL_CALL_TTL_MS = 10 * 60 * 1000; // 10 minutes

  // Event callback health tracking
  private consecutiveCallbackFailures = 0;
  private static readonly MAX_CALLBACK_FAILURES = 10;

  constructor(options: SessionOptions) {
    this.id = options.id ?? randomUUID();
    this.cwd = options.cwd;
    this.mcpServers = options.mcpServers ?? [];
    this.permissionMode = options.permissionMode ?? 'bypassPermissions';
    this.status = 'idle';
    this.createdAt = new Date();
    this.lastActivityAt = new Date();
    this.inPlanMode = false;
    this.logger = options.logger;
    this.onEvent = options.onEvent;

    // Create the input stream
    this.input = createPushable<SDKUserMessage>();

    // Convert MCP server configs to SDK format
    const mcpServers: NonNullable<Options['mcpServers']> = {};
    for (const server of this.mcpServers) {
      const name = `mcp-${randomUUID().slice(0, 8)}`;
      if (server.type === 'stdio') {
        mcpServers[name] = {
          type: 'stdio',
          command: server.command,
          args: server.args,
          env: server.env,
        };
      } else if (server.type === 'sse' || server.type === 'http') {
        mcpServers[name] = {
          type: server.type,
          url: server.url,
          headers: server.headers,
        };
      }
    }

    // Create the query with SDK options
    const queryOptions: Options = {
      cwd: this.cwd,
      includePartialMessages: true,
      allowDangerouslySkipPermissions: options.bypassPermissions ?? true,
      permissionMode: this.permissionMode,
      mcpServers,
      settingSources: ['user'],
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      // Custom spawn to capture stderr for debugging
      spawnClaudeCodeProcess: (spawnOptions: SpawnOptions): SpawnedProcess => {
        const args = [...spawnOptions.args];
        this.logger.debug(
          { command: spawnOptions.command, args: args, cwd: spawnOptions.cwd },
          'Spawning Claude Code process'
        );
        const proc = spawn(spawnOptions.command, args, {
          cwd: spawnOptions.cwd,
          env: spawnOptions.env,
          signal: spawnOptions.signal,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        proc.stderr?.on('data', (data: Buffer) => {
          this.logger.warn({ sessionId: this.id, stderr: data.toString() }, 'Claude Code stderr');
        });
        proc.on('error', (err: Error) => {
          this.logger.error({ sessionId: this.id, err }, 'Claude Code process spawn error');
        });
        proc.on('exit', (code: number | null, signal: string | null) => {
          this.logger.info({ sessionId: this.id, exitCode: code, signal }, 'Claude Code process exited');
        });
        return proc as unknown as SpawnedProcess;
      },
    };

    this.query = query({
      prompt: this.input,
      options: queryOptions,
    });

    // Start the message processing loop
    this.startMessageLoop();
  }

  /**
   * Starts the message processing loop.
   * On error: marks session as terminated and closes input to prevent zombie state.
   */
  private startMessageLoop(): void {
    this.messageLoop = this.processMessages().catch((error) => {
      this.logger.error({ err: error, sessionId: this.id }, 'Error in message loop');
      this.emitEvent({ type: 'error', message: error.message });
      this.status = 'terminated';
      this.input.end();
    });
  }

  /**
   * Processes incoming messages from Claude Code
   */
  private async processMessages(): Promise<void> {
    for await (const message of this.query) {
      if (this.cancelled) break;

      this.lastActivityAt = new Date();

      switch (message.type) {
        case 'stream_event': {
          const event = message.event;
          if (event.type === 'content_block_start' || event.type === 'content_block_delta') {
            const block = 'content_block' in event ? event.content_block : event.delta;
            if ('text' in block) {
              this.bufferTextChunk(block.text);
            } else if ('thinking' in block) {
              this.emitEvent({ type: 'thinking', content: block.thinking });
            }
          }
          break;
        }

        case 'assistant': {
          // Flush any pending text before processing assistant message
          this.flushTextBuffer();

          const content = message.message.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (
                block.type === 'tool_use' ||
                block.type === 'server_tool_use' ||
                block.type === 'mcp_tool_use'
              ) {
                this.trackToolCall(block.id, block.name);

                if (block.name === 'TodoWrite' && 'todos' in (block.input as Record<string, unknown>)) {
                  const input = block.input as { todos: Array<{ content: string; status: string }> };
                  this.emitEvent({ type: 'plan_update', entries: input.todos });
                } else {
                  this.emitEvent({
                    type: 'tool_call',
                    toolCallId: block.id,
                    toolName: block.name,
                    toolInput: block.input,
                  });
                }
              } else if (block.type === 'tool_result') {
                this.emitEvent({
                  type: 'tool_result',
                  toolCallId: block.tool_use_id,
                  toolName: this.getToolName(block.tool_use_id),
                  result: block.content,
                  isError: 'is_error' in block && Boolean(block.is_error),
                });
              }
            }
          }
          break;
        }

        case 'result': {
          if (message.subtype === 'success') {
            this.status = 'idle';
            this.emitEvent({ type: 'session_ended', reason: 'completed' });
          } else {
            this.status = 'idle';
            this.emitEvent({ type: 'session_ended', reason: 'error' });
          }
          break;
        }

        case 'system': {
          // Reserved for future plan mode status changes
          break;
        }
      }
    }
  }

  /**
   * Emits a session event. Tracks consecutive callback failures
   * and logs warnings if the callback is consistently failing.
   */
  private emitEvent(event: SessionEvent): void {
    if (this.onEvent) {
      Promise.resolve(this.onEvent(this.id, event))
        .then(() => {
          this.consecutiveCallbackFailures = 0;
        })
        .catch((error) => {
          this.consecutiveCallbackFailures++;
          this.logger.error(
            {
              err: error,
              sessionId: this.id,
              eventType: event.type,
              consecutiveFailures: this.consecutiveCallbackFailures,
            },
            'Error in event callback'
          );
          if (this.consecutiveCallbackFailures >= Session.MAX_CALLBACK_FAILURES) {
            this.logger.error(
              { sessionId: this.id, failures: this.consecutiveCallbackFailures },
              'Event callback consistently failing — webhook delivery may be down'
            );
          }
        });
    }
  }

  /**
   * Buffers text chunks and emits aggregated message_chunk events.
   * Reduces webhook volume by aggregating text output over 50ms windows.
   */
  private bufferTextChunk(text: string): void {
    this.textBuffer += text;

    if (!this.textFlushTimeout) {
      this.textFlushTimeout = setTimeout(() => {
        this.textFlushTimeout = null;
        this.flushTextBuffer();
      }, this.textFlushIntervalMs);
    }
  }

  /**
   * Flushes the text buffer immediately.
   * Safe to call multiple times — guarded against double-flush.
   */
  private flushTextBuffer(): void {
    if (this.textFlushTimeout) {
      clearTimeout(this.textFlushTimeout);
      this.textFlushTimeout = null;
    }

    if (this.textBuffer) {
      const text = this.textBuffer;
      this.textBuffer = '';
      this.emitEvent({ type: 'message_chunk', content: text });
    }
  }

  /**
   * Tracks a tool call name for later correlation with tool results.
   * Entries auto-expire after 10 minutes to prevent unbounded growth.
   */
  private trackToolCall(toolCallId: string, toolName: string): void {
    this.toolCallNames.set(toolCallId, toolName);

    const timer = setTimeout(() => {
      this.toolCallNames.delete(toolCallId);
      this.toolCallTimers.delete(toolCallId);
    }, Session.TOOL_CALL_TTL_MS);
    timer.unref();
    this.toolCallTimers.set(toolCallId, timer);
  }

  /**
   * Gets the tool name for a tool call ID and cleans up the tracking entry.
   */
  private getToolName(toolCallId: string): string {
    const name = this.toolCallNames.get(toolCallId) ?? 'unknown';
    this.toolCallNames.delete(toolCallId);
    const timer = this.toolCallTimers.get(toolCallId);
    if (timer) {
      clearTimeout(timer);
      this.toolCallTimers.delete(toolCallId);
    }
    return name;
  }

  /**
   * Sends a prompt to the session
   */
  async sendPrompt(prompt: string): Promise<void> {
    this.status = 'active';
    this.lastActivityAt = new Date();
    this.cancelled = false;
    this.input.push(createUserMessage(prompt, this.id));
  }

  /**
   * Sends a slash command
   */
  async sendSlashCommand(command: string, args?: string): Promise<void> {
    this.status = 'active';
    this.lastActivityAt = new Date();
    this.cancelled = false;

    if (command === 'plan') {
      this.inPlanMode = true;
      this.emitEvent({ type: 'plan_mode_change', inPlanMode: true });
    }

    this.input.push(createSlashCommandMessage(command, args, this.id));
  }

  /**
   * Cancels the current prompt
   */
  async cancel(): Promise<void> {
    this.cancelled = true;
    await this.query.interrupt();
    this.status = 'idle';
    this.emitEvent({ type: 'session_ended', reason: 'cancelled' });
  }

  /**
   * Terminates the session and releases all resources.
   */
  async terminate(): Promise<void> {
    this.cancelled = true;
    this.status = 'terminated';

    // Flush any pending text buffer
    this.flushTextBuffer();

    // Clear tool call tracking
    for (const timer of this.toolCallTimers.values()) {
      clearTimeout(timer);
    }
    this.toolCallNames.clear();
    this.toolCallTimers.clear();

    this.input.end();
    if (this.messageLoop) {
      await this.messageLoop.catch(() => {});
    }
  }

  /**
   * Sets the permission mode
   */
  async setPermissionMode(mode: PermissionMode): Promise<void> {
    this.permissionMode = mode;

    if (this.inPlanMode && mode !== 'plan') {
      this.inPlanMode = false;
      this.emitEvent({ type: 'plan_mode_change', inPlanMode: false });
    }

    await this.query.setPermissionMode(mode);
  }

  /**
   * Gets session info
   */
  getInfo(): {
    id: string;
    status: SessionStatus;
    permissionMode: PermissionMode;
    cwd: string;
    createdAt: string;
    lastActivityAt: string;
    inPlanMode: boolean;
  } {
    return {
      id: this.id,
      status: this.status,
      permissionMode: this.permissionMode,
      cwd: this.cwd,
      createdAt: this.createdAt.toISOString(),
      lastActivityAt: this.lastActivityAt.toISOString(),
      inPlanMode: this.inPlanMode,
    };
  }
}
