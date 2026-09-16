import { WebSocketManager } from "./websocketManager";
import { config } from "./config";
import { SessionStore, SessionRecord } from "./sessionStore";
import { StreamingResponseHandler } from "./streamingResponseHandler";
import { PermissionRequestManager } from "./permissionRequestManager";
import { PreparedSessionPool } from "./preparedSessionPool";
import { logSessionLifecycleEvent } from "./logger";
import {
  InitializeResult,
  SessionNewResult,
  SessionLoadResult,
  SessionResumeResult,
  SessionConfigResult,
  SessionPromptResult,
  SessionUpdate,
  PermissionRequest
} from "./types/websocket";

/**
 * WebSocket Session Coordinator
 *
 * Manages the complete lifecycle of a backend session:
 * 1. Initialize protocol handshake
 * 2. Authentication (if required)
 * 3. Create/load/resume session
 * 4. Configure agent options
 * 5. Send prompts and receive responses
 * 6. Handle server-initiated messages
 */
export class WebSocketSessionCoordinator {
  private manager: WebSocketManager | null = null;
  private sessionStore: SessionStore;
  private permissionManager: PermissionRequestManager;
  private isInitialized: boolean = false;
  private protocolVersion: number = 1;
  private supportedAuthMethods: string[] = [];
  private responseHandlers: Map<string, StreamingResponseHandler> = new Map();
  private warmupResponseHandlers: Map<string, StreamingResponseHandler> = new Map();
  private preparedSessionInitialResponses: Map<string, string> = new Map();
  private sessionToConversationMap: Map<string, string> = new Map(); // sessionId -> conversationKey
  private preparedSessionIds: Set<string> = new Set();
  private preparedSessionPool?: PreparedSessionPool;
  private updateCallback?: (conversationKey: string, update: SessionUpdate) => void;
  private permissionCallback?: (conversationKey: string, request: PermissionRequest) => Promise<"approved" | "cancelled" | "denied">;
  private legacyMissingSessionIdCount: number = 0;
  private legacyMissingSessionIdLastLogAt: number = 0;
  /**
   * Session-setup capability flags, normalized from whichever protocol
   * shape (v1 or v2) the backend's initialize response used. See
   * InitializeResult for the exact shape differences.
   */
  private supportsLoadSession: boolean = false;
  private supportsResumeSession: boolean = false;
  private supportsCloseSession: boolean = false;
  /**
   * Conversation keys whose current turn claimed a session from the prepared
   * pool and therefore owe the pool a deferred replenishment. Populated in
   * ensureSession() when a claim is bound, and drained (once) via
   * consumeClaimedFromPool() by the caller after the user-visible reply has
   * actually been delivered - not immediately, so the pool's session/new +
   * warmup session/prompt never race the real prompt this claim is serving.
   */
  private pendingPoolReplenishment: Set<string> = new Set();

  private shouldIgnoreUnmappedSessionUpdate(update: SessionUpdate): boolean {
    // session/update can arrive before the session/new response is processed,
    // especially for background warmup/prepared sessions.
    if (this.responseHandlers.size === 0) {
      return true;
    }

    return update.sessionUpdate === "session_state_change"
      || update.sessionUpdate === "available_commands_update"
      || update.sessionUpdate === "config_option_update";
  }

  constructor(sessionStore: SessionStore) {
    this.sessionStore = sessionStore;
    this.permissionManager = new PermissionRequestManager();
    this.preparedSessionPool = new PreparedSessionPool({
      enabled: config.preparedSessionEnabled,
      poolSize: config.preparedSessionPoolSize,
      maxAgeMs: config.preparedSessionMaxAgeMs,
      backgroundRetryMs: config.preparedSessionBackgroundRetryMs,
      createPreparedSession: async () => {
        const preparedSessionId = await this.createPreparedSessionInternal();
        return preparedSessionId;
      },
      onEvent: (event, details) => {
        const payload = details ? details : {};
        if ((event === "expired" || event === "invalidated") && typeof payload.sessionId === "string") {
          this.preparedSessionIds.delete(payload.sessionId);
        }

        logSessionLifecycleEvent({
          event,
          sessionId: typeof payload.sessionId === "string" ? payload.sessionId : undefined,
          sourceSessionId: typeof payload.sourceSessionId === "string" ? payload.sourceSessionId : undefined,
          conversationKey: typeof payload.conversationKey === "string" ? payload.conversationKey : undefined,
          poolSize: typeof payload.poolSize === "number" ? payload.poolSize : undefined,
          ageMs: typeof payload.ageMs === "number" ? payload.ageMs : undefined,
          remainingPoolSize: typeof payload.remainingPoolSize === "number" ? payload.remainingPoolSize : undefined,
          sessionMode: typeof payload.sessionMode === "string" ? payload.sessionMode : undefined,
          stopReason: typeof payload.stopReason === "string" ? payload.stopReason : undefined,
          error: payload.error
        });
      },
      validateSession: async (sessionId: string) => this.validatePreparedSessionCandidate(sessionId),
      watchdogIntervalMs: config.preparedSessionWatchdogIntervalMs
    });
  }

  /**
   * Check whether a pooled prepared-session id is still recognized by the
   * backend. Uses session/resume to probe it.
   *
   * Backend resume semantics for an actively-loaded session are not fully
   * predictable across implementations - a healthy session can legitimately
   * reject resume for reasons unrelated to actually being gone (e.g.
   * "already loaded", or the backend not implementing session/resume at all
   * - a "Method not found" protocol error, which says nothing about the
   * session's liveness and must never be read as "session not found"). To
   * avoid discarding and re-warming a perfectly healthy session on an
   * ambiguous or protocol-level error, only treat resume failure as a
   * genuine "session is gone" signal when the backend explicitly reports the
   * session itself is missing/expired; any other error - including resume
   * being unsupported - is treated as still valid (fail open, not closed).
   */
  private async validatePreparedSessionCandidate(sessionId: string): Promise<boolean> {
    if (!this.manager) {
      return false;
    }

    if (!this.supportsResumeSession) {
      // The backend's advertised capabilities already told us session/resume
      // isn't available - don't waste a round trip (and risk another
      // ambiguous protocol error) on a method we know isn't supported.
      // Trust the session; it's still sitting untouched in the pool.
      return true;
    }

    try {
      await this.manager.sessionResume(sessionId);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      if (this.isResumeUnsupportedError(message)) {
        // The backend doesn't implement session/resume at all (or requires a
        // different call for this state) - this is a protocol capability
        // gap, not a signal that the session died. Trust the session.
        return true;
      }

      const definitelyGone = /session .*(not found|does not exist|expired)|unknown session|no such session|invalid session/i.test(message);

      if (definitelyGone) {
        console.warn(`Prepared session ${sessionId} failed validation (treated as gone): ${message}`);
        return false;
      }

      return true;
    }
  }

  /**
   * Initialize connection and handshake with backend
   */
  async initialize(manager: WebSocketManager): Promise<void> {
    this.manager = manager;

    // Register event listeners for server-pushed messages
    this.manager.on("session/update", (update: SessionUpdate) => {
      // Preferred routing: backend supplies sessionId for isolation.
      if (update.sessionId) {
        const warmupHandler = this.warmupResponseHandlers.get(update.sessionId);
        if (warmupHandler) {
          warmupHandler.handleUpdate(update);
          return;
        }

        const conversationKey = this.sessionToConversationMap.get(update.sessionId);
        if (conversationKey) {
          const handler = this.responseHandlers.get(conversationKey);
          if (handler) {
            handler.handleUpdate(update);
          }

          if (this.updateCallback) {
            this.updateCallback(conversationKey, update);
          }
        } else {
          if (this.preparedSessionIds.has(update.sessionId)) {
            return;
          }

          if (this.shouldIgnoreUnmappedSessionUpdate(update)) {
            return;
          }

          console.warn(`No conversation mapping found for sessionId=${update.sessionId}`);
        }

        return;
      }

      // Legacy fallback: older backends may not send sessionId.
      // Keep backward compatibility, but throttle warnings because
      // chunk-heavy responses can generate a very high volume.
      this.legacyMissingSessionIdCount++;
      const now = Date.now();
      const shouldLog = this.legacyMissingSessionIdCount <= 3 || (now - this.legacyMissingSessionIdLastLogAt) >= 30000;
      if (shouldLog) {
        this.legacyMissingSessionIdLastLogAt = now;
        console.warn(
          `session/update missing sessionId; using legacy broadcast routing (count=${this.legacyMissingSessionIdCount}, updateType=${update.sessionUpdate}, activeConversations=${this.responseHandlers.size})`
        );
      }

      for (const [conversationKey, handler] of this.responseHandlers.entries()) {
        handler.handleUpdate(update);

        if (this.updateCallback) {
          this.updateCallback(conversationKey, update);
        }
      }
    });

    this.manager.on("session/request_permission", async (data: any) => {
      const requestId = data.id;
      const request: PermissionRequest = data.params;

      try {
        // Use permission manager to handle the request
        const outcome = await this.permissionManager.handlePermissionRequest(requestId, request);

        // Send response back to backend
        if (this.manager) {
          await this.manager.sendPermissionResponse(requestId, outcome);
        }
      } catch (error) {
        console.error("Permission request error:", error);
        // Send denial on error
        if (this.manager) {
          await this.manager.sendPermissionResponse(requestId, "denied");
        }
      }
    });

    // Re-initialize automatically after reconnection
    this.manager.on("reconnected", async () => {
      console.log("WebSocket reconnected - re-initializing handshake...");
      this.isInitialized = false;

      try {
        const result = await this.manager!.initialize(this.protocolVersion);
        this.handleInitializeResult(result);
        this.isInitialized = true;
        // The transport reconnected on its own (no chat request triggered this).
        // Re-validate the pooled session(s) known before the drop via
        // session/resume and reuse them without re-warming when the backend
        // still recognizes them; only genuinely lost sessions are replaced.
        await this.preparedSessionPool?.onReconnect();
        console.log("WebSocket re-initialization successful");
      } catch (error) {
        console.error("WebSocket re-initialization failed:", error);
        // scheduleReconnect will retry the whole connection
      }
    });

    // Run initialize handshake
    try {
      const result = await this.manager.initialize(this.protocolVersion);
      this.handleInitializeResult(result);
      this.isInitialized = true;
      await this.preparedSessionPool?.initialize();
      console.log("WebSocket initialization successful");
    } catch (error) {
      console.error("WebSocket initialization failed:", error);
      throw error;
    }
  }

  /**
   * Handle initialize response
   *
   * Normalizes v1 (`agentCapabilities.loadSession` /
   * `agentCapabilities.sessionCapabilities.{resume,close}`) and v2
   * (`capabilities.session` presence implies resume/close are baseline,
   * and session/load does not exist) into simple flags used to pick a
   * fail-safe reattachment strategy without guessing which version is live.
   */
  private handleInitializeResult(result: InitializeResult): void {
    this.protocolVersion = result.protocolVersion;
    this.supportedAuthMethods = result.authMethods?.map(m => m.id) || [];

    const v2Session = result.capabilities?.session;
    if (v2Session !== undefined && v2Session !== null) {
      this.supportsResumeSession = true;
      this.supportsCloseSession = true;
      this.supportsLoadSession = false;
      return;
    }

    const v1Caps = result.agentCapabilities;
    this.supportsLoadSession = v1Caps?.loadSession === true;
    this.supportsResumeSession = Boolean(v1Caps?.sessionCapabilities?.resume);
    this.supportsCloseSession = Boolean(v1Caps?.sessionCapabilities?.close);
  }

  private async applyDefaultSessionConfig(conversationKey: string, sessionId: string): Promise<void> {
    const configOptions: Array<{ configId: string; value: string }> = [];

    if (config.websocketAgentName) {
      configOptions.push({ configId: "agent", value: config.websocketAgentName });
    } else if (config.websocketModelName) {
      // Backward-compatible fallback for backends that still expect model config.
      configOptions.push({ configId: "model", value: config.websocketModelName });
    }

    for (const option of configOptions) {
      try {
        await this.configureSession(conversationKey, sessionId, option.configId, option.value);
      } catch (error) {
        console.warn(`Default session config ${option.configId} could not be applied for ${sessionId}; continuing without it: ${error}`);
      }
    }
  }

  private async createPreparedSessionInternal(): Promise<string> {
    if (!this.manager || !this.isInitialized) {
      throw new Error("WebSocket not initialized");
    }

    const result = await this.manager.sessionNew("/workspace");
    this.preparedSessionIds.add(result.sessionId);

    try {
      await this.applyDefaultSessionConfig("prepared-session", result.sessionId);
      await this.warmupPreparedSession(result.sessionId);
      return result.sessionId;
    } catch (error) {
      try {
        if (this.manager?.isReady()) {
          await this.manager.sessionDestroy(result.sessionId);
        } else {
          console.warn(`Skipping destroy for prepared session after warmup/config failure because WebSocket is disconnected (${result.sessionId})`);
        }
      } catch (destroyError) {
        console.warn(`Failed to destroy prepared session after warmup/config failure (${result.sessionId}): ${destroyError}`);
      }

      this.preparedSessionIds.delete(result.sessionId);
      throw error;
    }
  }

  private async warmupPreparedSession(sessionId: string): Promise<void> {
    const prompt = config.warmupSessionInitialPrompt;
    if (!prompt) {
      return;
    }

    if (!this.manager) {
      throw new Error("WebSocket manager unavailable for warmup prompt");
    }

    logSessionLifecycleEvent({
      event: "warmup-started",
      sessionId
    });

    const warmupHandler = new StreamingResponseHandler();
    this.warmupResponseHandlers.set(sessionId, warmupHandler);

    let result: SessionPromptResult;
    try {
      result = await this.manager.sessionPrompt(sessionId, prompt);
    } finally {
      this.warmupResponseHandlers.delete(sessionId);
    }

    if (result.stopReason === "error") {
      const exitCode = typeof result.exitCode === "number" ? result.exitCode : "unknown";
      logSessionLifecycleEvent({
        event: "warmup-failed",
        sessionId,
        stopReason: result.stopReason,
        error: `stopReason=error; exitCode=${exitCode}`
      });
      throw new Error(`Prepared session warmup prompt failed (exitCode=${exitCode})`);
    }

    const warmupText = warmupHandler.getResponse().text;
    if (warmupText) {
      this.preparedSessionInitialResponses.set(sessionId, warmupText);
    }

    logSessionLifecycleEvent({
      event: "warmup-completed",
      sessionId,
      stopReason: result.stopReason
    });
  }

  /**
   * Create a new session for a conversation
   */
  async createSession(conversationKey: string, cwd: string = "/workspace"): Promise<string> {
    if (!this.manager || !this.isInitialized) {
      throw new Error("WebSocket not initialized");
    }

    try {
      // Ensure the conversation key exists in the store before we update it
      this.sessionStore.getOrCreate(conversationKey);

      const result = await this.manager.sessionNew(cwd);
      const sessionId = result.sessionId;

      await this.applyDefaultSessionConfig(conversationKey, sessionId);

      // Update session store
      this.sessionStore.setSessionId(conversationKey, sessionId, "new");
      this.sessionToConversationMap.set(sessionId, conversationKey);

      this.sessionStore.setCapabilities(conversationKey, {
        authMethods: this.supportedAuthMethods,
        loadSession: true,
        persistSession: false
      });

      console.log(`Session created: ${sessionId} for ${conversationKey}`);
      return sessionId;
    } catch (error) {
      this.sessionStore.setError(conversationKey, `Failed to create session: ${error}`);
      throw error;
    }
  }

  /**
   * Load an existing session
   */
  async loadSession(conversationKey: string, sessionId: string, cwd: string = "/workspace"): Promise<string> {
    if (!this.manager || !this.isInitialized) {
      throw new Error("WebSocket not initialized");
    }

    try {
      const result = await this.manager.sessionLoad(sessionId, cwd);

      // Update session store
      this.sessionStore.setSessionId(conversationKey, result.sessionId, "loaded");
      this.sessionToConversationMap.set(result.sessionId, conversationKey);

      console.log(`Session loaded: ${result.sessionId} for ${conversationKey}`);
      return result.sessionId;
    } catch (error) {
      this.sessionStore.setError(conversationKey, `Failed to load session: ${error}`);
      throw error;
    }
  }

  /**
   * Resume an existing session, falling back to load/create when the backend does not support resume.
   */
  async resumeSession(conversationKey: string, sessionId: string): Promise<string> {
    if (!this.manager || !this.isInitialized) {
      throw new Error("WebSocket not initialized");
    }

    try {
      const result = await this.manager.sessionResume(sessionId);

      // Update session store
      this.sessionStore.setSessionId(conversationKey, result.sessionId, "resumed");
      this.sessionToConversationMap.set(result.sessionId, conversationKey);

      console.log(`Session resumed: ${result.sessionId} for ${conversationKey}`);
      return result.sessionId;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (this.isResumeUnsupportedError(message)) {
        try {
          const result = await this.manager.sessionLoad(sessionId, "/workspace");
          this.sessionStore.setSessionId(conversationKey, result.sessionId, "loaded");
          this.sessionToConversationMap.set(result.sessionId, conversationKey);
          console.warn(`Session resume unsupported; loaded existing session instead: ${result.sessionId}`);
          return result.sessionId;
        } catch (loadError) {
          const loadMessage = loadError instanceof Error ? loadError.message : String(loadError);
          this.sessionStore.setError(conversationKey, `Failed to resume or load session: ${loadMessage}`);
          throw new Error(`Failed to resume or load session: ${loadMessage}`);
        }
      }

      this.sessionStore.setError(conversationKey, `Failed to resume session: ${message}`);
      throw error;
    }
  }

  private isResumeUnsupportedError(message: string): boolean {
    return /method not found|session\/resume|not supported|unsupported/i.test(message);
  }

  /**
   * Whether a session/prompt failure indicates the session simply isn't
   * currently active in backend memory (as opposed to some unrelated prompt
   * failure such as a timeout or tool error), so it's worth attempting
   * session/load to reattach it rather than immediately giving up on the
   * conversation.
   */
  private isSessionNotLoadedError(message: string): boolean {
    return /session .*(not found|not loaded|does not exist|expired)|unknown session|no such session|invalid session/i.test(message);
  }

  /**
   * Configure session option
   */
  async configureSession(conversationKey: string, sessionId: string, configId: string, value: string): Promise<void> {
    if (!this.manager || !this.isInitialized) {
      throw new Error("WebSocket not initialized");
    }

    try {
      await this.manager.setConfigOption(sessionId, configId, value);
      console.log(`Session ${sessionId} configured: ${configId} = ${value}`);
    } catch (error) {
      this.sessionStore.setError(conversationKey, `Failed to configure session: ${error}`);
      throw error;
    }
  }

  /**
   * Send user message to session and get response
   */
  async sendMessage(conversationKey: string, sessionId: string, userMessage: string): Promise<{
    text: string;
    stopReason: string;
    hasErrors: boolean;
    error?: { code: string; message: string };
  }> {
    if (!this.manager || !this.isInitialized) {
      throw new Error("WebSocket not initialized");
    }

    try {
      const session = this.sessionStore.get(conversationKey);
      if (!session) {
        throw new Error(`Session not found: ${conversationKey}`);
      }

      this.sessionStore.touch(conversationKey);

      if (session.sessionState !== "ready") {
        throw new Error(`Session not ready: state=${session.sessionState}`);
      }

      // Get or create response handler for this conversation
      let handler = this.responseHandlers.get(conversationKey);
      if (!handler) {
        handler = new StreamingResponseHandler();
        this.responseHandlers.set(conversationKey, handler);
      }

      // Reset handler for new message
      handler.reset();

      // Send prompt and wait for response (session/update messages arrive during this call)
      let result: SessionPromptResult;
      try {
        result = await this.manager.sessionPrompt(sessionId, userMessage);
      } catch (promptError) {
        const message = promptError instanceof Error ? promptError.message : String(promptError);

        if (this.isSessionNotLoadedError(message)) {
          // The backend keeps sessions on disk, but this one is not currently
          // active in backend memory (e.g. after a WebSocket reconnect or a
          // backend restart) even though the conversation's sessionId is
          // still valid. Every chat message on an existing conversation
          // should resume that same live session rather than silently
          // losing it. The correct reattachment method depends on the
          // negotiated protocol version: v2 removed session/load and folds
          // full-history reattachment into session/resume via replayFrom,
          // while v1 backends without resume support use session/load
          // instead. When capabilities are unclear, try resume first and
          // fall back to load - either one restores the same conversation.
          console.warn(`Session ${sessionId} not currently loaded; resuming it and retrying: ${message}`);

          if (this.supportsResumeSession) {
            await this.manager.sessionResume(sessionId, "/workspace", [], { type: "start" });
          } else if (this.supportsLoadSession) {
            await this.manager.sessionLoad(sessionId, "/workspace");
          } else {
            try {
              await this.manager.sessionResume(sessionId, "/workspace", [], { type: "start" });
            } catch {
              await this.manager.sessionLoad(sessionId, "/workspace");
            }
          }

          result = await this.manager.sessionPrompt(sessionId, userMessage);
        } else {
          throw promptError;
        }
      }

      // Get buffered response
      const response = handler.getResponse();
      const preparedInitialResponse = this.preparedSessionInitialResponses.get(sessionId);
      if (preparedInitialResponse) {
        response.text = response.text.startsWith(preparedInitialResponse)
          ? response.text.slice(preparedInitialResponse.length)
          : response.text;
        this.preparedSessionInitialResponses.delete(sessionId);
      }

      // Clean up handler after getting response
      if (response.text.length === 0) {
        this.responseHandlers.delete(conversationKey);
      }

      // Update session state based on result
      if (result.stopReason === "error") {
        this.sessionStore.setError(conversationKey, `Prompt error: ${result.exitCode}`);
        return {
          text: response.text || `Backend error (exit code: ${result.exitCode})`,
          stopReason: "error",
          hasErrors: true,
          error: response.errors.length > 0 ? response.errors[0] : undefined
        };
      }

      return {
        text: response.text,
        stopReason: result.stopReason,
        hasErrors: response.errors.length > 0,
        error: response.errors.length > 0 ? response.errors[0] : undefined
      };
    } catch (error) {
      this.sessionStore.setError(conversationKey, `Failed to send message: ${error}`);
      throw error;
    }
  }

  /**
   * Get or ensure session is initialized for a conversation
   */
  async ensureSession(conversationKey: string): Promise<string> {
    let session = this.sessionStore.get(conversationKey);

    if (session && this.sessionStore.isExpired(conversationKey, config.websocketSessionTtlMs)) {
      console.log(`Session TTL expired for ${conversationKey}; creating a new session`);
      try {
        if (session.sessionId) {
          await this.manager?.sessionDestroy(session.sessionId);
        }
      } catch {
        // Ignore cleanup errors and continue with local reset.
      }
      this.sessionStore.resetToNew(conversationKey);
      session = this.sessionStore.get(conversationKey);
    }

    // Session already initialized and ready
    if (session?.sessionId && session.sessionState === "ready") {
      this.sessionToConversationMap.set(session.sessionId, conversationKey);
      this.sessionStore.touch(conversationKey);
      return session.sessionId;
    }

    // Session exists but failed - try to clean up and create new
    if (session && session.sessionState === "error") {
      try {
        if (session.sessionId) {
          await this.manager?.sessionDestroy(session.sessionId);
        }
      } catch (e) {
        // Ignore cleanup errors
      }
      this.sessionStore.resetToNew(conversationKey);
      session = this.sessionStore.get(conversationKey);
    }

    // Create new session
    if (!session || session.sessionState === "new") {
      const shouldUsePreparedSession = session === undefined;
      if (shouldUsePreparedSession) {
        const preparedSessionId = await this.preparedSessionPool?.claimPreparedSession();
        if (preparedSessionId) {
          this.preparedSessionIds.delete(preparedSessionId);

          // The prepared session was created (session/new) and warmed up (session/prompt)
          // on this same live backend connection, so it is already active/loaded on the
          // backend. No resume/load call is needed or valid here - calling session/resume
          // on an already-active session returns an "already loaded" error from the backend.
          // Bind the conversation directly to the prepared session id so the claimed
          // session keeps the exact same id and becomes the live session for this
          // conversation.
          const sessionRecord = this.sessionStore.getOrCreate(conversationKey);
          sessionRecord.sessionId = preparedSessionId;
          sessionRecord.sessionMode = "prepared";
          sessionRecord.sessionState = "ready";
          sessionRecord.initializedAt = Date.now();
          this.sessionToConversationMap.set(preparedSessionId, conversationKey);
          this.pendingPoolReplenishment.add(conversationKey);
          logSessionLifecycleEvent({
            event: "prepared-session-bound",
            sessionId: preparedSessionId,
            sourceSessionId: preparedSessionId,
            conversationKey,
            sessionMode: "prepared"
          });
          return preparedSessionId;
        }
      }

      return this.createSession(conversationKey);
    }

    throw new Error(`Unexpected session state: ${session.sessionState}`);
  }

  /**
   * Cleanup: destroy session on backend
   */
  async destroySession(conversationKey: string): Promise<void> {
    const session = this.sessionStore.get(conversationKey);
    if (!session?.sessionId || !this.manager) {
      return;
    }

    try {
      await this.manager.sessionDestroy(session.sessionId);
      console.log(`Session destroyed: ${session.sessionId}`);
    } catch (error) {
      console.error(`Failed to destroy session ${session.sessionId}:`, error);
    }
  }

  /**
   * Register callback for permission requests
   * Callback will be invoked when backend requests a permission
   */
  onPermissionRequest(callback: (permission: PermissionRequest) => Promise<"approved" | "cancelled" | "denied">): void {
    this.permissionManager.setExternalHandler(callback);
  }

  /**
   * Register callback for session updates flowing from upstream.
   */
  onSessionUpdate(callback: (conversationKey: string, update: SessionUpdate) => void): void {
    this.updateCallback = callback;
  }

  /**
   * Get permission manager (for direct access if needed)
   */
  getPermissionManager(): PermissionRequestManager {
    return this.permissionManager;
  }

  /**
   * Re-run the initialize handshake without re-registering event listeners.
   * Called when the WebSocket has reconnected but the protocol handshake needs to repeat.
   */
  async reInitializeHandshake(): Promise<void> {
    if (!this.manager) {
      throw new Error("No WebSocket manager attached");
    }
    this.isInitialized = false;
    const result = await this.manager.initialize(this.protocolVersion);
    this.handleInitializeResult(result);
    this.isInitialized = true;
    await this.preparedSessionPool?.onReconnect();
    console.log("WebSocket re-initialization handshake successful");
  }

  /**
   * Check if coordinator is ready
   */
  isReady(): boolean {
    return this.isInitialized && this.manager?.isReady() === true;
  }

  /**
   * Disconnect and cleanup
   */
  async shutdown(): Promise<void> {
    if (this.manager) {
      await this.manager.disconnect();
      this.manager = null;
    }
    this.isInitialized = false;
  }

  /**
   * Get session info (for debugging)
   */
  getSessionInfo(conversationKey: string): SessionRecord | undefined {
    return this.sessionStore.get(conversationKey);
  }

  async triggerPreparedSessionReplenishmentAfterSuccess(): Promise<void> {
    await this.preparedSessionPool?.scheduleReplenishmentAfterSuccess();
  }

  /**
   * Returns true (once) if the given conversation's current turn claimed a
   * session from the prepared pool and hasn't yet had its deferred
   * replenishment triggered. Callers should invoke this after the
   * user-visible reply for that turn has been sent, and if it returns true,
   * follow up with triggerPreparedSessionReplenishmentAfterSuccess().
   */
  consumeClaimedFromPool(conversationKey: string): boolean {
    return this.pendingPoolReplenishment.delete(conversationKey);
  }

  getPreparedSessionPoolSnapshot() {
    return this.preparedSessionPool?.getSnapshot();
  }
}
