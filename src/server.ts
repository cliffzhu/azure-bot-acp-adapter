import express from "express";
import {
  Activity,
  ActivityTypes,
  CardFactory,
  CloudAdapter,
  ConfigurationBotFrameworkAuthentication,
  TurnContext
} from "botbuilder";
import { config } from "./config";
import { jwtAuthMiddleware } from "./jwtAuthMiddleware";
import { logOutgoingActivity, payloadLogger } from "./logger";
import { SessionStore } from "./sessionStore";
import { WebSocketManager } from "./websocketManager";
import { WebSocketSessionCoordinator } from "./websocketSessionCoordinator";
import { applySymlinkMappings } from "./symlinkBootstrap";
import { applyReportCronBootstrap } from "./reportCronBootstrap";
import { applyEmailReportCronBootstrap } from "./emailReportCronBootstrap";

applySymlinkMappings(config.symlinkMappings);
applyReportCronBootstrap();
applyEmailReportCronBootstrap();

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  if (req.path === config.healthEndpointPath) {
    next();
    return;
  }

  payloadLogger(req, res, next);
});
const sessionStore = new SessionStore();

// Initialize WebSocket components
let wsManager: WebSocketManager | null = null;
let wsCoordinator: WebSocketSessionCoordinator | null = null;
let wsInitialized = false;
let wsConnectingPromise: Promise<void> | null = null;

type StreamForwardState = {
  channelId: string;
  botAppId: string;
  reference: ReturnType<typeof TurnContext.getConversationReference>;
  queue: Promise<void>;
  closed: boolean;
};

const streamForwardState = new Map<string, StreamForwardState>();

function stopStreamUpdateForwarding(conversationKey: string): void {
  const state = streamForwardState.get(conversationKey);
  if (!state) {
    return;
  }

  state.closed = true;
}

let adapter: CloudAdapter | null = null;

const botFrameworkAuthentication = new ConfigurationBotFrameworkAuthentication(
  process.env as Record<string, string>
);
adapter = new CloudAdapter(botFrameworkAuthentication);

adapter.onTurnError = async (context: TurnContext, err: Error) => {
  console.error("Unhandled bot error", err);
  await sendActivityWithLog(
    context,
    "Something went wrong. Please try again.",
    "api/messages"
  );
};

type MessageRoutingInput = {
  channelId: string;
  conversationId: string;
  userId: string;
  userText: string;
};

type ResponseType = "acknowledgement" | "final";

type BackendErrorSource =
  | "proxy_connect_timeout"
  | "proxy_request_timeout"
  | "proxy_unavailable"
  | "upstream_db_lock"
  | "upstream_or_proxy_timeout"
  | "unknown";

type BackendErrorDiagnostics = {
  source: BackendErrorSource;
  userMessage: string;
  rawMessage: string;
  timeoutMethod?: string;
};

const DISABLED_TOOLS_PREAMBLE = "Info: Disabled tools: apply_patch, bash, list_bash, read_bash, session_store_sql, sql, stop_bash, task, web_fetch, write_agent";

function getBackendErrorDiagnostics(error: unknown): BackendErrorDiagnostics {
  const rawMessage = error instanceof Error ? error.message : String(error);
  const lower = rawMessage.toLowerCase();

  const timeoutMethodMatch = rawMessage.match(/Request timeout for method \"([^\"]+)\"/i);
  if (timeoutMethodMatch) {
    return {
      source: "proxy_request_timeout",
      userMessage: "The backend service is not responding. Please try again.",
      rawMessage,
      timeoutMethod: timeoutMethodMatch[1]
    };
  }

  if (lower.includes("websocket connection timeout")) {
    return {
      source: "proxy_connect_timeout",
      userMessage: "The backend service is not responding. Please try again.",
      rawMessage
    };
  }

  if (lower.includes("websocket not connected") || lower.includes("not initialized")) {
    return {
      source: "proxy_unavailable",
      userMessage: "Service initialization failed. Please try again.",
      rawMessage
    };
  }

  if (lower.includes("database is locked") || lower.includes("sqlite_busy")) {
    return {
      source: "upstream_db_lock",
      userMessage: "The backend service is temporarily busy. Please try again.",
      rawMessage
    };
  }

  if (lower.includes("timeout")) {
    return {
      source: "upstream_or_proxy_timeout",
      userMessage: "The backend service is not responding. Please try again.",
      rawMessage
    };
  }

  return {
    source: "unknown",
    userMessage: "I cannot reach the backend service right now. Please try again shortly.",
    rawMessage
  };
}

function sanitizeBackendReplyText(text: string): string {
  if (!text.startsWith(DISABLED_TOOLS_PREAMBLE)) {
    return text;
  }

  return text.slice(DISABLED_TOOLS_PREAMBLE.length).trimStart();
}

function extractSessionUpdateText(value: unknown): string | null {
  if (Array.isArray(value)) {
    const textParts = value
      .map((item) => extractSessionUpdateText(item))
      .filter((text): text is string => Boolean(text));

    return textParts.length > 0 ? textParts.join("\n") : null;
  }

  if (!value || typeof value !== "object") {
    return null;
  }

  const record = value as Record<string, any>;

  if (typeof record.text === "string" && record.text.trim().length > 0) {
    return record.text;
  }

  if (typeof record.type === "string" && record.content !== undefined) {
    return extractSessionUpdateText(record.content);
  }

  if (record.content !== undefined) {
    return extractSessionUpdateText(record.content);
  }

  return null;
}

function formatSessionUpdatePreview(update: any): string | null {
  if (!update || typeof update !== "object") {
    return null;
  }

  const updateType = String(update.sessionUpdate ?? "");
  const content = update.content ?? {};

  if (updateType === "agent_message_chunk") {
    const text = extractSessionUpdateText(content) ?? "";
    return text.trim().length > 0 ? text : null;
  }

  if (updateType === "agent_message_completion") {
    return "[stream] message completed";
  }

  if (updateType === "tool_call" || updateType === "tool_call_update") {
    const text = extractSessionUpdateText(content);
    if (text) {
      return `[tool] ${text}`;
    }
    if (content.json !== undefined) {
      const raw = JSON.stringify(content.json);
      const trimmed = raw.length > 240 ? `${raw.slice(0, 240)}...` : raw;
      return `[tool] ${trimmed}`;
    }
    return "[tool] update";
  }

  if (updateType === "session_state_change") {
    const raw = content.json !== undefined ? JSON.stringify(content.json) : "state updated";
    return `[session] ${raw}`;
  }

  if (updateType === "session_error") {
    const message = update.error?.message ?? "Unknown session error";
    return `[session error] ${message}`;
  }

  if (updateType === "available_commands_update") {
    return "[session] available commands updated";
  }

  if (updateType === "config_option_update") {
    return "[session] config option updated";
  }

  return null;
}

function normalizePreviewMarkdown(text: string): string {
  return text
    .replace(/^(\s{0,3})(#{1,6})(?=\s)/gm, "$1\\$2")
    .replace(/^(\s*)(=+|-+)\s*$/gm, "$1\\$2");
}

function createLightPreviewActivity(text: string): Partial<Activity> {
  const card = {
    type: "AdaptiveCard",
    version: "1.4",
    body: [
      {
        type: "Container",
        style: "emphasis",
        bleed: false,
        items: [
          {
            type: "TextBlock",
            text: normalizePreviewMarkdown(text),
            wrap: true,
            color: "default",
            isSubtle: false,
            size: "small"
          }
        ]
      }
    ]
  };

  return {
    type: ActivityTypes.Message,
    attachments: [CardFactory.adaptiveCard(card)]
  };
}

function forwardSessionUpdatePreview(conversationKey: string, update: any): void {
  if (!config.verboseSessionUpdates) {
    return;
  }

  const state = streamForwardState.get(conversationKey);
  if (!state) {
    return;
  }

  if (state.closed) {
    return;
  }

  if (state.channelId !== "msteams") {
    return;
  }

  const preview = formatSessionUpdatePreview(update);
  if (!preview) {
    return;
  }

  state.queue = state.queue
    .then(async () => {
      if (!adapter) {
        return;
      }

      const latestState = streamForwardState.get(conversationKey);
      if (!latestState || latestState.closed) {
        return;
      }

      await adapter.continueConversationAsync(state.botAppId, state.reference, async (proactiveContext) => {
        await proactiveContext.sendActivity(createLightPreviewActivity(preview));
      });
    })
    .catch((error) => {
      console.error("Failed to forward upstream preview update", {
        error,
        conversationKey,
        updateType: update?.sessionUpdate
      });
    });
}

async function sendActivityWithLog(
  context: TurnContext,
  text: string,
  source: "api/messages" | "api/dev/messages",
  stopReason?: string,
  responseType: ResponseType = "final"
): Promise<void> {
  const channelId = context.activity.channelId ?? "unknown-channel";
  const conversationId = context.activity.conversation?.id ?? "unknown-conversation";
  const userId = context.activity.from?.id ?? "unknown-user";

  if (config.outgoingActivityLogEnabled) {
    console.info("[outgoing] sendActivity attempt", {
      source,
      channelId,
      conversationId,
      userId,
      textLength: text.length,
      stopReason: stopReason ?? "n/a"
    });

    logOutgoingActivity({
      source,
      channelId,
      conversationId,
      userId,
      status: "attempt",
      text,
      stopReason
    });
  }

  try {
    await context.sendActivity({
      type: ActivityTypes.Message,
      text,
      channelData: {
        responseType,
        isFinal: responseType === "final",
        ...(stopReason ? { stopReason } : {})
      }
    });
    if (config.outgoingActivityLogEnabled) {
      console.info("[outgoing] sendActivity success", {
        source,
        channelId,
        conversationId,
        userId,
        textLength: text.length,
        stopReason: stopReason ?? "n/a"
      });

      logOutgoingActivity({
        source,
        channelId,
        conversationId,
        userId,
        status: "success",
        text,
        stopReason
      });
    }
  } catch (error) {
    console.error("[outgoing] sendActivity failed", {
      source,
      channelId,
      conversationId,
      userId,
      textLength: text.length,
      stopReason: stopReason ?? "n/a",
      error
    });

    logOutgoingActivity({
      source,
      channelId,
      conversationId,
      userId,
      status: "failure",
      text,
      stopReason,
      error: error instanceof Error ? error.message : String(error)
    });

    throw error;
  }
}

async function sendJwtOnlyActivityWithLog(
  activity: Activity,
  text: string,
  source: "api/messages" | "api/dev/messages",
  stopReason?: string
): Promise<void> {
  const channelId = activity.channelId ?? "unknown-channel";
  const conversationId = activity.conversation?.id ?? "unknown-conversation";
  const userId = activity.from?.id ?? "unknown-user";

  if (config.outgoingActivityLogEnabled) {
    console.info("[outgoing] sendActivity attempt", {
      source,
      channelId,
      conversationId,
      userId,
      textLength: text.length,
      stopReason: stopReason ?? "n/a"
    });

    logOutgoingActivity({
      source,
      channelId,
      conversationId,
      userId,
      status: "attempt",
      text,
      stopReason
    });
  }

  if (!adapter) {
    throw new Error("CloudAdapter not initialized");
  }

  const botAppId = process.env.MicrosoftAppId ?? "";
  if (!botAppId) {
    throw new Error("MicrosoftAppId is required to send channel activities in JWT-only mode");
  }

  try {
    const reference = TurnContext.getConversationReference(activity);
    await adapter.continueConversationAsync(botAppId, reference, async (proactiveContext) => {
      await proactiveContext.sendActivity(text);
    });

    if (config.outgoingActivityLogEnabled) {
      console.info("[outgoing] sendActivity success", {
        source,
        channelId,
        conversationId,
        userId,
        textLength: text.length,
        stopReason: stopReason ?? "n/a"
      });

      logOutgoingActivity({
        source,
        channelId,
        conversationId,
        userId,
        status: "success",
        text,
        stopReason
      });
    }
  } catch (error) {
    console.error("[outgoing] sendActivity failed", {
      source,
      channelId,
      conversationId,
      userId,
      textLength: text.length,
      stopReason: stopReason ?? "n/a",
      error
    });

    logOutgoingActivity({
      source,
      channelId,
      conversationId,
      userId,
      status: "failure",
      text,
      stopReason,
      error: error instanceof Error ? error.message : String(error)
    });

    throw error;
  }
}

async function routeMessageToBackend(input: MessageRoutingInput): Promise<{ text: string; stopReason: string }> {
  const conversationKey = `${input.channelId}|${input.conversationId}|${input.userId}`;

  if (!input.userText) {
    return {
      text: "Please send a message.",
      stopReason: "validation"
    };
  }

  // Ensure WebSocket is ready and connected
  if (!wsInitialized || !wsCoordinator?.isReady()) {
    await ensureWebSocketReady();
  }

  if (!wsCoordinator) {
    throw new Error("WebSocket coordinator not initialized");
  }

  // Ensure session exists for this conversation
  const sessionId = await wsCoordinator.ensureSession(conversationKey);

  // Send message to backend and get buffered response
  const response = await wsCoordinator.sendMessage(conversationKey, sessionId, input.userText);

  // Pool replenishment (if this turn claimed a prepared session) is
  // deferred until after the user-visible reply has actually been sent -
  // see consumeClaimedFromPool()/triggerPreparedSessionReplenishmentAfterSuccess()
  // at each outgoing-activity call site below.

  // Format user-friendly response message
  let replyMessage = response.text;
  if (!replyMessage) {
    if (response.hasErrors) {
      replyMessage = `Error: ${response.error?.message || "Unknown error"}`;
    } else {
      replyMessage = `Response received (${response.stopReason})`;
    }
  }

  replyMessage = sanitizeBackendReplyText(replyMessage);

  return {
    text: replyMessage,
    stopReason: response.stopReason
  };
}

async function buildConversationReply(input: MessageRoutingInput): Promise<{ text: string; stopReason: string }> {
  return routeMessageToBackend(input);
}

/**
 * If this conversation's current turn claimed a session from the prepared
 * pool, trigger the pool's watchdog/replenishment now. Call this only after
 * the user-visible reply has actually been sent, so the pool's session/new +
 * warmup session/prompt never race the real backend prompt for this turn.
 */
function replenishPreparedPoolIfClaimed(conversationKey: string): void {
  if (!wsCoordinator?.consumeClaimedFromPool(conversationKey)) {
    return;
  }

  void wsCoordinator.triggerPreparedSessionReplenishmentAfterSuccess().catch((error) => {
    console.warn("Prepared-session replenishment deferred after outgoing-activity failed:", error);
  });
}

async function sendStreamingTypingIndicators(context: TurnContext): Promise<() => void> {
  if (!config.streamingResponsesEnabled) {
    return () => {};
  }

  let active = true;

  const sendTyping = async () => {
    if (!active) {
      return;
    }

    try {
      await context.sendActivity({ type: ActivityTypes.Typing });
    } catch (error) {
      console.error("Failed to send typing indicator", error);
    }
  };

  await sendTyping();

  const interval = setInterval(() => {
    void sendTyping();
  }, 2500);

  return () => {
    active = false;
    clearInterval(interval);
  };
}

function startProactiveTypingIndicators(
  adapter: CloudAdapter,
  botAppId: string,
  reference: ReturnType<typeof TurnContext.getConversationReference>
): () => void {
  let active = true;

  const sendTyping = async () => {
    if (!active) {
      return;
    }

    try {
      await adapter.continueConversationAsync(botAppId, reference, async (proactiveContext) => {
        await proactiveContext.sendActivity({ type: ActivityTypes.Typing });
      });
    } catch (error) {
      console.error("Failed to send proactive typing indicator", error);
    }
  };

  void sendTyping();
  const interval = setInterval(() => {
    void sendTyping();
  }, 2500);

  return () => {
    active = false;
    clearInterval(interval);
  };
}

/**
 * Initialize or reconnect the WebSocket on demand.
 * Serialized via wsConnectingPromise so concurrent callers all wait for the same attempt.
 */
async function ensureWebSocketReady(): Promise<void> {
  // Already ready — fast path
  if (wsInitialized && wsCoordinator?.isReady()) {
    return;
  }

  // Serialize concurrent callers onto a single reconnect attempt
  if (wsConnectingPromise) {
    return wsConnectingPromise;
  }

  wsConnectingPromise = (async () => {
    try {
      if (wsManager && wsCoordinator) {
        // Manager + coordinator already exist (background reconnect loop is active).
        // Short-circuit: connect immediately and re-run the handshake.
        console.log("WebSocket not ready — reconnecting on demand...");
        await wsManager.connect();
        await wsCoordinator.reInitializeHandshake();
        console.log("WebSocket reconnected on demand");
      } else {
        // First-time initialization
        wsManager = new WebSocketManager({
          url: config.websocketUrl,
          username: config.websocketUser,
          authToken: config.websocketAuthToken,
          connectTimeoutMs: config.websocketConnectTimeoutMs,
          messageTimeoutMs: config.websocketMessageTimeoutMs
        });

        wsCoordinator = new WebSocketSessionCoordinator(sessionStore);
        wsCoordinator.onSessionUpdate((conversationKey, update) => {
          forwardSessionUpdatePreview(conversationKey, update);
        });

        wsCoordinator.onPermissionRequest(async (request) => {
          console.log(`Permission requested: ${request.permission}`);
          console.log(`Description: ${request.description || "(none)"}`);
          return "denied";
        });

        wsManager.on("disconnected", () => {
          console.log("WebSocket disconnected, will reconnect on next message");
          wsInitialized = false;
        });

        wsManager.on("reconnected", () => {
          wsInitialized = true;
        });

        await wsManager.connect();
        await wsCoordinator.initialize(wsManager);

        wsInitialized = true;
        console.log("WebSocket coordinator initialized and ready");
      }
    } catch (error) {
      console.error("Failed to initialize/reconnect WebSocket:", error);
      if (!wsInitialized) {
        // First-time failure — clean up so next attempt starts fresh
        wsManager = null;
        wsCoordinator = null;
      }
      throw error;
    } finally {
      wsConnectingPromise = null;
    }
  })();

  return wsConnectingPromise;
}

async function initializeWebSocketOnStartup(): Promise<void> {
  const maxAttempts = config.websocketStartupMaxAttempts;
  const retryDelayMs = config.websocketStartupRetryDelayMs;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await ensureWebSocketReady();
      return;
    } catch (error) {
      console.error(`Initial WebSocket connection attempt ${attempt}/${maxAttempts} failed:`, error);
      if (attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      }
    }
  }

  console.error("Initial WebSocket connection attempts exhausted; will retry on the next message");
}

app.get(config.healthEndpointPath, (_req, res) => {
  res.status(200).json({
    status: "ok",
    sessionsInMemory: sessionStore.size(),
    wsReady: wsCoordinator?.isReady() ?? false,
    preparedSessionPool: wsCoordinator?.getPreparedSessionPoolSnapshot() ?? null
  });
});

app.use(jwtAuthMiddleware);

app.post("/api/messages", async (req, res) => {
  if (config.jwtOnlyAuthEnabled) {
    const activity = req.body as Activity;

    if (!activity?.type) {
      res.status(400).json({ error: "Activity type is required" });
      return;
    }

    if (activity.type === "conversationUpdate") {
      console.log(`[JWT-ONLY] ConversationUpdate: ${activity.conversation?.id}`);
      res.status(200).json({ text: "Conversation updated" });
      return;
    }

    if (activity.type === "endOfConversation") {
      console.log(`[JWT-ONLY] EndOfConversation: ${activity.conversation?.id}`);
      res.status(200).json({ text: "Conversation ended" });
      return;
    }

    if (activity.type !== "message") {
      res.status(400).json({ error: `Unsupported activity type: ${activity.type}` });
      return;
    }

    const userText = (activity.text ?? "").trim();
    const channelId = activity.channelId ?? "msteams";
    const conversationId = activity.conversation?.id ?? "jwt-only-conversation";
    const userId = activity.from?.id ?? "jwt-only-user";
    const conversationKey = `${channelId}|${conversationId}|${userId}`;

    try {
      const reply = await routeMessageToBackend({ channelId, conversationId, userId, userText });
      await sendJwtOnlyActivityWithLog(activity, reply.text, "api/messages", reply.stopReason);
      // Acknowledge the incoming activity; the user-visible reply is sent as a channel activity.
      res.status(200).json({});
    } catch (error) {
      const diagnostics = getBackendErrorDiagnostics(error);
      console.error("[JWT-ONLY] Message endpoint error", {
        error,
        errorSource: diagnostics.source,
        errorMessage: diagnostics.rawMessage,
        timeoutMethod: diagnostics.timeoutMethod,
        wsInitialized,
        wsReady: wsCoordinator?.isReady() ?? false,
        channelId,
        conversationId,
        userId
      });

      const errorMessage = diagnostics.userMessage;

      try {
        await sendJwtOnlyActivityWithLog(activity, errorMessage, "api/messages");
        res.status(200).json({});
      } catch (sendError) {
        const message = sendError instanceof Error ? sendError.message : String(sendError);
        res.status(500).json({ error: message });
      }
    } finally {
      replenishPreparedPoolIfClaimed(conversationKey);
    }
    return;
  }

  if (!adapter) {
    res.status(500).json({ error: "CloudAdapter not initialized" });
    return;
  }

  adapter.process(req, res, async (context) => {
    if (context.activity.type !== ActivityTypes.Message) {
      return;
    }

    const channelId = context.activity.channelId ?? "unknown-channel";
    const conversationId = context.activity.conversation?.id ?? "unknown-conversation";
    const userId = context.activity.from?.id ?? "unknown-user";
    const userText = (context.activity.text ?? "").trim();
    const activityForProactive = context.activity;
    const stopStreamingIndicators = await sendStreamingTypingIndicators(context);
    const conversationKey = `${channelId}|${conversationId}|${userId}`;

    const ackChannels = new Set(["directline", "msteams", "webchat"]);
    const useAsyncAckFlow = ackChannels.has(channelId);
    const botAppId = process.env.MicrosoftAppId ?? "";

    if (useAsyncAckFlow && botAppId && adapter) {
      try {
        const reference = TurnContext.getConversationReference(activityForProactive);
        streamForwardState.set(conversationKey, {
          channelId,
          botAppId,
          reference,
          queue: Promise.resolve(),
          closed: false
        });

        // The in-turn typing loop cannot continue once this turn exits.
        // Use proactive typing so users still see progress until final reply.
        stopStreamingIndicators();
        void (async () => {
          const stopProactiveTyping = startProactiveTypingIndicators(adapter!, botAppId, reference);
          try {
            const reply = await routeMessageToBackend({
              channelId,
              conversationId,
              userId,
              userText
            });

            await adapter!.continueConversationAsync(botAppId, reference, async (proactiveContext) => {
              await sendActivityWithLog(
                proactiveContext,
                reply.text,
                "api/messages",
                reply.stopReason
              );
            });
            stopStreamUpdateForwarding(conversationKey);
          } catch (error) {
            const diagnostics = getBackendErrorDiagnostics(error);
            console.error("Backend communication failed (async ack flow)", {
              error,
              errorSource: diagnostics.source,
              errorMessage: diagnostics.rawMessage,
              timeoutMethod: diagnostics.timeoutMethod,
              wsInitialized,
              wsReady: wsCoordinator?.isReady() ?? false,
              channelId,
              conversationId,
              userId
            });

            await adapter!.continueConversationAsync(botAppId, reference, async (proactiveContext) => {
              await sendActivityWithLog(
                proactiveContext,
                diagnostics.userMessage,
                "api/messages"
              );
            });
            stopStreamUpdateForwarding(conversationKey);
          } finally {
            stopProactiveTyping();
            streamForwardState.delete(conversationKey);
            replenishPreparedPoolIfClaimed(conversationKey);
          }
        })();
      } finally {
        // Stopped above before async work starts.
      }

      return;
    }

    try {
      const reply = await routeMessageToBackend({
        channelId,
        conversationId,
        userId,
        userText
      });

      await sendActivityWithLog(
        context,
        reply.text,
        "api/messages",
        reply.stopReason
      );
    } catch (error) {
      const diagnostics = getBackendErrorDiagnostics(error);
      console.error("Backend communication failed", {
        error,
        errorSource: diagnostics.source,
        errorMessage: diagnostics.rawMessage,
        timeoutMethod: diagnostics.timeoutMethod,
        wsInitialized,
        wsReady: wsCoordinator?.isReady() ?? false,
        channelId,
        conversationId,
        userId
      });

      const errorMessage = diagnostics.userMessage;

      await sendActivityWithLog(
        context,
        errorMessage,
        "api/messages"
      );
    } finally {
      stopStreamingIndicators();
      replenishPreparedPoolIfClaimed(conversationKey);
    }
  });
});

// ─── Dev-only simulation endpoint (no Bot Framework auth) ───────────────────
// Enabled when NODE_ENV=development. Accepts a plain JSON body:
//   { "text": "...", "conversationId": "...", "userId": "...", "channelId": "..." }
// Returns: { "text": "..." }
// NOT available in production.
if (process.env.NODE_ENV === "development") {
  app.post("/api/simulate", async (req, res) => {
    const userText       = (req.body?.text ?? "").trim();
    const conversationId = (req.body?.conversationId ?? "sim-default").trim();
    const userId         = (req.body?.userId ?? "sim-user").trim();
    const channelId      = (req.body?.channelId ?? "simulation").trim();
    const conversationKey = `${channelId}|${conversationId}|${userId}`;

    if (!userText) {
      res.status(400).json({ error: "text is required" });
      return;
    }

    try {
      if (!wsInitialized || !wsCoordinator?.isReady()) {
        await ensureWebSocketReady();
      }

      if (!wsCoordinator) {
        throw new Error("WebSocket coordinator not initialized");
      }

      const sessionId = await wsCoordinator.ensureSession(conversationKey);
      const response  = await wsCoordinator.sendMessage(conversationKey, sessionId, userText);

      let replyText = response.text;
      if (!replyText) {
        replyText = response.hasErrors
          ? `Error: ${response.error?.message ?? "Unknown error"}`
          : `(${response.stopReason})`;
      }

      res.status(200).json({ text: replyText, stopReason: response.stopReason });
    } catch (error) {
      console.error("Simulation endpoint error", { error, conversationKey });
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: message });
    } finally {
      replenishPreparedPoolIfClaimed(conversationKey);
    }
  });

  // ─── Dev endpoint for full Bot Framework Activities (no JWT required) ──────────
  // Accepts complete Activity objects as sent by Teams (for realistic simulation)
  // Returns: { "text": "..." }
  app.post("/api/dev/messages", async (req, res) => {
    const activity = req.body;

    if (!activity?.type) {
      res.status(400).json({ error: "Activity type is required" });
      return;
    }

    // Handle ConversationUpdate (member join/leave)
    if (activity.type === "conversationUpdate") {
      console.log(`[DEV] ConversationUpdate: ${activity.conversation?.id}`);
      res.status(200).json({ text: "Conversation updated" });
      return;
    }

    // Handle EndOfConversation (close)
    if (activity.type === "endOfConversation") {
      console.log(`[DEV] EndOfConversation: ${activity.conversation?.id}`);
      res.status(200).json({ text: "Conversation ended" });
      return;
    }

    // Handle Message
    if (activity.type !== "message") {
      if (activity.type === "typing") {
        res.status(200).json({});
        return;
      }

      res.status(400).json({ error: `Unsupported activity type: ${activity.type}` });
      return;
    }

    const userText = (activity.text ?? "").trim();
    if (!userText) {
      res.status(400).json({ error: "Message text is required" });
      return;
    }

    const channelId    = activity.channelId ?? "msteams";
    const conversationId = activity.conversation?.id ?? "dev-conversation";
    const userId       = activity.from?.id ?? "dev-user";
    const conversationKey = `${channelId}|${conversationId}|${userId}`;

    if (adapter) {
      adapter.process(req, res, async (context) => {
        if (context.activity.type !== ActivityTypes.Message) {
          return;
        }

        const stopStreamingIndicators = await sendStreamingTypingIndicators(context);

        try {
          const reply = await buildConversationReply({
            channelId,
            conversationId,
            userId,
            userText
          });

          await sendActivityWithLog(
            context,
            reply.text,
            "api/dev/messages",
            reply.stopReason
          );
        } catch (error) {
          console.error("[DEV] Message endpoint error", {
            error,
            conversationKey
          });

          const message = error instanceof Error ? error.message : String(error);
          await sendActivityWithLog(
            context,
            message,
            "api/dev/messages"
          );
        } finally {
          stopStreamingIndicators();
          replenishPreparedPoolIfClaimed(conversationKey);
        }
      });
      return;
    }

    try {
      if (!wsInitialized || !wsCoordinator?.isReady()) {
        await ensureWebSocketReady();
      }

      if (!wsCoordinator) {
        throw new Error("WebSocket coordinator not initialized");
      }

      const sessionId = await wsCoordinator.ensureSession(conversationKey);
      const response  = await wsCoordinator.sendMessage(conversationKey, sessionId, userText);

      let replyText = response.text;
      if (!replyText) {
        replyText = response.hasErrors
          ? `Error: ${response.error?.message ?? "Unknown error"}`
          : `(${response.stopReason})`;
      }

      res.status(200).json({ text: replyText, stopReason: response.stopReason });
    } catch (error) {
      console.error("[DEV] Message endpoint error", { error, conversationKey });
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: message });
    } finally {
      replenishPreparedPoolIfClaimed(conversationKey);
    }
  });

  console.log("DEV mode: full Activity endpoint enabled at POST /api/dev/messages");
}

// Graceful shutdown
process.on("SIGTERM", async () => {
  console.log("SIGTERM received, shutting down gracefully...");
  if (wsCoordinator) {
    // Cancel any pending permission requests
    const permMgr = wsCoordinator.getPermissionManager();
    permMgr.cancelAllRequests();

    await wsCoordinator.shutdown();
  }
  process.exit(0);
});

app.listen(config.port, () => {
  console.log(`Bot runtime listening on port ${config.port}`);
  void initializeWebSocketOnStartup();
});
