import type { SessionManager } from '../claude/session-manager.js';
import { isAppError } from '../core/errors.js';
import type { Logger } from '../core/logger.js';
import type {
  AddMcpServerInput,
  AnswerQuestionInput,
  ApprovePlanInput,
  BatchGetSessionInfoInput,
  BatchSendPromptsInput,
  BatchTerminateSessionsInput,
  CancelPromptInput,
  DeleteWorkspaceInput,
  EnterPlanModeInput,
  GetSessionFileInfoInput,
  GetSessionInfoInput,
  ListSessionFilesInput,
  ListSessionsInput,
  ListStaleWorkspacesInput,
  ModifyPlanInput,
  ReadMessageHistoryInput,
  ReadSessionFileInput,
  RespondToPermissionInput,
  SendPromptInput,
  SendSlashCommandInput,
  SetSessionModeInput,
  StartSessionInput,
  TerminateSessionInput,
} from './tools.js';

/**
 * Standard MCP tool result shape.
 */
export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

/**
 * Creates a success result with a human-readable summary alongside structured data.
 */
function ok(summary: string, data: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify({ summary, ...data }) }],
  };
}

/**
 * Creates an error result with the MCP isError flag.
 */
function err(code: string, message: string, details?: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: code, message, ...details }) }],
    isError: true,
  };
}

/**
 * Wraps a handler function with standard error handling, logging, and MCP error formatting.
 */
function wrapHandler<T>(
  name: string,
  logger: Logger,
  fn: (input: T) => Promise<ToolResult>
): (input: T) => Promise<ToolResult> {
  return async (input: T): Promise<ToolResult> => {
    try {
      return await fn(input);
    } catch (error) {
      if (isAppError(error)) {
        logger.warn({ err: error, tool: name, ...error.details }, error.message);
        return err(error.code, error.message, error.details);
      }
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error({ err: error, tool: name }, `Unhandled error in ${name}`);
      return err('INTERNAL_ERROR', message);
    }
  };
}

/**
 * Creates all MCP tool handlers bound to a SessionManager.
 */
export function createToolHandlers(sessionManager: SessionManager, logger: Logger) {
  return {
    start_session: wrapHandler<StartSessionInput>('start_session', logger, async (input) => {
      const sessionId = await sessionManager.createSession({
        cwd: input.cwd,
        mcpServers: input.mcpServers,
        permissionMode: input.permissionMode,
      });
      logger.info({ sessionId, cwd: input.cwd }, 'Session started');
      return ok(`Session ${sessionId} started in ${input.cwd}`, {
        sessionId,
        status: 'started',
        cwd: input.cwd,
      });
    }),

    send_prompt: wrapHandler<SendPromptInput>('send_prompt', logger, async (input) => {
      await sessionManager.sendPrompt(input.sessionId, input.prompt);
      logger.info({ sessionId: input.sessionId }, 'Prompt sent');
      return ok(`Prompt sent to session ${input.sessionId}. Responses arrive via webhooks.`, {
        status: 'prompt_sent',
        sessionId: input.sessionId,
      });
    }),

    send_slash_command: wrapHandler<SendSlashCommandInput>('send_slash_command', logger, async (input) => {
      await sessionManager.sendSlashCommand(input.sessionId, input.command, input.args);
      const cmdText = input.args ? `/${input.command} ${input.args}` : `/${input.command}`;
      logger.info({ sessionId: input.sessionId, command: cmdText }, 'Slash command sent');
      return ok(`Sent ${cmdText} to session ${input.sessionId}`, {
        status: 'command_sent',
        sessionId: input.sessionId,
        command: cmdText,
      });
    }),

    add_mcp_server: wrapHandler<AddMcpServerInput>('add_mcp_server', logger, async (input) => {
      await sessionManager.addMcpServer(input.sessionId, input.config);
      return ok(`MCP server "${input.name}" noted for session ${input.sessionId}`, {
        status: 'mcp_server_added',
        sessionId: input.sessionId,
        name: input.name,
      });
    }),

    list_sessions: wrapHandler<ListSessionsInput>('list_sessions', logger, async () => {
      const sessions = sessionManager.listSessions();
      return ok(`${sessions.length} active session(s)`, { sessions });
    }),

    get_session_info: wrapHandler<GetSessionInfoInput>('get_session_info', logger, async (input) => {
      const info = sessionManager.getSessionInfo(input.sessionId);
      if (!info) {
        return err('SESSION_NOT_FOUND', `Session not found: ${input.sessionId}`, {
          sessionId: input.sessionId,
        });
      }
      return ok(`Session ${input.sessionId} is ${info.status}`, { session: info });
    }),

    cancel_prompt: wrapHandler<CancelPromptInput>('cancel_prompt', logger, async (input) => {
      await sessionManager.cancelPrompt(input.sessionId);
      logger.info({ sessionId: input.sessionId }, 'Prompt cancelled');
      return ok(`Cancelled running prompt in session ${input.sessionId}`, {
        status: 'cancelled',
        sessionId: input.sessionId,
      });
    }),

    terminate_session: wrapHandler<TerminateSessionInput>('terminate_session', logger, async (input) => {
      await sessionManager.terminateSession(input.sessionId);
      logger.info({ sessionId: input.sessionId }, 'Session terminated');
      return ok(`Session ${input.sessionId} terminated`, {
        status: 'terminated',
        sessionId: input.sessionId,
      });
    }),

    answer_question: wrapHandler<AnswerQuestionInput>('answer_question', logger, async (input) => {
      sessionManager.answerQuestion(input.questionId, input.answer);
      logger.info({ sessionId: input.sessionId, questionId: input.questionId }, 'Question answered');
      return ok(`Answered question ${input.questionId} for session ${input.sessionId}`, {
        status: 'answered',
        sessionId: input.sessionId,
        questionId: input.questionId,
      });
    }),

    respond_to_permission: wrapHandler<RespondToPermissionInput>(
      'respond_to_permission',
      logger,
      async (input) => {
        sessionManager.respondToPermission(input.permissionId, input.decision);
        logger.info(
          { sessionId: input.sessionId, permissionId: input.permissionId, decision: input.decision },
          'Permission responded'
        );
        return ok(
          `Responded "${input.decision}" to permission ${input.permissionId} for session ${input.sessionId}`,
          {
            status: 'responded',
            sessionId: input.sessionId,
            permissionId: input.permissionId,
            decision: input.decision,
          }
        );
      }
    ),

    enter_plan_mode: wrapHandler<EnterPlanModeInput>('enter_plan_mode', logger, async (input) => {
      await sessionManager.enterPlanMode(input.sessionId);
      logger.info({ sessionId: input.sessionId }, 'Entered plan mode');
      return ok(`Session ${input.sessionId} entered plan mode`, {
        status: 'plan_mode_entered',
        sessionId: input.sessionId,
      });
    }),

    approve_plan: wrapHandler<ApprovePlanInput>('approve_plan', logger, async (input) => {
      await sessionManager.approvePlan(input.sessionId, input.acceptEdits);
      logger.info({ sessionId: input.sessionId }, 'Plan approved');
      return ok(`Plan approved for session ${input.sessionId}. Execution begins in bypassPermissions mode.`, {
        status: 'plan_approved',
        sessionId: input.sessionId,
      });
    }),

    modify_plan: wrapHandler<ModifyPlanInput>('modify_plan', logger, async (input) => {
      await sessionManager.modifyPlan(input.sessionId, input.feedback);
      logger.info({ sessionId: input.sessionId }, 'Plan feedback sent');
      return ok(`Plan feedback sent to session ${input.sessionId}`, {
        status: 'feedback_sent',
        sessionId: input.sessionId,
      });
    }),

    set_session_mode: wrapHandler<SetSessionModeInput>('set_session_mode', logger, async (input) => {
      await sessionManager.setSessionMode(
        input.sessionId,
        input.mode as import('../claude/types.js').PermissionMode
      );
      logger.info({ sessionId: input.sessionId, mode: input.mode }, 'Session mode set');
      return ok(`Session ${input.sessionId} mode changed to ${input.mode}`, {
        status: 'mode_set',
        sessionId: input.sessionId,
        mode: input.mode,
      });
    }),

    read_session_file: wrapHandler<ReadSessionFileInput>('read_session_file', logger, async (input) => {
      const content = await sessionManager.readSessionFile(input.sessionId, input.path);
      return ok(`Read ${input.path} from session ${input.sessionId}`, {
        path: input.path,
        content,
      });
    }),

    list_session_files: wrapHandler<ListSessionFilesInput>('list_session_files', logger, async (input) => {
      const files = await sessionManager.listSessionFiles(input.sessionId, input.path);
      return ok(`${files.length} entries in ${input.path ?? '/'}`, {
        path: input.path ?? '/',
        files,
      });
    }),

    get_session_file_info: wrapHandler<GetSessionFileInfoInput>(
      'get_session_file_info',
      logger,
      async (input) => {
        const info = await sessionManager.getSessionFileInfo(input.sessionId, input.path);
        return ok(`File info for ${input.path}`, info);
      }
    ),

    batch_send_prompts: wrapHandler<BatchSendPromptsInput>('batch_send_prompts', logger, async (input) => {
      const results = await Promise.all(
        input.prompts.map(async ({ sessionId, prompt }) => {
          try {
            await sessionManager.sendPrompt(sessionId, prompt);
            return { sessionId, status: 'prompt_sent' as const };
          } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown error';
            return { sessionId, status: 'error' as const, error: message };
          }
        })
      );
      const successful = results.filter((r) => r.status === 'prompt_sent').length;
      const failed = results.filter((r) => r.status === 'error').length;
      logger.info({ successful, failed, total: input.prompts.length }, 'Batch send prompts completed');
      return ok(`Sent ${successful}/${input.prompts.length} prompts (${failed} failed)`, {
        results,
        summary: { successful, failed, total: input.prompts.length },
      });
    }),

    batch_terminate_sessions: wrapHandler<BatchTerminateSessionsInput>(
      'batch_terminate_sessions',
      logger,
      async (input) => {
        const results = await Promise.all(
          input.sessionIds.map(async (sessionId) => {
            try {
              await sessionManager.terminateSession(sessionId);
              return { sessionId, status: 'terminated' as const };
            } catch (error) {
              const message = error instanceof Error ? error.message : 'Unknown error';
              return { sessionId, status: 'error' as const, error: message };
            }
          })
        );
        const successful = results.filter((r) => r.status === 'terminated').length;
        const failed = results.filter((r) => r.status === 'error').length;
        logger.info(
          { successful, failed, total: input.sessionIds.length },
          'Batch terminate sessions completed'
        );
        return ok(`Terminated ${successful}/${input.sessionIds.length} sessions (${failed} failed)`, {
          results,
          summary: { successful, failed, total: input.sessionIds.length },
        });
      }
    ),

    batch_get_session_info: wrapHandler<BatchGetSessionInfoInput>(
      'batch_get_session_info',
      logger,
      async (input) => {
        const results = input.sessionIds.map((sessionId) => {
          const info = sessionManager.getSessionInfo(sessionId);
          if (!info) {
            return { sessionId, status: 'not_found' as const, error: 'Session not found' };
          }
          return { sessionId, status: 'success' as const, info };
        });
        const found = results.filter((r) => r.status === 'success').length;
        const notFound = results.filter((r) => r.status === 'not_found').length;
        return ok(`Found ${found}/${input.sessionIds.length} sessions (${notFound} not found)`, {
          results,
          summary: { found, notFound, total: input.sessionIds.length },
        });
      }
    ),

    read_message_history: wrapHandler<ReadMessageHistoryInput>(
      'read_message_history',
      logger,
      async (input) => {
        const chunks = sessionManager.readMessageHistory(input.sessionId);
        return ok(`${chunks.length} message chunk(s) consumed from session ${input.sessionId}`, {
          sessionId: input.sessionId,
          chunks,
          count: chunks.length,
        });
      }
    ),

    delete_workspace: wrapHandler<DeleteWorkspaceInput>('delete_workspace', logger, async (input) => {
      await sessionManager.deleteWorkspace(input.sessionId);
      logger.info({ sessionId: input.sessionId }, 'Workspace deleted');
      return ok(`Workspace deleted for session ${input.sessionId}`, {
        status: 'deleted',
        sessionId: input.sessionId,
      });
    }),

    list_stale_workspaces: wrapHandler<ListStaleWorkspacesInput>(
      'list_stale_workspaces',
      logger,
      async () => {
        const workspaces = await sessionManager.listStaleWorkspaces();
        return ok(`${workspaces.length} stale workspace(s) found`, {
          workspaces,
          count: workspaces.length,
        });
      }
    ),
  };
}

export type ToolHandlers = ReturnType<typeof createToolHandlers>;
