import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  FileAccessError,
  SessionLimitError,
  SessionNotFoundError,
  SessionStateError,
  WorkspaceNotFoundError,
} from '../core/errors.js';
import type { Logger } from '../core/logger.js';
import { Session, type SessionEventCallback } from './session.js';
import type {
  CreateSessionOptions,
  McpServerConfig,
  PendingPermission,
  PendingQuestion,
  PermissionMode,
  SessionEvent,
  SessionInfo,
} from './types.js';

/**
 * Lock file content format — tracks the orchestrator PID and active session IDs
 * so orphaned sessions from a crashed process can be cleaned up on next startup.
 */
interface LockFileContent {
  pid: number;
  startedAt: string;
  sessionIds: string[];
}

/**
 * Configuration for the SessionManager
 */
export interface SessionManagerConfig {
  maxSessions: number;
  sessionTimeoutMs: number;
  bypassPermissions: boolean;
  workspacesDir: string;
  logger: Logger;
  onEvent?: SessionEventCallback;
}

/**
 * Manages multiple Claude Code sessions with isolated workspaces.
 * Handles orphan cleanup on startup and process signal handling for clean shutdown.
 */
export class SessionManager {
  private readonly sessions: Map<string, Session> = new Map();
  private readonly pendingQuestions: Map<string, PendingQuestion> = new Map();
  private readonly pendingPermissions: Map<string, PendingPermission> = new Map();
  private readonly messageChunks: Map<string, string[]> = new Map();
  private readonly config: SessionManagerConfig;
  private readonly lockFilePath: string;
  private cleanupInterval: NodeJS.Timeout | null = null;
  private shutdownPromise: Promise<void> | null = null;

  constructor(config: SessionManagerConfig) {
    this.config = config;
    this.lockFilePath = join(config.workspacesDir, '.orchestrator.lock');
    this.startCleanupInterval();
    this.setupProcessHandlers();

    // Initialize workspace dir and clean up orphans from previous crashed process
    this.initialize().catch((error) => {
      this.config.logger.error({ err: error }, 'Failed to initialize session manager');
    });
  }

  /**
   * Initializes the workspace directory, cleans up orphans, and writes a lock file.
   */
  private async initialize(): Promise<void> {
    await this.ensureWorkspacesDir();
    await this.cleanupOrphanedSessions();
    await this.writeLockFile();
  }

  /**
   * Sets up process signal handlers so that shutdown terminates all sessions.
   * Safe against duplicate signals — subsequent calls return the same promise.
   */
  private setupProcessHandlers(): void {
    const cleanup = async (signal: string) => {
      this.config.logger.info({ signal }, 'Received signal, shutting down session manager');
      await this.shutdown();
    };

    process.on('SIGINT', () => cleanup('SIGINT'));
    process.on('SIGTERM', () => cleanup('SIGTERM'));
  }

  /**
   * Ensures the workspaces directory exists
   */
  private async ensureWorkspacesDir(): Promise<void> {
    await mkdir(this.config.workspacesDir, { recursive: true });
    this.config.logger.info({ workspacesDir: this.config.workspacesDir }, 'Workspaces directory ready');
  }

  /**
   * Writes lock file with current PID and session IDs (atomic write-rename).
   */
  private async writeLockFile(): Promise<void> {
    const content: LockFileContent = {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      sessionIds: Array.from(this.sessions.keys()),
    };
    try {
      const tmpPath = `${this.lockFilePath}.tmp`;
      await writeFile(tmpPath, JSON.stringify(content, null, 2));
      await rename(tmpPath, this.lockFilePath);
    } catch (error) {
      this.config.logger.warn({ err: error }, 'Failed to write lock file');
    }
  }

  /**
   * Updates the lock file with current session IDs.
   */
  private async updateLockFile(): Promise<void> {
    await this.writeLockFile();
  }

  /**
   * Checks if a process with the given PID is running.
   */
  private isProcessRunning(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Cleans up orphaned session workspaces from a crashed orchestrator process.
   * Reads the lock file, checks if the previous PID is dead, and removes its workspaces.
   */
  private async cleanupOrphanedSessions(): Promise<void> {
    try {
      const lockContent = await readFile(this.lockFilePath, 'utf-8');
      const lockData: LockFileContent = JSON.parse(lockContent);

      if (this.isProcessRunning(lockData.pid)) {
        this.config.logger.info(
          { pid: lockData.pid },
          'Previous orchestrator still running, skipping orphan cleanup'
        );
        return;
      }

      this.config.logger.info(
        { previousPid: lockData.pid, orphanedSessions: lockData.sessionIds.length },
        'Previous orchestrator died, cleaning up orphaned sessions'
      );

      // Clean up workspace directories listed in the lock file
      for (const sessionId of lockData.sessionIds) {
        const workspacePath = join(this.config.workspacesDir, sessionId);
        try {
          await rm(workspacePath, { recursive: true, force: true });
          this.config.logger.info({ sessionId, workspacePath }, 'Cleaned up orphaned session workspace');
        } catch (error) {
          this.config.logger.warn({ err: error, sessionId }, 'Failed to cleanup orphaned workspace');
        }
      }

      // Also scan for any unlisted workspace directories (belt and suspenders)
      const entries = await readdir(this.config.workspacesDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith('.')) {
          const workspacePath = join(this.config.workspacesDir, entry.name);
          try {
            await rm(workspacePath, { recursive: true, force: true });
            this.config.logger.info({ workspacePath }, 'Cleaned up unlisted workspace directory');
          } catch (error) {
            this.config.logger.warn({ err: error, workspacePath }, 'Failed to cleanup unlisted workspace');
          }
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.config.logger.debug({ err: error }, 'No lock file found or invalid, skipping orphan cleanup');
      }
    }
  }

  /**
   * Creates a unique workspace directory for a session
   */
  private async createSessionWorkspace(sessionId: string): Promise<string> {
    const workspacePath = join(this.config.workspacesDir, sessionId);
    await mkdir(workspacePath, { recursive: true });
    this.config.logger.info({ sessionId, workspacePath }, 'Created session workspace');
    return workspacePath;
  }

  /**
   * Gets the workspace path for a session.
   * Works for both active sessions and terminated sessions whose workspace still exists on disk.
   */
  private async resolveWorkspacePath(sessionId: string): Promise<string> {
    const session = this.sessions.get(sessionId);
    if (session) return session.cwd;

    // Fall back to workspace directory for terminated sessions
    const workspacePath = join(this.config.workspacesDir, sessionId);
    try {
      await stat(workspacePath);
      return workspacePath;
    } catch {
      throw new WorkspaceNotFoundError(sessionId);
    }
  }

  /**
   * Gets the workspace path for a session (sync, active sessions only)
   */
  getSessionWorkspacePath(sessionId: string): string | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    return session.cwd;
  }

  /**
   * Requires an active session or throws SessionNotFoundError.
   */
  private requireSession(sessionId: string): Session {
    const session = this.sessions.get(sessionId);
    if (!session) throw new SessionNotFoundError(sessionId);
    return session;
  }

  /**
   * Reads a file from a session's workspace.
   * Works for both active and terminated sessions as long as the workspace exists.
   */
  async readSessionFile(sessionId: string, relativePath: string): Promise<string> {
    const workspacePath = await this.resolveWorkspacePath(sessionId);

    const fullPath = resolve(workspacePath, relativePath);
    if (!fullPath.startsWith(workspacePath)) {
      throw new FileAccessError('Access denied: Path is outside session workspace', {
        sessionId,
        path: relativePath,
      });
    }

    try {
      return await readFile(fullPath, 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new FileAccessError(`File not found: ${relativePath}`, {
          sessionId,
          path: relativePath,
        });
      }
      throw new FileAccessError(
        `Failed to read file: ${relativePath}`,
        { sessionId, path: relativePath },
        {
          cause: error as Error,
        }
      );
    }
  }

  /**
   * Lists files in a session's workspace directory.
   * Works for both active and terminated sessions as long as the workspace exists.
   */
  async listSessionFiles(sessionId: string, relativePath = ''): Promise<string[]> {
    const workspacePath = await this.resolveWorkspacePath(sessionId);

    const fullPath = resolve(workspacePath, relativePath);
    if (!fullPath.startsWith(workspacePath)) {
      throw new FileAccessError('Access denied: Path is outside session workspace', {
        sessionId,
        path: relativePath,
      });
    }

    try {
      const entries = await readdir(fullPath, { withFileTypes: true });
      const files: string[] = [];
      for (const entry of entries) {
        const entryPath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          files.push(`${entryPath}/`);
        } else {
          files.push(entryPath);
        }
      }
      return files;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new FileAccessError(`Directory not found: ${relativePath || '/'}`, {
          sessionId,
          path: relativePath,
        });
      }
      throw new FileAccessError(
        `Failed to list directory: ${relativePath || '/'}`,
        {
          sessionId,
          path: relativePath,
        },
        { cause: error as Error }
      );
    }
  }

  /**
   * Gets file info from a session's workspace.
   * Works for both active and terminated sessions as long as the workspace exists.
   */
  async getSessionFileInfo(
    sessionId: string,
    relativePath: string
  ): Promise<{ path: string; size: number; isDirectory: boolean; modifiedAt: string }> {
    const workspacePath = await this.resolveWorkspacePath(sessionId);

    const fullPath = resolve(workspacePath, relativePath);
    if (!fullPath.startsWith(workspacePath)) {
      throw new FileAccessError('Access denied: Path is outside session workspace', {
        sessionId,
        path: relativePath,
      });
    }

    try {
      const stats = await stat(fullPath);
      return {
        path: relativePath,
        size: stats.size,
        isDirectory: stats.isDirectory(),
        modifiedAt: stats.mtime.toISOString(),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new FileAccessError(`File not found: ${relativePath}`, {
          sessionId,
          path: relativePath,
        });
      }
      throw new FileAccessError(
        `Failed to stat file: ${relativePath}`,
        {
          sessionId,
          path: relativePath,
        },
        { cause: error as Error }
      );
    }
  }

  /**
   * Deletes a workspace directory by session ID.
   * Only works for terminated sessions.
   */
  async deleteWorkspace(sessionId: string): Promise<void> {
    if (this.sessions.has(sessionId)) {
      throw new SessionStateError(
        `Cannot delete workspace for active session: ${sessionId}. Terminate it first.`,
        { sessionId }
      );
    }

    const workspacePath = join(this.config.workspacesDir, sessionId);
    try {
      await stat(workspacePath);
    } catch {
      throw new WorkspaceNotFoundError(sessionId);
    }

    await rm(workspacePath, { recursive: true, force: true });
    this.config.logger.info({ sessionId, workspacePath }, 'Deleted session workspace');
  }

  /**
   * Lists workspace directories that are not associated with any active session.
   */
  async listStaleWorkspaces(): Promise<
    Array<{ sessionId: string; path: string; modifiedAt: string; sizeEntries: number }>
  > {
    const entries = await readdir(this.config.workspacesDir, { withFileTypes: true });
    const staleWorkspaces: Array<{
      sessionId: string;
      path: string;
      modifiedAt: string;
      sizeEntries: number;
    }> = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.')) continue;
      if (this.sessions.has(entry.name)) continue;

      const workspacePath = join(this.config.workspacesDir, entry.name);
      try {
        const stats = await stat(workspacePath);
        const contents = await readdir(workspacePath);
        staleWorkspaces.push({
          sessionId: entry.name,
          path: workspacePath,
          modifiedAt: stats.mtime.toISOString(),
          sizeEntries: contents.length,
        });
      } catch {
        // Skip entries we can't stat
      }
    }

    return staleWorkspaces;
  }

  /**
   * Starts the cleanup interval for stale sessions
   */
  private startCleanupInterval(): void {
    this.cleanupInterval = setInterval(() => {
      this.cleanupStaleSessions();
    }, 60000);
  }

  /**
   * Cleans up sessions that have been idle beyond the timeout.
   * Each termination is wrapped in a timeout to prevent hung cleanup.
   */
  private cleanupStaleSessions(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      const idleTime = now - session.lastActivityAt.getTime();
      if (idleTime > this.config.sessionTimeoutMs && session.status === 'idle') {
        this.config.logger.info({ sessionId: id, idleTimeMs: idleTime }, 'Cleaning up stale session');
        Promise.race([
          this.terminateSession(id),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Stale session termination timed out')), 10_000)
          ),
        ]).catch((error) => {
          this.config.logger.error({ err: error, sessionId: id }, 'Error terminating stale session');
        });
      }
    }
  }

  /**
   * Handles session events and forwards to webhook callback.
   */
  private handleSessionEvent(sessionId: string, event: SessionEvent): void {
    // Cache message chunks for later retrieval via read_message_history
    if (event.type === 'message_chunk') {
      let chunks = this.messageChunks.get(sessionId);
      if (!chunks) {
        chunks = [];
        this.messageChunks.set(sessionId, chunks);
      }
      chunks.push(event.content);
    }

    // Handle questions — assign an ID and track for later answer
    if (event.type === 'question') {
      const questionId = randomUUID();
      let completed = false;

      const timeoutId = setTimeout(() => {
        if (completed) return;
        completed = true;
        const pending = this.pendingQuestions.get(questionId);
        if (pending) {
          pending.reject(new Error('Question timeout'));
          this.pendingQuestions.delete(questionId);
        }
      }, 300_000); // 5 minute timeout

      this.pendingQuestions.set(questionId, {
        questionId,
        sessionId,
        question: event.question,
        options: event.options,
        multiSelect: event.multiSelect,
        resolve: (answer: string) => {
          if (completed) return;
          completed = true;
          clearTimeout(timeoutId);
          // actual resolve logic handled by caller
          void answer;
        },
        reject: () => {},
        timeoutId,
      });

      if (this.config.onEvent) {
        this.config.onEvent(sessionId, { ...event, questionId });
      }
      return;
    }

    // Handle permission requests
    if (event.type === 'permission_request') {
      const permissionId = randomUUID();
      let completed = false;

      const timeoutId = setTimeout(() => {
        if (completed) return;
        completed = true;
        const pending = this.pendingPermissions.get(permissionId);
        if (pending) {
          pending.reject(new Error('Permission request timeout'));
          this.pendingPermissions.delete(permissionId);
        }
      }, 300_000);

      this.pendingPermissions.set(permissionId, {
        permissionId,
        sessionId,
        toolName: event.toolName,
        toolInput: event.toolInput,
        options: event.options.map((opt) => ({
          id: opt.id,
          label: opt.label,
          kind: 'allow_once' as const,
        })),
        resolve: (decision: string) => {
          if (completed) return;
          completed = true;
          clearTimeout(timeoutId);
          void decision;
        },
        reject: () => {},
        timeoutId,
      });

      if (this.config.onEvent) {
        this.config.onEvent(sessionId, { ...event, permissionId });
      }
      return;
    }

    // Forward other events
    if (this.config.onEvent) {
      this.config.onEvent(sessionId, event);
    }
  }

  /**
   * Creates a new Claude Code session with a unique workspace directory.
   */
  async createSession(options: CreateSessionOptions): Promise<string> {
    if (this.sessions.size >= this.config.maxSessions) {
      throw new SessionLimitError(this.config.maxSessions);
    }

    const sessionId = randomUUID();
    const workspacePath = await this.createSessionWorkspace(sessionId);

    const session = new Session({
      ...options,
      id: sessionId,
      cwd: workspacePath,
      bypassPermissions: this.config.bypassPermissions,
      logger: this.config.logger,
      onEvent: (id, event) => this.handleSessionEvent(id, event),
    });

    this.sessions.set(session.id, session);
    await this.updateLockFile();
    this.config.logger.info(
      { sessionId: session.id, cwd: workspacePath },
      'Created new session with workspace'
    );

    return session.id;
  }

  /**
   * Gets a session by ID
   */
  getSession(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Sends a prompt to a session
   */
  async sendPrompt(sessionId: string, prompt: string): Promise<void> {
    const session = this.requireSession(sessionId);
    await session.sendPrompt(prompt);
  }

  /**
   * Sends a slash command to a session
   */
  async sendSlashCommand(sessionId: string, command: string, args?: string): Promise<void> {
    const session = this.requireSession(sessionId);
    await session.sendSlashCommand(command, args);
  }

  /**
   * Notes that an MCP server should be attached.
   * MCP servers must be configured at session creation time.
   */
  async addMcpServer(sessionId: string, _config: McpServerConfig): Promise<void> {
    this.requireSession(sessionId);
    this.config.logger.warn({ sessionId }, 'MCP servers must be configured at session creation time');
  }

  /**
   * Cancels the current prompt in a session
   */
  async cancelPrompt(sessionId: string): Promise<void> {
    const session = this.requireSession(sessionId);
    await session.cancel();
  }

  /**
   * Terminates a session, cleans up pending questions/permissions, and preserves workspace.
   * Idempotent — terminating an already-absent session is a no-op.
   */
  async terminateSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new SessionNotFoundError(sessionId);
    }
    await session.terminate();
    this.sessions.delete(sessionId);

    // Clean up pending questions for this session
    for (const [questionId, pending] of this.pendingQuestions) {
      if (pending.sessionId === sessionId) {
        clearTimeout(pending.timeoutId);
        pending.reject(new Error('Session terminated'));
        this.pendingQuestions.delete(questionId);
      }
    }

    // Clean up pending permissions for this session
    for (const [permissionId, pending] of this.pendingPermissions) {
      if (pending.sessionId === sessionId) {
        clearTimeout(pending.timeoutId);
        pending.reject(new Error('Session terminated'));
        this.pendingPermissions.delete(permissionId);
      }
    }

    // Clear cached message chunks
    this.messageChunks.delete(sessionId);

    await this.updateLockFile();
    this.config.logger.info({ sessionId }, 'Session terminated (workspace preserved)');
  }

  /**
   * Lists all sessions
   */
  listSessions(): SessionInfo[] {
    return Array.from(this.sessions.values()).map((session) => session.getInfo());
  }

  /**
   * Gets detailed info about a session
   */
  getSessionInfo(sessionId: string): SessionInfo | undefined {
    const session = this.sessions.get(sessionId);
    return session?.getInfo();
  }

  /**
   * Answers a pending question
   */
  answerQuestion(questionId: string, answer: string): void {
    const pending = this.pendingQuestions.get(questionId);
    if (!pending) {
      throw new SessionStateError(`Question not found: ${questionId}`, { questionId });
    }
    clearTimeout(pending.timeoutId);
    pending.resolve(answer);
    this.pendingQuestions.delete(questionId);
  }

  /**
   * Responds to a permission request
   */
  respondToPermission(permissionId: string, decision: 'allow' | 'allow_always' | 'deny'): void {
    const pending = this.pendingPermissions.get(permissionId);
    if (!pending) {
      throw new SessionStateError(`Permission request not found: ${permissionId}`, { permissionId });
    }
    clearTimeout(pending.timeoutId);
    pending.resolve(decision);
    this.pendingPermissions.delete(permissionId);
  }

  /**
   * Enters plan mode for a session
   */
  async enterPlanMode(sessionId: string): Promise<void> {
    const session = this.requireSession(sessionId);
    await session.sendSlashCommand('plan');
  }

  /**
   * Approves a plan and exits plan mode.
   * Always switches to bypassPermissions mode after plan approval.
   */
  async approvePlan(sessionId: string, _acceptEdits = false): Promise<void> {
    const session = this.requireSession(sessionId);
    await session.setPermissionMode('bypassPermissions');
  }

  /**
   * Sends feedback to modify the plan
   */
  async modifyPlan(sessionId: string, feedback: string): Promise<void> {
    const session = this.requireSession(sessionId);
    if (!session.inPlanMode) {
      throw new SessionStateError('Session is not in plan mode', { sessionId });
    }
    await session.sendPrompt(feedback);
  }

  /**
   * Sets the session permission mode
   */
  async setSessionMode(sessionId: string, mode: PermissionMode): Promise<void> {
    const session = this.requireSession(sessionId);
    await session.setPermissionMode(mode);
  }

  /**
   * Returns cached message chunks for a session and clears the cache.
   * Only works for active sessions.
   */
  readMessageHistory(sessionId: string): string[] {
    if (!this.sessions.has(sessionId)) {
      throw new SessionNotFoundError(sessionId);
    }

    const chunks = this.messageChunks.get(sessionId) ?? [];
    this.messageChunks.delete(sessionId);
    return chunks;
  }

  /**
   * Shuts down the session manager: terminates all sessions, clears pending state, and removes the lock file.
   * Idempotent — multiple calls return the same promise.
   */
  async shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shutdownPromise = this.performShutdown();
    return this.shutdownPromise;
  }

  private async performShutdown(): Promise<void> {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }

    // Terminate all sessions in parallel with individual timeouts
    const terminations = Array.from(this.sessions.keys()).map((id) =>
      Promise.race([
        this.terminateSession(id),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`Shutdown termination timed out for ${id}`)), 10_000)
        ),
      ]).catch((error) => {
        this.config.logger.error({ err: error, sessionId: id }, 'Error during shutdown');
      })
    );
    await Promise.all(terminations);

    // Clear pending questions and permissions
    for (const pending of this.pendingQuestions.values()) {
      clearTimeout(pending.timeoutId);
      pending.reject(new Error('Session manager shutdown'));
    }
    this.pendingQuestions.clear();

    for (const pending of this.pendingPermissions.values()) {
      clearTimeout(pending.timeoutId);
      pending.reject(new Error('Session manager shutdown'));
    }
    this.pendingPermissions.clear();

    // Remove lock file so a fresh startup doesn't see stale state
    await unlink(this.lockFilePath).catch(() => {});
    this.config.logger.info('Session manager shutdown complete');
  }
}
