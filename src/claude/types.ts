import type { Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

/**
 * Permission modes for Claude Code sessions
 * Only bypassPermissions and plan modes are available
 */
export type PermissionMode =
  // | 'default' // Standard behavior, prompts for dangerous operations
  // | 'acceptEdits' // Auto-accept file edit operations
  | 'bypassPermissions' // Bypass all permission checks (default)
  | 'plan'; // Planning mode, no actual tool execution
// | 'dontAsk'; // Don't prompt for permissions, deny if not pre-approved

/**
 * Session status
 */
export type SessionStatus = 'active' | 'idle' | 'terminated';

/**
 * MCP Server configuration for stdio transport
 */
export interface McpServerStdioConfig {
  type: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/**
 * MCP Server configuration for SSE transport
 */
export interface McpServerSseConfig {
  type: 'sse';
  url: string;
  headers?: Record<string, string>;
}

/**
 * MCP Server configuration for HTTP transport
 */
export interface McpServerHttpConfig {
  type: 'http';
  url: string;
  headers?: Record<string, string>;
}

/**
 * Union of all MCP server configurations
 */
export type McpServerConfig = McpServerStdioConfig | McpServerSseConfig | McpServerHttpConfig;

/**
 * Pushable stream interface for sending messages to Claude
 */
export interface Pushable<T> {
  push(value: T): void;
  end(): void;
}

/**
 * Represents an active Claude Code session
 */
export interface ClaudeSession {
  id: string;
  query: Query;
  input: Pushable<SDKUserMessage>;
  status: SessionStatus;
  permissionMode: PermissionMode;
  cwd: string;
  mcpServers: McpServerConfig[];
  createdAt: Date;
  lastActivityAt: Date;
  inPlanMode: boolean;
}

/**
 * Session info for listing
 */
export interface SessionInfo {
  id: string;
  status: SessionStatus;
  permissionMode: PermissionMode;
  cwd: string;
  createdAt: string;
  lastActivityAt: string;
  inPlanMode: boolean;
}

/**
 * Options for creating a new session
 */
export interface CreateSessionOptions {
  cwd: string;
  mcpServers?: McpServerConfig[];
  permissionMode?: PermissionMode;
}

/**
 * Pending question from AskUserQuestion
 */
export interface PendingQuestion {
  questionId: string;
  sessionId: string;
  question: string;
  options: Array<{
    label: string;
    description: string;
  }>;
  multiSelect: boolean;
  resolve: (answer: string) => void;
  reject: (error: Error) => void;
  timeoutId: NodeJS.Timeout;
}

/**
 * Pending permission request
 */
export interface PendingPermission {
  permissionId: string;
  sessionId: string;
  toolName: string;
  toolInput: unknown;
  options: Array<{
    id: string;
    label: string;
    kind: 'allow_once' | 'allow_always' | 'reject_once';
  }>;
  resolve: (decision: 'allow' | 'allow_always' | 'deny') => void;
  reject: (error: Error) => void;
  timeoutId: NodeJS.Timeout;
}

/**
 * Event emitted when session state changes
 */
export type SessionEvent =
  | { type: 'message_chunk'; content: string }
  | { type: 'thinking'; content: string }
  | { type: 'tool_call'; toolCallId: string; toolName: string; toolInput: unknown }
  | { type: 'tool_result'; toolCallId: string; toolName: string; result: unknown; isError: boolean }
  | { type: 'plan_update'; entries: Array<{ content: string; status: string }> }
  | { type: 'plan_mode_change'; inPlanMode: boolean }
  | {
      type: 'question';
      questionId: string;
      question: string;
      options: Array<{ label: string; description: string }>;
      multiSelect: boolean;
    }
  | {
      type: 'permission_request';
      permissionId: string;
      toolName: string;
      toolInput: unknown;
      options: Array<{ id: string; label: string }>;
    }
  | { type: 'session_ended'; reason: 'completed' | 'cancelled' | 'error' }
  | { type: 'error'; message: string };
