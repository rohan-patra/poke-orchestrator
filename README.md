# Poke Orchestrator

[![Node.js](https://img.shields.io/badge/Node.js-22%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![MCP](https://img.shields.io/badge/MCP-Model%20Context%20Protocol-8B5CF6)](https://modelcontextprotocol.io/)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**Your AI assistant should work wherever you do.**

Poke Orchestrator lets you control AI agents that can complete virtually any task on your computer—from the messaging apps you already use. Chat with your agent through iMessage, SMS, WhatsApp, or Telegram via [Poke](https://poke.com). The agent handles the rest: browsing the web, managing files, running commands, filling out forms, and automating workflows.

## The Vision

We believe AI assistants should be:

1. **Messaging-first** — Interact through iMessage, SMS, WhatsApp, or Telegram—no new apps to install
2. **Capable of anything** — Browse the web, use applications, manage files, execute commands, automate multi-step workflows
3. **Professionally managed** — Multi-session orchestration with proper isolation, pooling, and lifecycle management
4. **Instantly responsive** — Pre-warmed session pools and batched operations for production workloads
5. **Transparently observable** — Real-time streaming of every action, output, and decision

This is your personal AI that can do anything you can do on a computer—accessible from wherever you are.

## How It Works

```
┌─────────────────┐         ┌─────────────────────────────────────┐
│                 │   MCP   │         Poke Orchestrator           │
│   Poke Cloud    │◄───────►│                                     │
│                 │  HTTP   │  ┌─────────────┐  ┌──────────────┐  │
└─────────────────┘         │  │ FastMCP     │  │ Session      │  │
        ▲                   │  │ Server      │  │ Manager      │  │
        │                   │  │ (21 tools)  │  │              │  │
        │ Webhooks          │  └─────────────┘  └──────────────┘  │
        │                   │         │                │          │
        │                   │         ▼                ▼          │
        │                   │  ┌─────────────────────────────┐    │
        │                   │  │     Claude Code Sessions    │    │
        │                   │  │  ┌───┐  ┌───┐  ┌───┐  ...   │    │
        └───────────────────│──│  │ 1 │  │ 2 │  │ 3 │        │    │
                            │  │  └───┘  └───┘  └───┘        │    │
                            │  └─────────────────────────────┘    │
                            └─────────────────────────────────────┘
```

## What Can It Do?

The agent can perform essentially any task you could do yourself:

- **Web browsing** — Research topics, fill out forms, navigate websites, extract information
- **File management** — Create, edit, organize, and process files and documents
- **Command execution** — Run shell commands, scripts, and system operations
- **Application control** — Interact with desktop applications through the browser and terminal
- **Multi-step workflows** — Chain together complex sequences of actions to complete larger tasks
- **Data processing** — Parse, transform, and analyze data from various sources

## Key Differentiators

### Professional Session Management

Sessions are first-class resources with proper lifecycle management:

- **Isolated workspaces** — Each session gets its own directory, preventing cross-contamination
- **Session pooling** — Pre-warm instances for sub-second acquisition times
- **Graceful lifecycle** — Proper cleanup on termination, timeout, or unexpected shutdown
- **Orphan recovery** — Automatic detection and cleanup of sessions from crashed processes

### Production-Ready Architecture

- **Stateless HTTP transport** — Scale horizontally behind load balancers
- **Connection pooling** — Efficient webhook delivery with persistent connections
- **Batched operations** — Execute across multiple sessions in parallel (up to 10 concurrent)
- **Retry with backoff** — Automatic recovery from transient failures

### Full Observability

Every action is streamed back in real-time:

| Event | What You See |
|-------|-------------|
| `tool_call` | Agent is performing an action (browsing, file edit, command, etc.) |
| `tool_result` | Action completed with output |
| `message_chunk` | Text streaming from the agent (aggregated for efficiency) |
| `question` | Agent needs human input to proceed |
| `permission_request` | A sensitive operation requires approval |
| `plan_update` | Task planning in progress |
| `session_ended` | Work complete or session terminated |

### Permission Handling

- **Bypass mode** — Full automation, no interruptions
- **Plan mode** — Review and approve before execution
- **Interactive mode** — Respond to permission requests in real-time

## Limitations

### Browser Access Requires Manual Approval

When the agent attempts to browse the web, the server operator must manually approve each website before the agent can access it. There is no way to grant blanket browser access—every domain must be explicitly allowlisted.

## Getting Started

### Prerequisites

- Node.js 22+
- pnpm
- Claude Code CLI (installed and authenticated)
- Poke API key

### Quick Start

```bash
# Clone and install
git clone https://github.com/your-org/poke-orchestrator.git
cd poke-orchestrator
pnpm install

# Configure
cp .env.example .env
# Edit .env with your POKE_API_KEY

# Run
pnpm run dev
```

Server starts at `http://localhost:3000/mcp`

### Expose to the Internet

```bash
pnpm run dev:tunnel
# Copy the cloudflared URL and configure in Poke
```

## Configuration

```bash
# Required
POKE_API_KEY=your-poke-api-key

# Optional
MAX_SESSIONS=5                    # Concurrent session limit
SESSION_TIMEOUT_MS=3600000        # 1 hour default
MCP_PORT=3000
BYPASS_PERMISSIONS=true           # Full automation by default
WEBHOOK_BATCH_INTERVAL_MS=200     # Event batching window
```

## API Reference

All operations use MCP tools with Bearer token authentication.

### Session Lifecycle

```bash
start_session      # Spin up a new agent instance
terminate_session  # Clean shutdown with workspace cleanup
list_sessions      # View all active sessions
get_session_info   # Detailed session state
get_pool_stats     # Pool health and availability
```

### Interaction

```bash
send_prompt        # Send a task to the agent
send_slash_command # /plan, /compact, /clear, etc.
cancel_prompt      # Abort current operation
```

### Permission Flow

```bash
answer_question        # Respond to agent's questions
respond_to_permission  # Allow or deny sensitive operations
set_session_mode       # Switch between bypass/plan modes
```

### Plan Mode

```bash
enter_plan_mode  # Start planning without execution
approve_plan     # Execute the approved plan
modify_plan      # Iterate on the plan
```

### Batch Operations

```bash
batch_send_prompts       # Parallel execution across sessions
batch_terminate_sessions # Bulk cleanup
batch_get_session_info   # Aggregate status check
```

### Workspace Access

```bash
read_session_file      # Retrieve generated files
list_session_files     # Browse workspace contents
get_session_file_info  # File metadata
```

## Performance

| Metric | Value |
|--------|-------|
| Session acquisition (cold) | ~2-3s |
| Session acquisition (pooled) | <500ms |
| Webhook delivery | Batched every 200ms |
| Message aggregation | 50ms windows |
| Connection pool | 10 persistent connections |
| Retry strategy | 3 attempts, exponential backoff |

## Development

```bash
pnpm run dev        # Hot reload development
pnpm run build      # Production build
pnpm run typecheck  # Type validation
pnpm run lint       # Code quality
pnpm run format     # Code formatting
```

See [CLAUDE.md](CLAUDE.md) for architecture details and contribution guidelines.

## License

MIT

---

**Your personal AI that can do anything—accessible from anywhere.**
