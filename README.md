# azure-bot-acp-adapter

Connect Azure Bot Service channels to a remotely hosted Agent Client Protocol (ACP) backend over an authenticated WebSocket.

## Why This Adapter Exists

Azure Bot Service and Bot Framework provide channel registration, authentication, activity routing, and proactive messaging. ACP provides a standard interface for interacting with agents. Neither supplies the translation layer between those two systems.

Most messaging-to-ACP projects run an ACP-compatible agent on the same machine and communicate with it over standard input/output. This adapter is designed for a different deployment model:

- The channel-facing runtime and ACP agent can run in separate environments.
- The adapter connects to the remote backend through an authenticated WebSocket.
- A shared WebSocket transport carries isolated ACP sessions for multiple Bot Framework conversations.
- The channel-facing host does not need an agent CLI or an interactive device sign-in for the agent.
- Long-running work is delivered through proactive Bot Framework activities after the incoming request has been acknowledged.

ACP commonly uses JSON-RPC over standard input/output for local agents. Remote ACP transport is still an evolving part of the ecosystem; this project uses newline-delimited JSON-RPC over an authenticated WebSocket.

## Supported Channels

The production endpoint accepts Bot Framework activities, so the runtime is not limited to a direct Teams integration. Its asynchronous response path currently recognizes:

- Microsoft Teams
- Direct Line
- Bot Framework Web Chat

Other Azure Bot Service channels may work through the standard Bot Framework path, but should be validated before production use.

## Architecture

```text
Teams / Web Chat / Direct Line
                            |
                            v
            Azure Bot Service
                            |
             Bot Framework activity
                            |
                            v
    azure-bot-acp-adapter
        - channel authentication
        - conversation correlation
        - proactive typing and replies
        - ACP session lifecycle
        - reconnect and timeout handling
                            |
         authenticated WebSocket
         newline-delimited JSON-RPC
                            |
                            v
             Remote ACP backend
```

Each Bot Framework conversation is mapped to its own ACP session. The adapter creates, loads, resumes, configures, prompts, and expires sessions while reusing the underlying WebSocket connection.

## Response Lifecycle

Teams, Direct Line, and Web Chat requests can outlive the normal incoming activity request. For those channels, the adapter:

1. Acknowledges the incoming Bot Framework request promptly.
2. Continues sending proactive typing activities while the backend is working.
3. Routes ACP session updates to the originating conversation.
4. Sends one user-visible final response proactively.

Final activities include the following channel data so clients can distinguish completion from intermediate activity:

```json
{
    "responseType": "final",
    "isFinal": true,
    "stopReason": "optional ACP stop reason"
}
```

## Features

- Azure Bot Service and Bot Framework channel integration
- Remote ACP-style JSON-RPC over authenticated WebSocket
- One isolated ACP session per Bot Framework conversation
- ACP initialization and session create, load, resume, configure, prompt, and destroy operations
- WebSocket reconnect with ACP protocol reinitialization
- Request correlation and configurable connection, RPC, and session timeouts
- Proactive typing indicators and final response delivery
- ACP session update routing and permission-request handling
- Bot Framework authentication by default
- Optional OpenID/JWKS-based JWT-only authentication mode
- Container deployment with a health endpoint
- Structured logs with correlation identifiers

## Prerequisites

- Node.js 20 or later, or Docker with Docker Compose
- An Azure Bot Service resource and app registration
- A public HTTPS endpoint for `POST /api/messages`
- A remote ACP backend reachable through `ws://` or `wss://`
- A backend username and token accepted through WebSocket Basic authentication

For production, use `wss://` and store credentials in a secret manager or deployment platform secret store. Do not commit `.env` files or exported Azure resource JSON.

## Quick Start

### 1. Clone and install

```powershell
git clone https://github.com/cliffzhu/azure-bot-acp-adapter.git
cd azure-bot-acp-adapter
npm install
```

Until the replacement repository is created, use the current repository URL and directory name instead.

### 2. Configure the environment

```powershell
Copy-Item .env.sample .env
notepad .env
```

Minimum configuration:

```env
NODE_ENV=development
PORT=3978

# Azure Bot Service app registration
MicrosoftAppType=SingleTenant
MicrosoftAppId=YOUR_BOT_APP_ID
MicrosoftAppPassword=YOUR_BOT_APP_PASSWORD
MicrosoftAppTenantId=YOUR_TENANT_ID

# Remote ACP backend
WEBSOCKET_URL=wss://YOUR_BACKEND_HOST/ws
WEBSOCKET_USER=token
WEBSOCKET_AUTH_TOKEN=YOUR_BACKEND_TOKEN

# Optional ACP session default
WEBSOCKET_AGENT_NAME=
WEBSOCKET_MODEL_NAME=
```

`WEBSOCKET_AGENT_NAME` is preferred when the backend exposes an `agent` configuration option. `WEBSOCKET_MODEL_NAME` is a fallback for backends that expose a `model` option instead.

### 3. Run locally

```powershell
npm run dev
```

For the simplified container deployment, pull the published image from the upstream repository and start the service:

```powershell
docker compose pull
docker compose up -d
docker compose logs -f
```

The compose file uses the published image from GitHub Container Registry, so no local build step is required for normal deployments.

### 4. Check readiness

```powershell
curl http://localhost:3978/healthz
```

The response reports service health, in-memory session count, and remote WebSocket readiness:

```json
{
    "status": "ok",
    "sessionsInMemory": 0,
    "wsReady": true
}
```

## Configuration Reference

### Remote ACP connection

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `WEBSOCKET_URL` | Yes | None | Remote ACP WebSocket endpoint |
| `WEBSOCKET_AUTH_TOKEN` | Yes | None | Basic-auth password/token |
| `WEBSOCKET_USER` | No | `token` | Basic-auth username |
| `WEBSOCKET_AGENT_NAME` | No | Empty | Preferred `agent` session option |
| `WEBSOCKET_MODEL_NAME` | No | Empty | Fallback `model` session option |
| `WEBSOCKET_CONNECT_TIMEOUT_MS` | No | `10000` | Initial connection timeout |
| `WEBSOCKET_MESSAGE_TIMEOUT_MS` | No | `30000` | JSON-RPC request timeout |
| `WEBSOCKET_SESSION_TTL_MS` | No | `14400000` | Inactive conversation session lifetime |

### Bot runtime

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `PORT` | No | `3978` | HTTP listening port |
| `LOG_LEVEL` | No | `info` | Application log level |
| `LOG_DIR` | No | `logs` | Directory for `bot.log`, rotated logs, and generated message reports |
| `LOG_MAX_BYTES` | No | `5242880` | Maximum `bot.log` size before rotating to `bot.log.older` |
| `LOG_REPORT_DAYS` | No | `7` | Lookback window used by the message report generator and email interval |
| `MAIL_SENDER_ENDPOINT` | No | Empty | HTTP endpoint used to send scheduled report emails |
| `MAIL_SENDER_ENDPOINT_AUTHCODE` | No | Empty | Auth code sent as `Bearer` and `X-Auth-Code` to the email endpoint |
| `MAIL_FROM_ADDRESS` | No | Empty | Sender email address for scheduled report emails |
| `MAIL_TO_ADDRESS` | No | Empty | Recipient email address for scheduled report emails |
| `HEALTH_ENDPOINT_PATH` | No | `/healthz` | Health endpoint path |
| `OUTGOING_ACTIVITY_LOG_ENABLED` | No | `true` | Successful outgoing activity logging |
| `STREAMING_RESPONSES_ENABLED` | No | `false` | Process streamed updates while preserving channel-compatible delivery |
| `VERBOSE_SESSION_UPDATES` | No | `false` | Diagnostic-only forwarding of intermediate message/tool previews to Teams |

### Authentication

By default, `CloudAdapter` validates Bot Framework requests using the `MicrosoftApp*` settings.

Set `JWT_ONLY_AUTH_ENABLED=true` only when the deployment intentionally replaces CloudAdapter authentication with the included OpenID/JWKS middleware. JWT-only mode also requires an exact audience and either an OpenID configuration URL or Azure tenant configuration. See [.env.sample](.env.sample) for all supported settings.

## HTTP Endpoints

### `POST /api/messages`

Production Bot Framework messaging endpoint. Configure the Azure Bot Service messaging endpoint as:

```text
https://YOUR_PUBLIC_HOST/api/messages
```

### `GET /healthz`

Readiness endpoint. The path can be changed with `HEALTH_ENDPOINT_PATH`.

### Development endpoints

The following endpoints are available only when `NODE_ENV=development`:

- `POST /api/dev/messages` accepts full Activity payloads for local integration testing.
- `POST /api/simulate` provides a lightweight simulation path.

Do not expose development mode publicly.

## Build and Validate

```powershell
npm run typecheck
npm run build
```

The compiled service starts with:

```powershell
npm start
```

### Generate the message report

The server-side report script compiles to `dist/getBotMessageReport.js`. It reads `LOG_DIR` for `bot.log.older` and `bot.log`, consolidates both files into one chronological stream, and writes `bot-message-report.html` into `LOG_DIR`. The generated report uses `LOG_REPORT_DAYS + 1` as its effective lookback window so scheduled emails have an extra overlap day around rotations and send timing.

On Linux container startup, the server also ensures a managed root cron entry exists when `LOG_REPORT_DAYS` is set to a value greater than `0`. The managed cron runs daily at `16:00 UTC` and calls the compiled report script. If `LOG_REPORT_DAYS` is missing or not greater than `0`, the managed cron entry is removed.

```powershell
npm run build
npm run report:messages
```

The equivalent manual cron command is:

```sh
0 16 * * * cd /app && node dist/getBotMessageReport.js
```

### Email the message report

When `LOG_REPORT_DAYS` is greater than `0` and all `MAIL_*` variables are present, Linux container startup also ensures a managed email-report cron entry exists. The email job reads the generated `bot-message-report.html` from `LOG_DIR` and posts it to `MAIL_SENDER_ENDPOINT` using the JSON shape from `scripts/Send-Email-Sample.ps1`.

The first scheduled email date is persisted as the next Monday in `bot-message-report-email-state.json` under `LOG_DIR`. After a successful send, the next send date advances by `LOG_REPORT_DAYS`. The cron trigger runs around 10:00 `America/Los_Angeles`; the TypeScript sender checks the Pacific hour and schedule state before sending, so duplicate cron triggers only log a skip.

```powershell
npm run build
npm run report:email
```

## Container Deployment

Pull and run the published image from the upstream repository:

```powershell
docker compose pull
docker compose up -d
```

The compose file references the published image from GitHub Container Registry, so this is the recommended deployment path for most users. A local build is only needed if you want to test custom changes before publishing them.

Azure Bot Service requires a publicly reachable HTTPS endpoint. Terminate TLS at Azure Container Apps ingress, a managed ingress controller, or a reverse proxy and forward traffic to port `3978`.

The repository includes deployment and verification scripts under `scripts/`. Review their parameters and resulting Azure changes before using them in a new environment.

## Operational Notes

- Session state is held in process memory. A container restart clears the Bot Framework conversation-to-ACP session mapping.
- The remote ACP backend must support the session operations used by this adapter.
- Multiple adapter replicas do not share session state. Use one replica or add a shared session store before horizontal scaling.
- Teams does not provide a general token-by-token chat rendering contract. The adapter uses typing activities, optional session-update previews, and one explicit final activity.
- WebSocket reconnect restores the ACP transport but cannot guarantee recovery of backend state that the remote service did not persist.

## Security

- Prefer `wss://`; plain `ws://` exposes backend credentials and content in transit.
- Store bot credentials and `WEBSOCKET_AUTH_TOKEN` outside source control.
- Keep `.env`, runtime exports, deployment templates, logs, and cloud CLI output out of the Docker build context and Git history.
- Rotate a credential immediately if it has ever appeared in a commit, build log, runtime export, or shared document. Deleting the current file does not remove historical exposure.
- Keep production logs free of authorization headers, tokens, account keys, and raw environment dumps.
- Validate permission-request behavior against the configured ACP backend before allowing agents to perform sensitive operations.

## Project Scope

This project is middleware, not an agent framework and not an ACP server. It owns channel-to-ACP translation and conversation delivery. The remote backend owns agent execution, tools, model access, and durable agent state.

The most accurate positioning is:

> A cloud-hosted adapter connecting Azure Bot Service channels to remote ACP agents over authenticated WebSockets, with isolated conversation sessions and proactive response delivery.

## License

No license has been selected yet. Add a license before distributing the replacement repository publicly.


