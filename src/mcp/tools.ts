import { z } from 'zod';

// ─── MCP Server Config Schemas ───────────────────────────────────────────────

export const mcpServerStdioConfigSchema = z.object({
  type: z.literal('stdio'),
  command: z.string().describe('Command to run'),
  args: z.array(z.string()).optional().describe('Command arguments'),
  env: z.record(z.string(), z.string()).optional().describe('Environment variables'),
});

export const mcpServerSseConfigSchema = z.object({
  type: z.literal('sse'),
  url: z.string().url().describe('SSE endpoint URL'),
  headers: z.record(z.string(), z.string()).optional().describe('HTTP headers'),
});

export const mcpServerHttpConfigSchema = z.object({
  type: z.literal('http'),
  url: z.string().url().describe('HTTP endpoint URL'),
  headers: z.record(z.string(), z.string()).optional().describe('HTTP headers'),
});

export const mcpServerConfigSchema = z.discriminatedUnion('type', [
  mcpServerStdioConfigSchema,
  mcpServerSseConfigSchema,
  mcpServerHttpConfigSchema,
]);

// ─── Session Lifecycle ───────────────────────────────────────────────────────

export const startSessionSchema = z.object({
  cwd: z.string().describe('Working directory for the session'),
  mcpServers: z
    .array(mcpServerConfigSchema)
    .optional()
    .describe('MCP servers to connect. Must be provided at creation time — cannot be added later.'),
  permissionMode: z
    .enum(['bypassPermissions', 'plan'])
    .optional()
    .default('bypassPermissions')
    .describe(
      'Initial permission mode: bypassPermissions (default, auto-approves all tools) or plan (planning only, no execution)'
    ),
});
export type StartSessionInput = z.infer<typeof startSessionSchema>;

export const terminateSessionSchema = z.object({
  sessionId: z.string().describe('Session ID to terminate'),
});
export type TerminateSessionInput = z.infer<typeof terminateSessionSchema>;

export const listSessionsSchema = z.object({});
export type ListSessionsInput = z.infer<typeof listSessionsSchema>;

export const getSessionInfoSchema = z.object({
  sessionId: z.string().describe('Session ID to query'),
});
export type GetSessionInfoInput = z.infer<typeof getSessionInfoSchema>;

// ─── Interaction ─────────────────────────────────────────────────────────────

export const sendPromptSchema = z.object({
  sessionId: z
    .string()
    .describe('Session ID. Must be in idle status (not currently processing another prompt).'),
  prompt: z.string().describe('The prompt text to send'),
});
export type SendPromptInput = z.infer<typeof sendPromptSchema>;

export const sendSlashCommandSchema = z.object({
  sessionId: z.string().describe('Session ID'),
  command: z.string().describe('Slash command name without leading /. Common commands: plan, compact, clear'),
  args: z.string().optional().describe('Command arguments (appended after the command)'),
});
export type SendSlashCommandInput = z.infer<typeof sendSlashCommandSchema>;

export const cancelPromptSchema = z.object({
  sessionId: z.string().describe('Session ID with a currently running prompt to cancel'),
});
export type CancelPromptInput = z.infer<typeof cancelPromptSchema>;

export const addMcpServerSchema = z.object({
  sessionId: z.string().describe('Session ID'),
  name: z.string().describe('Display name for the MCP server'),
  config: mcpServerConfigSchema.describe('MCP server configuration (stdio, sse, or http)'),
});
export type AddMcpServerInput = z.infer<typeof addMcpServerSchema>;

// ─── Permission & Question Handling ──────────────────────────────────────────

export const answerQuestionSchema = z.object({
  sessionId: z.string().describe('Session ID that asked the question'),
  questionId: z.string().describe('The questionId from the question webhook event'),
  answer: z.string().describe('The answer text to provide'),
});
export type AnswerQuestionInput = z.infer<typeof answerQuestionSchema>;

export const respondToPermissionSchema = z.object({
  sessionId: z.string().describe('Session ID that requested permission'),
  permissionId: z.string().describe('The permissionId from the permission_request webhook event'),
  decision: z
    .enum(['allow', 'allow_always', 'deny'])
    .describe('allow: permit once, allow_always: permit this tool permanently, deny: reject'),
});
export type RespondToPermissionInput = z.infer<typeof respondToPermissionSchema>;

export const setSessionModeSchema = z.object({
  sessionId: z.string().describe('Session ID'),
  mode: z
    .enum(['bypassPermissions', 'plan'])
    .describe('bypassPermissions: auto-approve all tool use. plan: planning only, no execution.'),
});
export type SetSessionModeInput = z.infer<typeof setSessionModeSchema>;

// ─── Plan Mode ───────────────────────────────────────────────────────────────

export const enterPlanModeSchema = z.object({
  sessionId: z.string().describe('Session ID to put into plan mode'),
});
export type EnterPlanModeInput = z.infer<typeof enterPlanModeSchema>;

export const approvePlanSchema = z.object({
  sessionId: z.string().describe('Session ID currently in plan mode'),
  acceptEdits: z.boolean().optional().describe('Auto-accept file edits after approval (default: false)'),
});
export type ApprovePlanInput = z.infer<typeof approvePlanSchema>;

export const modifyPlanSchema = z.object({
  sessionId: z.string().describe('Session ID currently in plan mode'),
  feedback: z.string().describe('Feedback or modifications to request before approving the plan'),
});
export type ModifyPlanInput = z.infer<typeof modifyPlanSchema>;

// ─── Workspace Files ─────────────────────────────────────────────────────────

export const readSessionFileSchema = z.object({
  sessionId: z.string().describe('Session ID (works for both active and terminated sessions)'),
  path: z.string().describe('Relative path within the session workspace (e.g. "src/index.ts")'),
});
export type ReadSessionFileInput = z.infer<typeof readSessionFileSchema>;

export const listSessionFilesSchema = z.object({
  sessionId: z.string().describe('Session ID (works for both active and terminated sessions)'),
  path: z.string().optional().describe('Relative directory path (defaults to workspace root)'),
});
export type ListSessionFilesInput = z.infer<typeof listSessionFilesSchema>;

export const getSessionFileInfoSchema = z.object({
  sessionId: z.string().describe('Session ID (works for both active and terminated sessions)'),
  path: z.string().describe('Relative path within the session workspace'),
});
export type GetSessionFileInfoInput = z.infer<typeof getSessionFileInfoSchema>;

export const deleteWorkspaceSchema = z.object({
  sessionId: z
    .string()
    .describe('Session ID whose workspace to delete. The session must already be terminated.'),
});
export type DeleteWorkspaceInput = z.infer<typeof deleteWorkspaceSchema>;

export const listStaleWorkspacesSchema = z.object({});
export type ListStaleWorkspacesInput = z.infer<typeof listStaleWorkspacesSchema>;

// ─── Message History ─────────────────────────────────────────────────────────

export const readMessageHistorySchema = z.object({
  sessionId: z.string().describe('Session ID (must be active)'),
});
export type ReadMessageHistoryInput = z.infer<typeof readMessageHistorySchema>;

// ─── Batch Operations ────────────────────────────────────────────────────────

export const batchSendPromptsSchema = z.object({
  prompts: z
    .array(
      z.object({
        sessionId: z.string().describe('Session ID'),
        prompt: z.string().describe('The prompt text to send'),
      })
    )
    .min(1)
    .max(10)
    .describe('Array of session/prompt pairs (max 10). For larger batches, make multiple calls.'),
});
export type BatchSendPromptsInput = z.infer<typeof batchSendPromptsSchema>;

export const batchTerminateSessionsSchema = z.object({
  sessionIds: z
    .array(z.string())
    .min(1)
    .max(10)
    .describe('Array of session IDs to terminate (max 10). For larger batches, make multiple calls.'),
});
export type BatchTerminateSessionsInput = z.infer<typeof batchTerminateSessionsSchema>;

export const batchGetSessionInfoSchema = z.object({
  sessionIds: z
    .array(z.string())
    .min(1)
    .max(10)
    .describe('Array of session IDs to query (max 10). For larger batches, make multiple calls.'),
});
export type BatchGetSessionInfoInput = z.infer<typeof batchGetSessionInfoSchema>;

// ─── Tool Definitions (for MCP registration) ────────────────────────────────

export const toolDefinitions = {
  // Session lifecycle
  start_session: {
    name: 'start_session',
    description:
      'Start a new Claude Code session. Creates an isolated workspace directory and returns a session ID. ' +
      'The session starts in idle status, ready to receive prompts. ' +
      'MCP servers must be provided here — they cannot be added after creation. ' +
      'Responses arrive asynchronously via webhook events (message_chunk, tool_call, tool_result, session_ended).',
    inputSchema: startSessionSchema,
  },
  terminate_session: {
    name: 'terminate_session',
    description:
      'Terminate a Claude Code session and release its resources. ' +
      'The workspace directory is preserved for later file inspection — use delete_workspace to remove it. ' +
      'Any pending questions or permission requests for this session are automatically cancelled.',
    inputSchema: terminateSessionSchema,
  },
  list_sessions: {
    name: 'list_sessions',
    description: 'List all active Claude Code sessions with their status, permission mode, and timestamps.',
    inputSchema: listSessionsSchema,
  },
  get_session_info: {
    name: 'get_session_info',
    description:
      'Get detailed information about a specific session including status (idle/active/terminated), ' +
      'permission mode, working directory, and whether it is in plan mode.',
    inputSchema: getSessionInfoSchema,
  },

  // Interaction
  send_prompt: {
    name: 'send_prompt',
    description:
      'Send a user prompt to a Claude Code session. The session must be in idle status — ' +
      'use cancel_prompt first if a prompt is already running. ' +
      'The prompt is processed asynchronously. Responses arrive via webhook events: ' +
      'message_chunk (text output), tool_call/tool_result (tool usage), and session_ended (completion). ' +
      'Use read_message_history to poll for text output if webhooks are unavailable.',
    inputSchema: sendPromptSchema,
  },
  send_slash_command: {
    name: 'send_slash_command',
    description:
      'Send a slash command to a session. Commands include: ' +
      '/plan (enter plan mode), /compact (compress context), /clear (reset conversation). ' +
      'Provide the command name without the leading slash.',
    inputSchema: sendSlashCommandSchema,
  },
  cancel_prompt: {
    name: 'cancel_prompt',
    description:
      'Cancel the currently running prompt in a session. The session returns to idle status. ' +
      'Use this before sending a new prompt if the session is in active status.',
    inputSchema: cancelPromptSchema,
  },
  add_mcp_server: {
    name: 'add_mcp_server',
    description:
      'Record an MCP server configuration for a session. ' +
      'Note: MCP servers can only be configured at session creation time via start_session. ' +
      'Calling this on a running session has no effect — terminate and recreate the session instead.',
    inputSchema: addMcpServerSchema,
  },

  // Permission & question handling
  answer_question: {
    name: 'answer_question',
    description:
      'Answer a question that Claude Code asked via AskUserQuestion. ' +
      'You must have received a "question" webhook event with a questionId to use this tool. ' +
      'The session is blocked until you answer. Questions time out after 5 minutes.',
    inputSchema: answerQuestionSchema,
  },
  respond_to_permission: {
    name: 'respond_to_permission',
    description:
      'Respond to a permission request from Claude Code. ' +
      'You must have received a "permission_request" webhook event with a permissionId. ' +
      'The session is blocked until you respond. Permission requests time out after 5 minutes. ' +
      'Decisions: allow (once), allow_always (permanently for this tool), deny (reject).',
    inputSchema: respondToPermissionSchema,
  },
  set_session_mode: {
    name: 'set_session_mode',
    description:
      'Change the permission mode of a session. ' +
      'bypassPermissions: auto-approve all tool use (no permission_request events). ' +
      'plan: enter planning mode where tools are not executed.',
    inputSchema: setSessionModeSchema,
  },

  // Plan mode
  enter_plan_mode: {
    name: 'enter_plan_mode',
    description:
      'Put a session into plan mode by sending the /plan slash command. ' +
      'In plan mode, Claude Code will propose a plan without executing any tools. ' +
      'Use modify_plan to give feedback, then approve_plan to begin execution.',
    inputSchema: enterPlanModeSchema,
  },
  approve_plan: {
    name: 'approve_plan',
    description:
      'Approve the current plan and exit plan mode. ' +
      'The session switches to bypassPermissions mode and begins executing the approved plan.',
    inputSchema: approvePlanSchema,
  },
  modify_plan: {
    name: 'modify_plan',
    description:
      'Send feedback to modify the plan while the session is in plan mode. ' +
      'The session must be in plan mode (check via get_session_info). ' +
      'Claude Code will revise the plan based on your feedback.',
    inputSchema: modifyPlanSchema,
  },

  // Workspace files
  read_session_file: {
    name: 'read_session_file',
    description:
      'Read the contents of a file from a session workspace. ' +
      'Works for both active and terminated sessions as long as the workspace has not been deleted.',
    inputSchema: readSessionFileSchema,
  },
  list_session_files: {
    name: 'list_session_files',
    description:
      'List files and directories in a session workspace. ' +
      'Works for both active and terminated sessions. Directories are suffixed with /.',
    inputSchema: listSessionFilesSchema,
  },
  get_session_file_info: {
    name: 'get_session_file_info',
    description: 'Get metadata (size, modified time, is directory) about a file in a session workspace.',
    inputSchema: getSessionFileInfoSchema,
  },
  delete_workspace: {
    name: 'delete_workspace',
    description:
      'Permanently delete the workspace directory for a terminated session. ' +
      'The session must already be terminated — use terminate_session first. ' +
      'This action is irreversible.',
    inputSchema: deleteWorkspaceSchema,
  },
  list_stale_workspaces: {
    name: 'list_stale_workspaces',
    description:
      'List workspace directories not associated with any active session. ' +
      'These are leftover from terminated sessions. Use delete_workspace to clean them up.',
    inputSchema: listStaleWorkspacesSchema,
  },

  // Message history
  read_message_history: {
    name: 'read_message_history',
    description:
      'Consume and clear cached message chunks for a session. ' +
      'Returns all text output since the last call. Use this to poll for session output. ' +
      'Note: this clears the cache — each chunk is returned only once.',
    inputSchema: readMessageHistorySchema,
  },

  // Batch operations
  batch_send_prompts: {
    name: 'batch_send_prompts',
    description:
      'Send prompts to multiple sessions in parallel (max 10 per call). ' +
      'Returns per-session results. Failed sends do not affect other sessions in the batch.',
    inputSchema: batchSendPromptsSchema,
  },
  batch_terminate_sessions: {
    name: 'batch_terminate_sessions',
    description:
      'Terminate multiple sessions in parallel (max 10 per call). ' +
      'Returns per-session results. Failed terminations do not affect other sessions.',
    inputSchema: batchTerminateSessionsSchema,
  },
  batch_get_session_info: {
    name: 'batch_get_session_info',
    description:
      'Get info about multiple sessions in parallel (max 10 per call). ' +
      'Returns per-session results including not-found errors for missing sessions.',
    inputSchema: batchGetSessionInfoSchema,
  },
} as const;

export type ToolName = keyof typeof toolDefinitions;
