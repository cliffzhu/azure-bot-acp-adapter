import test from "node:test";
import assert from "node:assert/strict";
import { WebSocketSessionCoordinator } from "../src/websocketSessionCoordinator";
import { SessionStore } from "../src/sessionStore";
import { config } from "../src/config";

test("sendMessage resumes an existing session via session/load and retries when the backend reports it isn't loaded", async () => {
  const store = new SessionStore();
  const conversationKey = "conv-resume";
  const record = store.getOrCreate(conversationKey);
  record.sessionId = "existing-session";
  record.sessionState = "ready";
  record.sessionMode = "prepared";

  const coordinator = new WebSocketSessionCoordinator(store);
  const calls: string[] = [];

  const manager = {
    sessionPrompt: async () => {
      if (calls.filter((c) => c === "prompt").length === 0) {
        calls.push("prompt");
        throw new Error("Session existing-session not found");
      }
      calls.push("prompt");
      return { stopReason: "completion" as const };
    },
    sessionLoad: async (sessionId: string) => {
      calls.push(`load:${sessionId}`);
      return { sessionId };
    },
    sessionResume: async () => ({ sessionId: "unused" }),
    sessionNew: async () => ({ sessionId: "unused" }),
    setConfigOption: async () => undefined,
    sessionDestroy: async () => undefined
  };

  (coordinator as any).manager = manager;
  (coordinator as any).isInitialized = true;
  (coordinator as any).supportsLoadSession = true;

  const response = await coordinator.sendMessage(conversationKey, "existing-session", "hello");

  assert.equal(response.stopReason, "completion");
  assert.deepEqual(calls, ["prompt", "load:existing-session", "prompt"]);
});

test("sendMessage does not attempt session/load for an unrelated prompt failure", async () => {
  const store = new SessionStore();
  const conversationKey = "conv-unrelated-error";
  const record = store.getOrCreate(conversationKey);
  record.sessionId = "existing-session";
  record.sessionState = "ready";
  record.sessionMode = "prepared";

  const coordinator = new WebSocketSessionCoordinator(store);
  const calls: string[] = [];

  const manager = {
    sessionPrompt: async () => {
      calls.push("prompt");
      throw new Error("Request timeout for method \"session/prompt\"");
    },
    sessionLoad: async (sessionId: string) => {
      calls.push(`load:${sessionId}`);
      return { sessionId };
    },
    sessionResume: async () => ({ sessionId: "unused" }),
    sessionNew: async () => ({ sessionId: "unused" }),
    setConfigOption: async () => undefined,
    sessionDestroy: async () => undefined
  };

  (coordinator as any).manager = manager;
  (coordinator as any).isInitialized = true;

  await assert.rejects(
    async () => coordinator.sendMessage(conversationKey, "existing-session", "hello"),
    /Request timeout/
  );

  assert.deepEqual(calls, ["prompt"]);
});

test("ensureSession restores routing for a ready session after coordinator recreation", async () => {
  const store = new SessionStore();
  const conversationKey = "conv-restored-routing";
  const record = store.getOrCreate(conversationKey);
  record.sessionId = "existing-session";
  record.sessionState = "ready";

  const coordinator = new WebSocketSessionCoordinator(store);
  const sessionId = await coordinator.ensureSession(conversationKey);

  assert.equal(sessionId, "existing-session");
  assert.equal(
    (coordinator as any).sessionToConversationMap.get("existing-session"),
    conversationKey
  );
});

test("resumeSessionWithFallback uses session/load when session/resume is unsupported", async () => {
  const coordinator = new WebSocketSessionCoordinator(new SessionStore());
  const calls: string[] = [];

  const manager = {
    sessionResume: async () => {
      calls.push("resume");
      throw new Error('[-32601] "Method not found": session/resume');
    },
    sessionLoad: async (sessionId: string) => {
      calls.push(`load:${sessionId}`);
      return { sessionId };
    },
    sessionNew: async () => ({ sessionId: "fresh-session" }),
    setConfigOption: async () => undefined,
    sessionPrompt: async () => ({ stopReason: "completion" as const }),
    sessionDestroy: async () => undefined
  };

  (coordinator as any).manager = manager;
  (coordinator as any).isInitialized = true;

  const resumedSessionId = await coordinator.resumeSession("conv-1", "existing-session");

  assert.equal(resumedSessionId, "existing-session");
  assert.deepEqual(calls, ["resume", "load:existing-session"]);
});

test("ensureSession binds the claimed prepared session directly without calling resume or load", async () => {
  const coordinator = new WebSocketSessionCoordinator(new SessionStore());
  const calls: string[] = [];

  const manager = {
    sessionResume: async () => {
      calls.push("resume");
      throw new Error("should not be called");
    },
    sessionLoad: async () => {
      calls.push("load");
      throw new Error("should not be called");
    },
    sessionNew: async () => {
      calls.push("new");
      return { sessionId: "fresh-session" };
    },
    setConfigOption: async () => undefined,
    sessionPrompt: async () => ({ stopReason: "completion" as const }),
    sessionDestroy: async () => undefined
  };

  (coordinator as any).manager = manager;
  (coordinator as any).isInitialized = true;
  (coordinator as any).preparedSessionPool.claimPreparedSession = async () => "prepared-session";

  const sessionId = await coordinator.ensureSession("conv-2");

  assert.equal(sessionId, "prepared-session");
  assert.deepEqual(calls, []);
  // Claiming a prepared session must mark it for a deferred replenishment
  // trigger (fired only after the reply is sent), consumed exactly once.
  assert.equal(coordinator.consumeClaimedFromPool("conv-2"), true);
  assert.equal(coordinator.consumeClaimedFromPool("conv-2"), false);
});

test("ensureSession falls back to a fresh session when the prepared pool has nothing to claim", async () => {
  const coordinator = new WebSocketSessionCoordinator(new SessionStore());
  const calls: string[] = [];

  const manager = {
    sessionResume: async () => {
      calls.push("resume");
      throw new Error("should not be called");
    },
    sessionLoad: async () => {
      calls.push("load");
      throw new Error("should not be called");
    },
    sessionNew: async () => {
      calls.push("new");
      return { sessionId: "fresh-session" };
    },
    setConfigOption: async () => undefined,
    sessionPrompt: async () => ({ stopReason: "completion" as const }),
    sessionDestroy: async () => undefined
  };

  (coordinator as any).manager = manager;
  (coordinator as any).isInitialized = true;
  (coordinator as any).preparedSessionPool.claimPreparedSession = async () => undefined;

  const sessionId = await coordinator.ensureSession("conv-empty-pool");

  assert.equal(sessionId, "fresh-session");
  assert.deepEqual(calls, ["new"]);
});

test("ensureSession does not use the prepared-session pool for an existing conversation", async () => {
  const store = new SessionStore();
  const existing = store.getOrCreate("conv-3");
  existing.sessionState = "new";
  existing.sessionMode = undefined;
  existing.sessionId = undefined;

  const coordinator = new WebSocketSessionCoordinator(store);
  const calls: string[] = [];

  const manager = {
    sessionResume: async () => {
      calls.push("resume");
      throw new Error("should not be called");
    },
    sessionLoad: async () => {
      calls.push("load");
      throw new Error("should not be called");
    },
    sessionNew: async () => {
      calls.push("new");
      return { sessionId: "fresh-session-for-existing-conversation" };
    },
    setConfigOption: async () => undefined,
    sessionPrompt: async () => ({ stopReason: "completion" as const }),
    sessionDestroy: async () => undefined
  };

  (coordinator as any).manager = manager;
  (coordinator as any).isInitialized = true;
  (coordinator as any).preparedSessionPool.claimPreparedSession = async () => {
    throw new Error("prepared pool should not be used for an existing conversation");
  };

  const sessionId = await coordinator.ensureSession("conv-3");

  assert.equal(sessionId, "fresh-session-for-existing-conversation");
  assert.deepEqual(calls, ["new"]);
});

test("createPreparedSessionInternal still returns a session when default config is unsupported", async () => {
  const coordinator = new WebSocketSessionCoordinator(new SessionStore());
  const manager = {
    sessionNew: async () => ({ sessionId: "prepared-session-without-config" }),
    setConfigOption: async () => {
      throw new Error("unsupported config");
    },
    sessionResume: async () => ({ sessionId: "unused" }),
    sessionLoad: async () => ({ sessionId: "unused" }),
    sessionPrompt: async () => ({ stopReason: "completion" as const }),
    sessionDestroy: async () => undefined
  };

  (coordinator as any).manager = manager;
  (coordinator as any).isInitialized = true;

  const sessionId = await (coordinator as any).createPreparedSessionInternal();

  assert.equal(sessionId, "prepared-session-without-config");
});

test("createPreparedSessionInternal sends warmup prompt when configured", async () => {
  const coordinator = new WebSocketSessionCoordinator(new SessionStore());
  const calls: string[] = [];
  const originalPrompt = config.warmupSessionInitialPrompt;
  (config as any).warmupSessionInitialPrompt = "warmup prompt text";

  const manager = {
    sessionNew: async () => {
      calls.push("new");
      return { sessionId: "prepared-with-warmup" };
    },
    setConfigOption: async () => undefined,
    sessionPrompt: async (sessionId: string, prompt: string) => {
      calls.push(`prompt:${sessionId}:${prompt}`);
      (coordinator as any).warmupResponseHandlers.get(sessionId).handleUpdate({
        sessionId,
        sessionUpdate: "agent_message",
        content: { text: "warmup response" }
      });
      return { stopReason: "completion" as const };
    },
    sessionDestroy: async () => {
      calls.push("destroy");
      return undefined;
    },
    sessionResume: async () => ({ sessionId: "unused" }),
    sessionLoad: async () => ({ sessionId: "unused" })
  };

  (coordinator as any).manager = manager;
  (coordinator as any).isInitialized = true;

  try {
    const sessionId = await (coordinator as any).createPreparedSessionInternal();
    assert.equal(sessionId, "prepared-with-warmup");
    assert.equal(
      (coordinator as any).preparedSessionInitialResponses.get(sessionId),
      "warmup response"
    );
    assert.deepEqual(calls, ["new", "prompt:prepared-with-warmup:warmup prompt text"]);
  } finally {
    (config as any).warmupSessionInitialPrompt = originalPrompt;
  }
});

test("sendMessage removes the prepared session warmup response from the first user response", async () => {
  const store = new SessionStore();
  const conversationKey = "conv-warmup-history";
  const coordinator = new WebSocketSessionCoordinator(store);
  const warmupText = "Hi in Env";
  const record = store.getOrCreate(conversationKey);
  record.sessionId = "prepared-with-history";
  record.sessionState = "ready";
  record.sessionMode = "prepared";

  const manager = {
    sessionPrompt: async () => {
      (coordinator as any).responseHandlers.get(conversationKey).handleUpdate({
        sessionId: "prepared-with-history",
        sessionUpdate: "agent_message",
        content: { text: `${warmupText}User answer` }
      });
      return { stopReason: "completion" as const };
    }
  };

  (coordinator as any).manager = manager;
  (coordinator as any).isInitialized = true;
  (coordinator as any).preparedSessionInitialResponses.set("prepared-with-history", warmupText);

  const response = await coordinator.sendMessage(conversationKey, "prepared-with-history", "user question");

  assert.equal(response.text, "User answer");
});

test("createPreparedSessionInternal destroys session when warmup prompt fails", async () => {
  const coordinator = new WebSocketSessionCoordinator(new SessionStore());
  const calls: string[] = [];
  const originalPrompt = config.warmupSessionInitialPrompt;
  (config as any).warmupSessionInitialPrompt = "warmup prompt text";

  const manager = {
    isReady: () => true,
    sessionNew: async () => {
      calls.push("new");
      return { sessionId: "prepared-fail-warmup" };
    },
    setConfigOption: async () => undefined,
    sessionPrompt: async () => {
      calls.push("prompt");
      return { stopReason: "error" as const, exitCode: 23 };
    },
    sessionDestroy: async (sessionId: string) => {
      calls.push(`destroy:${sessionId}`);
      return undefined;
    },
    sessionResume: async () => ({ sessionId: "unused" }),
    sessionLoad: async () => ({ sessionId: "unused" })
  };

  (coordinator as any).manager = manager;
  (coordinator as any).isInitialized = true;

  try {
    await assert.rejects(
      async () => (coordinator as any).createPreparedSessionInternal(),
      /Prepared session warmup prompt failed \(exitCode=23\)/
    );
    assert.deepEqual(calls, ["new", "prompt", "destroy:prepared-fail-warmup"]);
  } finally {
    (config as any).warmupSessionInitialPrompt = originalPrompt;
  }
});

test("createPreparedSessionInternal skips destroy when warmup fails and websocket is disconnected", async () => {
  const coordinator = new WebSocketSessionCoordinator(new SessionStore());
  const calls: string[] = [];
  const originalPrompt = config.warmupSessionInitialPrompt;
  (config as any).warmupSessionInitialPrompt = "warmup prompt text";

  const manager = {
    isReady: () => false,
    sessionNew: async () => {
      calls.push("new");
      return { sessionId: "prepared-fail-warmup-disconnected" };
    },
    setConfigOption: async () => undefined,
    sessionPrompt: async () => {
      calls.push("prompt");
      return { stopReason: "error" as const, exitCode: 24 };
    },
    sessionDestroy: async (sessionId: string) => {
      calls.push(`destroy:${sessionId}`);
      return undefined;
    },
    sessionResume: async () => ({ sessionId: "unused" }),
    sessionLoad: async () => ({ sessionId: "unused" })
  };

  (coordinator as any).manager = manager;
  (coordinator as any).isInitialized = true;

  try {
    await assert.rejects(
      async () => (coordinator as any).createPreparedSessionInternal(),
      /Prepared session warmup prompt failed \(exitCode=24\)/
    );
    assert.deepEqual(calls, ["new", "prompt"]);
  } finally {
    (config as any).warmupSessionInitialPrompt = originalPrompt;
  }
});

test("validatePreparedSessionCandidate trusts the session on an ambiguous resume error (fails open, not closed)", async () => {
  const coordinator = new WebSocketSessionCoordinator(new SessionStore());

  const manager = {
    sessionResume: async () => {
      // Not an explicit "session is gone" signal - some other backend
      // protocol error unrelated to the session's actual liveness.
      throw new Error("already loaded");
    },
    sessionNew: async () => ({ sessionId: "unused" }),
    setConfigOption: async () => undefined,
    sessionPrompt: async () => ({ stopReason: "completion" as const }),
    sessionDestroy: async () => undefined,
    sessionLoad: async () => ({ sessionId: "unused" })
  };

  (coordinator as any).manager = manager;
  (coordinator as any).supportsResumeSession = true;

  const isValid = await (coordinator as any).validatePreparedSessionCandidate("some-session-id");
  assert.equal(isValid, true);
});

test("validatePreparedSessionCandidate trusts the session when the backend does not implement session/resume", async () => {
  const coordinator = new WebSocketSessionCoordinator(new SessionStore());

  const manager = {
    sessionResume: async () => {
      // Real production error: the backend doesn't implement session/resume
      // at all. This is a protocol capability gap, not a signal that the
      // session died, and must never be misread as "session not found".
      throw new Error('[-32601] "Method not found": session/resume');
    },
    sessionNew: async () => ({ sessionId: "unused" }),
    setConfigOption: async () => undefined,
    sessionPrompt: async () => ({ stopReason: "completion" as const }),
    sessionDestroy: async () => undefined,
    sessionLoad: async () => ({ sessionId: "unused" })
  };

  (coordinator as any).manager = manager;
  (coordinator as any).supportsResumeSession = true;

  const isValid = await (coordinator as any).validatePreparedSessionCandidate("some-session-id");
  assert.equal(isValid, true);
});

test("validatePreparedSessionCandidate only invalidates on an explicit 'session is gone' signal", async () => {
  const coordinator = new WebSocketSessionCoordinator(new SessionStore());

  const manager = {
    sessionResume: async () => {
      throw new Error("Session not found");
    },
    sessionNew: async () => ({ sessionId: "unused" }),
    setConfigOption: async () => undefined,
    sessionPrompt: async () => ({ stopReason: "completion" as const }),
    sessionDestroy: async () => undefined,
    sessionLoad: async () => ({ sessionId: "unused" })
  };

  (coordinator as any).manager = manager;
  (coordinator as any).supportsResumeSession = true;

  const isValid = await (coordinator as any).validatePreparedSessionCandidate("some-session-id");
  assert.equal(isValid, false);
});

test("automatic background reconnect revalidates the prepared session via resume and reuses it without re-warming", async () => {
  const coordinator = new WebSocketSessionCoordinator(new SessionStore());
  const listeners: Record<string, (...args: any[]) => any> = {};
  let sessionCounter = 0;
  const calls: string[] = [];

  const manager = {
    initialize: async () => ({ protocolVersion: 2, authMethods: [], capabilities: { session: {} } }),
    on: (event: string, callback: (...args: any[]) => any) => {
      listeners[event] = callback;
    },
    isReady: () => true,
    sessionNew: async () => {
      sessionCounter += 1;
      calls.push("new");
      return { sessionId: `prepared-${sessionCounter}` };
    },
    setConfigOption: async () => undefined,
    sessionPrompt: async () => {
      calls.push("prompt");
      return { stopReason: "completion" as const };
    },
    sessionDestroy: async () => undefined,
    sessionResume: async () => {
      calls.push("resume");
      return { sessionId: "unused" };
    },
    sessionLoad: async () => ({ sessionId: "unused" })
  };

  await coordinator.initialize(manager as any);

  const preSnapshot = (coordinator as any).preparedSessionPool.getSnapshot();
  assert.equal(preSnapshot.preparedSessionCount, 1);
  calls.length = 0;

  // Simulate the WebSocketManager reconnecting entirely on its own (no
  // incoming chat request involved) - e.g. an idle transport drop overnight.
  await listeners["reconnected"]();

  // The backend still recognizes the pre-reconnect session (session/resume
  // succeeds), so it must be reused directly with no new session/new or
  // warmup prompt call.
  assert.deepEqual(calls, ["resume"]);
  const claimed = await (coordinator as any).preparedSessionPool.claimPreparedSession();
  assert.equal(claimed, "prepared-1");
});

test("automatic background reconnect discards and re-warms a session the backend no longer recognizes", async () => {
  const coordinator = new WebSocketSessionCoordinator(new SessionStore());
  const listeners: Record<string, (...args: any[]) => any> = {};
  let sessionCounter = 0;

  const manager = {
    initialize: async () => ({ protocolVersion: 2, authMethods: [], capabilities: { session: {} } }),
    on: (event: string, callback: (...args: any[]) => any) => {
      listeners[event] = callback;
    },
    isReady: () => true,
    sessionNew: async () => {
      sessionCounter += 1;
      return { sessionId: `prepared-${sessionCounter}` };
    },
    setConfigOption: async () => undefined,
    sessionPrompt: async () => ({ stopReason: "completion" as const }),
    sessionDestroy: async () => undefined,
    sessionResume: async () => {
      throw new Error("Session not found");
    },
    sessionLoad: async () => ({ sessionId: "unused" })
  };

  await coordinator.initialize(manager as any);

  await listeners["reconnected"]();

  const claimed = await (coordinator as any).preparedSessionPool.claimPreparedSession();
  assert.equal(claimed, "prepared-2");
});

test("watchdog health check invalidates a session the backend silently killed, with no chat event or reconnect", async () => {
  const coordinator = new WebSocketSessionCoordinator(new SessionStore());
  let sessionCounter = 0;
  let backendKilledFirstSession = false;

  const manager = {
    initialize: async () => ({ protocolVersion: 2, authMethods: [], capabilities: { session: {} } }),
    on: () => undefined,
    isReady: () => true,
    sessionNew: async () => {
      sessionCounter += 1;
      return { sessionId: `prepared-${sessionCounter}` };
    },
    setConfigOption: async () => undefined,
    sessionPrompt: async () => ({ stopReason: "completion" as const }),
    sessionDestroy: async () => undefined,
    sessionResume: async () => {
      if (backendKilledFirstSession) {
        throw new Error("Session not found");
      }
      return { sessionId: "unused" };
    },
    sessionLoad: async () => ({ sessionId: "unused" })
  };

  await coordinator.initialize(manager as any);
  assert.equal((coordinator as any).preparedSessionPool.getSnapshot().preparedSessionCount, 1);

  backendKilledFirstSession = true;

  // Directly invoke the same private health check the watchdog timer uses,
  // instead of waiting on the real interval.
  await (coordinator as any).preparedSessionPool.runHealthCheck("watchdog");

  const claimed = await (coordinator as any).preparedSessionPool.claimPreparedSession();
  assert.equal(claimed, "prepared-2");
});

test("handleInitializeResult parses v1 capability shape (agentCapabilities.sessionCapabilities)", async () => {
  const coordinator = new WebSocketSessionCoordinator(new SessionStore());

  (coordinator as any).handleInitializeResult({
    protocolVersion: 1,
    authMethods: [],
    agentCapabilities: {
      loadSession: true,
      sessionCapabilities: { resume: true, close: false }
    }
  });

  assert.equal((coordinator as any).supportsLoadSession, true);
  assert.equal((coordinator as any).supportsResumeSession, true);
  assert.equal((coordinator as any).supportsCloseSession, false);
});

test("handleInitializeResult parses v2 capability shape (capabilities.session), which has no session/load", async () => {
  const coordinator = new WebSocketSessionCoordinator(new SessionStore());

  (coordinator as any).handleInitializeResult({
    protocolVersion: 2,
    authMethods: [],
    capabilities: { session: {} }
  });

  assert.equal((coordinator as any).supportsLoadSession, false);
  assert.equal((coordinator as any).supportsResumeSession, true);
  assert.equal((coordinator as any).supportsCloseSession, true);
});

test("handleInitializeResult defaults all capability flags to false when neither shape is present", async () => {
  const coordinator = new WebSocketSessionCoordinator(new SessionStore());

  (coordinator as any).handleInitializeResult({
    protocolVersion: 1,
    authMethods: []
  });

  assert.equal((coordinator as any).supportsLoadSession, false);
  assert.equal((coordinator as any).supportsResumeSession, false);
  assert.equal((coordinator as any).supportsCloseSession, false);
});

test("validatePreparedSessionCandidate skips the session/resume round trip entirely when the backend doesn't support it", async () => {
  const coordinator = new WebSocketSessionCoordinator(new SessionStore());
  const calls: string[] = [];

  const manager = {
    sessionResume: async () => {
      calls.push("resume");
      return { sessionId: "unused" };
    },
    sessionNew: async () => ({ sessionId: "unused" }),
    setConfigOption: async () => undefined,
    sessionPrompt: async () => ({ stopReason: "completion" as const }),
    sessionDestroy: async () => undefined,
    sessionLoad: async () => ({ sessionId: "unused" })
  };

  (coordinator as any).manager = manager;
  (coordinator as any).supportsResumeSession = false;

  const isValid = await (coordinator as any).validatePreparedSessionCandidate("some-session-id");

  assert.equal(isValid, true);
  assert.deepEqual(calls, []);
});

test("sendMessage reattaches via session/resume with replayFrom when the backend advertises v2 session capabilities", async () => {
  const store = new SessionStore();
  const conversationKey = "conv-resume-v2";
  const record = store.getOrCreate(conversationKey);
  record.sessionId = "existing-session";
  record.sessionState = "ready";
  record.sessionMode = "prepared";

  const coordinator = new WebSocketSessionCoordinator(store);
  const calls: any[] = [];

  const manager = {
    sessionPrompt: async () => {
      if (calls.filter((c) => c[0] === "prompt").length === 0) {
        calls.push(["prompt"]);
        throw new Error("Session existing-session not found");
      }
      calls.push(["prompt"]);
      return { stopReason: "completion" as const };
    },
    sessionResume: async (sessionId: string, cwd: string, mcpServers: any[], replayFrom: any) => {
      calls.push(["resume", sessionId, cwd, mcpServers, replayFrom]);
      return { sessionId };
    },
    sessionLoad: async (sessionId: string) => {
      calls.push(["load", sessionId]);
      return { sessionId };
    },
    sessionNew: async () => ({ sessionId: "unused" }),
    setConfigOption: async () => undefined,
    sessionDestroy: async () => undefined
  };

  (coordinator as any).manager = manager;
  (coordinator as any).isInitialized = true;
  (coordinator as any).supportsResumeSession = true;

  const response = await coordinator.sendMessage(conversationKey, "existing-session", "hello");

  assert.equal(response.stopReason, "completion");
  assert.deepEqual(calls, [
    ["prompt"],
    ["resume", "existing-session", "/workspace", [], { type: "start" }],
    ["prompt"]
  ]);
});

test("sendMessage falls back to trying resume then load when capabilities are unclear and resume fails", async () => {
  const store = new SessionStore();
  const conversationKey = "conv-resume-fallback";
  const record = store.getOrCreate(conversationKey);
  record.sessionId = "existing-session";
  record.sessionState = "ready";
  record.sessionMode = "prepared";

  const coordinator = new WebSocketSessionCoordinator(store);
  const calls: string[] = [];

  const manager = {
    sessionPrompt: async () => {
      if (calls.filter((c) => c === "prompt").length === 0) {
        calls.push("prompt");
        throw new Error("Session existing-session not found");
      }
      calls.push("prompt");
      return { stopReason: "completion" as const };
    },
    sessionResume: async () => {
      calls.push("resume");
      throw new Error('[-32601] "Method not found": session/resume');
    },
    sessionLoad: async (sessionId: string) => {
      calls.push(`load:${sessionId}`);
      return { sessionId };
    },
    sessionNew: async () => ({ sessionId: "unused" }),
    setConfigOption: async () => undefined,
    sessionDestroy: async () => undefined
  };

  (coordinator as any).manager = manager;
  (coordinator as any).isInitialized = true;
  // Capabilities intentionally left at their default (unclear) state.

  const response = await coordinator.sendMessage(conversationKey, "existing-session", "hello");

  assert.equal(response.stopReason, "completion");
  assert.deepEqual(calls, ["prompt", "resume", "load:existing-session", "prompt"]);
});

