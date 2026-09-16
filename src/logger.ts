/**
 * Rotating file logger for raw HTTP payloads.
 *
 * Writes NDJSON entries to `logs/bot.log`.
 * When the file reaches LOG_MAX_BYTES (default 5 MB) it is renamed to
 * `logs/bot.log.older` (overwriting any previous rotation) and a fresh
 * `logs/bot.log` is opened.
 *
 * Each log entry shape:
 *   { ts, direction, method, path, status?, body }
 */

import fs from "fs";
import path from "path";
import type { Request, Response, NextFunction } from "express";

// ─── Configuration ────────────────────────────────────────────────────────────

const LOG_DIR      = process.env.LOG_DIR?.trim() ? process.env.LOG_DIR.trim() : path.join(process.cwd(), "logs");
const LOG_FILE     = path.join(LOG_DIR, "bot.log");
const LOG_OLDER    = path.join(LOG_DIR, "bot.log.older");
const LOG_MAX_BYTES = Number(process.env.LOG_MAX_BYTES ?? 5 * 1024 * 1024); // 5 MB

// ─── Internal state ───────────────────────────────────────────────────────────

let stream: fs.WriteStream | null = null;
let currentSize = 0;

function toLogSafeValue(value: unknown): unknown {
  if (Buffer.isBuffer(value)) {
    return {
      type: "Buffer",
      length: value.length
    };
  }

  return value;
}

function safeStringify(entry: unknown): string {
  const seen = new WeakSet<object>();

  return JSON.stringify(entry, (_key, value) => {
    const normalized = toLogSafeValue(value);

    if (typeof normalized === "bigint") {
      return normalized.toString();
    }

    if (normalized && typeof normalized === "object") {
      if (seen.has(normalized)) {
        return "[Circular]";
      }

      seen.add(normalized);
    }

    return normalized;
  });
}

function ensureDir(): void {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
}

function openStream(): void {
  ensureDir();
  stream = fs.createWriteStream(LOG_FILE, { flags: "a" });
  stream.on("error", (err) => {
    console.error("[logger] WriteStream error:", err.message);
    stream = null;
  });
}

function initSize(): void {
  try {
    currentSize = fs.existsSync(LOG_FILE) ? fs.statSync(LOG_FILE).size : 0;
  } catch {
    currentSize = 0;
  }
}

// Rotate: rename current log → .older, open a fresh stream
function rotate(): void {
  if (stream) {
    stream.end();
    stream = null;
  }

  try {
    if (fs.existsSync(LOG_FILE)) {
      // Overwrite any existing .older
      fs.renameSync(LOG_FILE, LOG_OLDER);
    }
  } catch (err) {
    console.error("[logger] Rotation rename failed:", (err as Error).message);
  }

  currentSize = 0;
  openStream();
}

// Write one NDJSON line; rotate first if limit reached
function writeLine(entry: object): void {
  if (!stream) {
    openStream();
    initSize();
  }

  let line: string;
  try {
    line = safeStringify(entry) + "\n";
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[logger] Failed to serialize log entry:", message);
    return;
  }

  const lineLen = Buffer.byteLength(line, "utf8");

  if (currentSize + lineLen > LOG_MAX_BYTES) {
    rotate();
  }

  stream?.write(line, "utf8");
  currentSize += lineLen;
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────

ensureDir();
initSize();
openStream();

// ─── Express middleware ────────────────────────────────────────────────────────

/**
 * Attach to the Express app with `app.use(payloadLogger)`.
 * Logs the raw incoming body and the outgoing JSON response body.
 */
export function payloadLogger(req: Request, res: Response, next: NextFunction): void {
  const ts     = new Date().toISOString();
  const method = req.method;
  const urlPath = req.path;
  let capturedResponseBody: unknown = null;
  let outgoingLogged = false;

  // Log incoming
  writeLine({
    ts,
    direction : "incoming",
    method,
    path      : urlPath,
    headers   : {
      "content-type"  : req.headers["content-type"],
      "content-length": req.headers["content-length"],
      "user-agent"    : req.headers["user-agent"]
    },
    body: req.body ?? null
  });

  // Capture outgoing bodies from the common response paths.
  const origJson = res.json.bind(res) as (body: unknown) => Response;
  res.json = (body: unknown): Response => {
    capturedResponseBody = body;
    return origJson(body);
  };

  const origSend = res.send.bind(res) as (body?: unknown) => Response;
  res.send = (body?: unknown): Response => {
    capturedResponseBody = body ?? capturedResponseBody;
    return origSend(body);
  };

  const logOutgoing = () => {
    if (outgoingLogged) {
      return;
    }

    outgoingLogged = true;
    writeLine({
      ts: new Date().toISOString(),
      direction: "outgoing",
      method,
      path: urlPath,
      status: res.statusCode,
      body: capturedResponseBody
    });
  };

  res.on("finish", logOutgoing);
  res.on("close", logOutgoing);

  next();
}

type OutgoingActivityLogParams = {
  source: "api/messages" | "api/dev/messages";
  channelId: string;
  conversationId: string;
  userId: string;
  status: "attempt" | "success" | "failure";
  text: string;
  stopReason?: string;
  error?: unknown;
};

type SessionLifecycleLogParams = {
  event: string;
  sessionId?: string;
  sourceSessionId?: string;
  conversationKey?: string;
  poolSize?: number;
  ageMs?: number;
  remainingPoolSize?: number;
  sessionMode?: string;
  promptLength?: number;
  responseLength?: number;
  responseHasErrors?: boolean;
  warmupResponseStripped?: boolean;
  stopReason?: string;
  error?: unknown;
};

/**
 * Record Bot Framework outgoing activity events that do not flow through res.json.
 */
export function logOutgoingActivity(params: OutgoingActivityLogParams): void {
  writeLine({
    ts: new Date().toISOString(),
    direction: "outgoing-activity",
    source: params.source,
    channelId: params.channelId,
    conversationId: params.conversationId,
    userId: params.userId,
    status: params.status,
    textLength: params.text.length,
    stopReason: params.stopReason ?? "n/a",
    body: {
      type: "message",
      text: params.text
    },
    error: params.error ?? null
  });
}

/**
 * Record prepared-session lifecycle events separately from request/response payloads.
 */
export function logSessionLifecycleEvent(params: SessionLifecycleLogParams): void {
  writeLine({
    ts: new Date().toISOString(),
    direction: "session-lifecycle",
    event: params.event,
    sessionId: params.sessionId ?? null,
    sourceSessionId: params.sourceSessionId ?? null,
    conversationKey: params.conversationKey ?? null,
    poolSize: params.poolSize ?? null,
    ageMs: params.ageMs ?? null,
    remainingPoolSize: params.remainingPoolSize ?? null,
    sessionMode: params.sessionMode ?? null,
    promptLength: params.promptLength ?? null,
    responseLength: params.responseLength ?? null,
    responseHasErrors: params.responseHasErrors ?? null,
    warmupResponseStripped: params.warmupResponseStripped ?? null,
    stopReason: params.stopReason ?? null,
    error: params.error ?? null
  });
}

// ─── Close on process exit ────────────────────────────────────────────────────

function closeLogger(): void {
  if (stream) {
    stream.end();
    stream = null;
  }
}

process.on("exit",    closeLogger);
process.on("SIGTERM", closeLogger);
process.on("SIGINT",  closeLogger);
