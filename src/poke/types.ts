export interface PokeConfig {
  bearerToken: string;
  apiBaseUrl: string;
  webhookEndpoint: string;
  batchIntervalMs: number;
}

/**
 * Poke webhook request payload
 * This is the exact format Poke expects for inbound webhooks
 * See: Poke API docs for /api/v1/inbound-sms/webhook
 */
export interface PokeWebhookRequest {
  message: string;
}

/**
 * All webhook event types
 */
export type WebhookPayloadType =
  | 'message_chunk' // Text output from Claude
  | 'thinking' // Thinking/reasoning output
  | 'tool_call' // Tool being invoked
  | 'tool_result' // Tool execution result
  | 'plan_update' // Plan entries updated (TodoWrite)
  | 'plan_mode_change' // Entered/exited plan mode
  | 'question' // Claude asked a question (AskUserQuestion)
  | 'permission_request' // Claude needs permission for a tool
  | 'session_ended' // Session completed or terminated
  | 'error'; // Error occurred

/**
 * Base webhook payload
 */
export interface WebhookPayloadBase {
  sessionId: string;
  type: WebhookPayloadType;
  timestamp: string;
}

/**
 * Message chunk payload
 */
export interface MessageChunkPayload extends WebhookPayloadBase {
  type: 'message_chunk';
  content: string;
}

/**
 * Thinking payload
 */
export interface ThinkingPayload extends WebhookPayloadBase {
  type: 'thinking';
  content: string;
}

/**
 * Tool call payload
 */
export interface ToolCallPayload extends WebhookPayloadBase {
  type: 'tool_call';
  toolCallId: string;
  toolName: string;
  toolInput: unknown;
}

/**
 * Tool result payload
 */
export interface ToolResultPayload extends WebhookPayloadBase {
  type: 'tool_result';
  toolCallId: string;
  toolName: string;
  result: unknown;
  isError: boolean;
}

/**
 * Plan update payload
 */
export interface PlanUpdatePayload extends WebhookPayloadBase {
  type: 'plan_update';
  entries: Array<{
    content: string;
    status: string;
  }>;
}

/**
 * Plan mode change payload
 */
export interface PlanModeChangePayload extends WebhookPayloadBase {
  type: 'plan_mode_change';
  inPlanMode: boolean;
}

/**
 * Question payload (from AskUserQuestion)
 */
export interface QuestionPayload extends WebhookPayloadBase {
  type: 'question';
  questionId: string;
  question: string;
  options: Array<{
    label: string;
    description: string;
  }>;
  multiSelect: boolean;
}

/**
 * Permission request payload
 */
export interface PermissionRequestPayload extends WebhookPayloadBase {
  type: 'permission_request';
  permissionId: string;
  toolName: string;
  toolInput: unknown;
  options: Array<{
    id: string;
    label: string;
  }>;
}

/**
 * Session ended payload
 */
export interface SessionEndedPayload extends WebhookPayloadBase {
  type: 'session_ended';
  reason: 'completed' | 'cancelled' | 'error';
}

/**
 * Error payload
 */
export interface ErrorPayload extends WebhookPayloadBase {
  type: 'error';
  message: string;
}

/**
 * Union of all webhook payloads
 */
export type WebhookPayload =
  | MessageChunkPayload
  | ThinkingPayload
  | ToolCallPayload
  | ToolResultPayload
  | PlanUpdatePayload
  | PlanModeChangePayload
  | QuestionPayload
  | PermissionRequestPayload
  | SessionEndedPayload
  | ErrorPayload;

/**
 * Internal batched webhook request (before formatting for Poke)
 */
export interface BatchedWebhookRequest {
  updates: WebhookPayload[];
}

/**
 * Re-export PokeWebhookRequest for use in webhook sender
 */
export type { PokeWebhookRequest as PokeInboundMessage };
