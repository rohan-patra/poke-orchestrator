# CLAUDE.md - Poke Orchestrator


## Project Overview

Poke Orchestrator is a server that allows [Poke](https://poke.com) to control multiple Claude Code instances via the Model Context Protocol (MCP). It acts as a bridge between Poke's AI orchestration platform and local Claude Code sessions.

### Architecture

```
Poke (Cloud) <--MCP--> Poke Orchestrator <--SDK--> Claude Code Instances
                              |
                              +--> Webhooks back to Poke (session events)
```

- **FastMCP Server**: Exposes tools via stateless HTTP transport at `/mcp` endpoint
- **Session Manager**: Manages multiple concurrent Claude Code sessions
- **Session Pool**: Pre-warms sessions for faster acquisition, handles orphan cleanup
- **Webhook Sender**: Batches and sends session events back to Poke (with connection pooling)
- **Workspace Manager**: Creates isolated working directories per session

## Key Technologies

- **Runtime**: Node.js 22+
- **Package Manager**: pnpm (not npm)
- **Language**: TypeScript (ES modules)
- **MCP Framework**: FastMCP with stateless HTTP transport
- **Claude Integration**: @anthropic-ai/claude-agent-sdk
- **Validation**: Zod
- **Logging**: Pino
- **HTTP Client**: Undici (connection pooling for webhooks)
- **Linting/Formatting**: Biome

## Project Structure

```
src/
├── server.ts           # Main entry point, Orchestrator class
├── config/
│   └── env.ts          # Environment variable validation (Zod)
├── core/
│   ├── config.ts       # OrchestratorConfig type and loader
│   ├── logger.ts       # Pino logger setup
│   ├── api-key.ts      # API key generation/management
│   └── errors.ts       # Custom error classes
├── claude/
│   ├── session.ts      # Session class wrapping Claude Code query
│   ├── session-manager.ts  # Manages multiple sessions + workspaces
│   ├── session-pool.ts # Pre-warms sessions, handles orphan cleanup
│   ├── types.ts        # Session types, events, MCP configs
│   └── utils.ts        # Pushable stream, message helpers
├── mcp/
│   ├── server.ts       # FastMCP server setup and tool registration
│   ├── handlers.ts     # Tool handler implementations
│   └── tools.ts        # Zod schemas for all MCP tools
└── poke/
    ├── webhook-sender.ts  # Batched webhook delivery to Poke
    └── types.ts           # Poke API types
```

## Commands

```bash
pnpm install          # Install dependencies
pnpm run dev          # Start dev server with hot reload
pnpm run dev:tunnel   # Start cloudflared tunnel for external access
pnpm run build        # Compile TypeScript
pnpm run start        # Run compiled server
pnpm run typecheck    # Type check without emitting
pnpm run lint         # Run Biome linter
pnpm run lint:fix     # Auto-fix lint issues
pnpm run format       # Format code with Biome
```

## Environment Variables

Required in `.env`:

```bash
POKE_API_KEY=<your-poke-api-key>        # Required: Poke API key for webhooks
ORCHESTRATOR_API_KEY=<key>               # Optional: Auto-generated if missing
```

Optional:

```bash
NODE_ENV=development                     # development | staging | production
MAX_SESSIONS=5                           # Max concurrent Claude Code sessions
SESSION_TIMEOUT_MS=3600000               # Session timeout (1 hour default)
MCP_PORT=3000                            # Port for MCP server
WORKSPACES_DIR=/tmp/poke-orchestrator/workspaces  # Session workspace base dir
POKE_BASE_URL=https://poke.com           # Poke API base URL
POKE_WEBHOOK_ENDPOINT=/api/v1/inbound-sms/webhook  # Webhook endpoint
WEBHOOK_BATCH_INTERVAL_MS=200            # Webhook batching interval
BYPASS_PERMISSIONS=true                  # Default: bypass all permissions
```

## MCP Tools Available to Poke

### Session Management
- `start_session` - Start a new Claude Code instance with optional MCP servers
- `terminate_session` - Terminate a session and clean up workspace
- `list_sessions` - List all active sessions
- `get_session_info` - Get detailed session info
- `get_pool_stats` - Get session pool statistics (warm/active counts)

### Batch Operations (Parallel Execution)
- `batch_send_prompts` - Send prompts to multiple sessions in parallel (max 10)
- `batch_terminate_sessions` - Terminate multiple sessions in parallel (max 10)
- `batch_get_session_info` - Get info for multiple sessions in parallel (max 10)

### Interaction
- `send_prompt` - Send a user prompt to a session
- `send_slash_command` - Send slash commands (/plan, /compact, /clear, etc.)
- `cancel_prompt` - Cancel the currently running prompt

### Permission Handling
- `answer_question` - Answer AskUserQuestion prompts
- `respond_to_permission` - Respond to permission requests (allow/deny)
- `set_session_mode` - Change permission mode (bypassPermissions or plan)

### Plan Mode
- `enter_plan_mode` - Put session into planning mode
- `approve_plan` - Approve plan and begin execution
- `modify_plan` - Send feedback to modify the plan

### Workspace Files
- `read_session_file` - Read file from session workspace
- `list_session_files` - List files in session workspace
- `get_session_file_info` - Get file metadata

### MCP Servers
- `add_mcp_server` - Add MCP server to session (must be at creation time)

## Key Implementation Details

### Permission Modes

Only two modes are available:
- `bypassPermissions` (default) - Bypass all permission checks
- `plan` - Planning mode, no actual tool execution

Other modes (`default`, `acceptEdits`, `dontAsk`) are commented out.

### Claude Code Launch Options

All Claude Code sessions are launched with:
- `allowDangerouslySkipPermissions: true` by default
- `settingSources: ['user']` to inherit user-scoped MCP servers from `~/.claude/settings.json`

### Webhook Filtering

Only relevant events are sent to Poke (to reduce noise):
- `question`, `permission_request` - Poke needs to respond
- `tool_call`, `tool_result` - Monitor progress (tool results include correlated tool names)
- `plan_update`, `plan_mode_change` - Track planning
- `session_ended`, `error` - Final status
- `message_chunk` - Text output (aggregated over 50ms windows to reduce volume)

Filtered out:
- `thinking` - Extended thinking (too verbose)

### Performance Optimizations

- **Message Chunk Aggregation**: Text chunks are buffered for 50ms before sending, reducing webhook volume by 80-90%
- **Connection Pooling**: Webhook sender uses Undici connection pool (10 connections, keep-alive)
- **Retry with Backoff**: Failed webhooks retry 3 times with exponential backoff (100ms, 200ms, 400ms)
- **Tool Result Tracking**: Tool call IDs are tracked to correlate tool results with their tool names

### Session Workspaces

Each session gets an isolated workspace directory:
- Created at: `{WORKSPACES_DIR}/{sessionId}/`
- Automatically cleaned up when session terminates
- Path traversal protection on file read tools
- Pending questions/permissions are cleaned up on session termination

### Session Pool & Orphan Cleanup

The session pool provides pre-warmed sessions and handles cleanup:
- **Lock File**: `{WORKSPACES_DIR}/.orchestrator.lock` tracks process PID and session IDs
- **Orphan Detection**: On startup, checks if previous process died and cleans up its sessions
- **Process Handlers**: Registers SIGINT, SIGTERM, uncaughtException handlers for cleanup
- **Pre-warming**: Can maintain a pool of ready sessions for faster acquisition

### Authentication

MCP requests must include Bearer token:
```
Authorization: Bearer <ORCHESTRATOR_API_KEY>
```

## Common Development Tasks

### Adding a New MCP Tool

1. Add Zod schema in `src/mcp/tools.ts`:
```typescript
export const myToolSchema = z.object({
  sessionId: z.string().describe('Session ID'),
  // ... parameters
});
export type MyToolInput = z.infer<typeof myToolSchema>;
```

2. Add handler in `src/mcp/handlers.ts`:
```typescript
async my_tool(input: MyToolInput): Promise<ToolResult> {
  // implementation
}
```

3. Register in `src/mcp/server.ts`:
```typescript
server.addTool({
  name: 'my_tool',
  description: 'Description for Poke',
  parameters: myToolSchema,
  execute: async (args) => {
    const result = await handlers.my_tool(args);
    return getResultText(result);
  },
});
```

### Adding a New Session Event

1. Add event type in `src/claude/types.ts` SessionEvent union
2. Handle in `src/claude/session.ts` processMessages()
3. Add payload type in `src/poke/types.ts`
4. Map in `src/poke/webhook-sender.ts` eventToPayload()
5. Update `isRelevantForPoke()` filter if needed

### Testing with Poke

1. Start the server: `pnpm run dev`
2. Start tunnel: `pnpm run dev:tunnel`
3. Copy the cloudflared URL (e.g., `https://xxx.trycloudflare.com`)
4. Configure in Poke with the `/mcp` endpoint

## Debugging

### Enable Debug Logging

The webhook sender logs full payloads at DEBUG level. Check logs for:
- `Sending webhook batch to Poke` - Shows payload content
- `Failed to send webhook to Poke` - Shows error response

### Common Issues

1. **Port in use**: Kill existing process on port 3000
2. **Poke webhook 400**: Check payload format matches `{ message: string }`
3. **Session not found**: Session may have timed out or been terminated
4. **MCP timeout**: Ensure stateless mode is enabled in FastMCP config

## Code Style

- Use Biome for formatting and linting
- Prefer explicit types over inference for public APIs
- Use Zod for all external input validation
- Keep handlers thin, business logic in session-manager
- Use pino logger, not console.log
