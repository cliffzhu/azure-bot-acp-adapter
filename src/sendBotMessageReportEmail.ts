import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { getEffectiveReportDays } from "./getBotMessageReport";

dotenv.config();

const DEFAULT_LOG_DIR = "logs";
const DEFAULT_TIME_ZONE = "America/Los_Angeles";
const DEFAULT_EXPECTED_HOUR = 10;
const DEFAULT_TIMEOUT_MS = 30_000;
const REPORT_FILE_NAME = "bot-message-report.html";
const STATE_FILE_NAME = "bot-message-report-email-state.json";

type EmailReportState = {
  nextSendDate: string;
  intervalDays: number;
  initializedAt: string;
  updatedAt: string;
  lastSentAt?: string;
  lastSentDate?: string;
};

type EmailConfig = {
  endpoint: string;
  authCode: string;
  fromAddress: string;
  toAddress: string;
  logDir: string;
  reportDays: number;
  reportPath: string;
  statePath: string;
  timeZone: string;
  expectedHour: number;
  timeoutMs: number;
  forceSend: boolean;
};

export type SendBotMessageReportEmailResult = {
  sent: boolean;
  skipped: boolean;
  reason?: string;
  nextSendDate?: string;
  status?: number;
  responseBody?: string;
};

export type SendBotMessageReportEmailOptions = {
  env?: NodeJS.ProcessEnv;
  now?: Date;
  fetchFn?: typeof fetch;
  logger?: Pick<Console, "log" | "warn" | "error">;
  forceSend?: boolean;
};

function isPositiveInteger(raw: string | undefined): boolean {
  if (raw === undefined || raw.trim().length === 0) {
    return false;
  }

  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0;
}

function parsePositiveInteger(name: string, raw: string | undefined): number {
  if (!isPositiveInteger(raw)) {
    throw new Error(`${name} must be a positive integer`);
  }

  return Number(raw);
}

function parseOptionalPositiveInteger(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim().length === 0) {
    return fallback;
  }

  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function asBoolean(raw: string | undefined): boolean {
  if (!raw) {
    return false;
  }

  const normalized = raw.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function resolveLogDir(rawLogDir: string | undefined): string {
  const trimmed = rawLogDir?.trim();
  return path.resolve(trimmed && trimmed.length > 0 ? trimmed : path.join(process.cwd(), DEFAULT_LOG_DIR));
}

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

export function getMissingEmailReportEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  return [
    "MAIL_SENDER_ENDPOINT",
    "MAIL_SENDER_ENDPOINT_AUTHCODE",
    "MAIL_FROM_ADDRESS",
    "MAIL_TO_ADDRESS"
  ].filter((name) => !env[name]?.trim());
}

function resolveConfig(env: NodeJS.ProcessEnv, forceSendOverride: boolean | undefined): EmailConfig {
  const logDir = resolveLogDir(env.LOG_DIR);
  const reportDays = parsePositiveInteger("LOG_REPORT_DAYS", env.LOG_REPORT_DAYS);
  const forceSend = forceSendOverride ?? asBoolean(env.MAIL_REPORT_FORCE_SEND);

  return {
    endpoint: requireEnv(env, "MAIL_SENDER_ENDPOINT"),
    authCode: requireEnv(env, "MAIL_SENDER_ENDPOINT_AUTHCODE"),
    fromAddress: requireEnv(env, "MAIL_FROM_ADDRESS"),
    toAddress: requireEnv(env, "MAIL_TO_ADDRESS"),
    logDir,
    reportDays,
    reportPath: path.join(logDir, REPORT_FILE_NAME),
    statePath: path.join(logDir, STATE_FILE_NAME),
    timeZone: env.MAIL_REPORT_TIME_ZONE?.trim() || DEFAULT_TIME_ZONE,
    expectedHour: parseOptionalPositiveInteger(env.MAIL_REPORT_EXPECTED_HOUR, DEFAULT_EXPECTED_HOUR),
    timeoutMs: parseOptionalPositiveInteger(env.MAIL_SENDER_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    forceSend
  };
}

function getTimeZoneParts(date: Date, timeZone: string): { dateKey: string; hour: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  const values = new Map(parts.map((part) => [part.type, part.value]));
  const year = values.get("year");
  const month = values.get("month");
  const day = values.get("day");
  const hour = values.get("hour");

  if (!year || !month || !day || !hour) {
    throw new Error(`Could not calculate date in time zone: ${timeZone}`);
  }

  return {
    dateKey: `${year}-${month}-${day}`,
    hour: Number(hour)
  };
}

function parseDateKey(dateKey: string): { year: number; month: number; day: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
  if (!match) {
    throw new Error(`Invalid schedule date: ${dateKey}`);
  }

  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3])
  };
}

function dayOfWeek(dateKey: string): number {
  const { year, month, day } = parseDateKey(dateKey);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

export function addDaysToDateKey(dateKey: string, days: number): string {
  const { year, month, day } = parseDateKey(dateKey);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return date.toISOString().slice(0, 10);
}

export function nextMondayDateKey(dateKey: string): string {
  const currentDay = dayOfWeek(dateKey);
  const daysUntilMonday = currentDay === 1 ? 7 : (8 - currentDay) % 7;
  return addDaysToDateKey(dateKey, daysUntilMonday);
}

function readState(statePath: string): EmailReportState | null {
  try {
    const raw = fs.readFileSync(statePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<EmailReportState>;

    if (!parsed.nextSendDate || !/^\d{4}-\d{2}-\d{2}$/.test(parsed.nextSendDate)) {
      return null;
    }

    const intervalDays = parsed.intervalDays;

    return {
      nextSendDate: parsed.nextSendDate,
      intervalDays: typeof intervalDays === "number" && Number.isInteger(intervalDays) && intervalDays > 0 ? intervalDays : 0,
      initializedAt: parsed.initializedAt || new Date().toISOString(),
      updatedAt: parsed.updatedAt || new Date().toISOString(),
      lastSentAt: parsed.lastSentAt,
      lastSentDate: parsed.lastSentDate
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

function writeState(statePath: string, state: EmailReportState): void {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export function ensureEmailReportScheduleState(options: {
  logDir: string;
  reportDays: number;
  now?: Date;
  timeZone?: string;
}): EmailReportState {
  const statePath = path.join(options.logDir, STATE_FILE_NAME);
  const existing = readState(statePath);
  if (existing) {
    return existing;
  }

  const now = options.now ?? new Date();
  const timeZone = options.timeZone ?? DEFAULT_TIME_ZONE;
  const today = getTimeZoneParts(now, timeZone).dateKey;
  const timestamp = now.toISOString();
  const state: EmailReportState = {
    nextSendDate: nextMondayDateKey(today),
    intervalDays: options.reportDays,
    initializedAt: timestamp,
    updatedAt: timestamp
  };

  writeState(statePath, state);
  return state;
}

function advanceNextSendDate(nextSendDate: string, today: string, reportDays: number): string {
  let candidate = addDaysToDateKey(nextSendDate, reportDays);
  while (candidate <= today) {
    candidate = addDaysToDateKey(candidate, reportDays);
  }

  return candidate;
}

function buildSubject(today: string, reportDays: number): string {
  const effectiveReportDays = getEffectiveReportDays(reportDays);
  const dayLabel = effectiveReportDays === 1 ? "day" : "days";
  return `Bot message report - ${today} - last ${effectiveReportDays} ${dayLabel}`;
}

async function postEmail(config: EmailConfig, subject: string, html: string, fetchFn: typeof fetch): Promise<{
  status: number;
  responseBody: string;
}> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const response = await fetchFn(config.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${config.authCode}`,
        "X-Auth-Code": config.authCode
      },
      body: JSON.stringify({
        to: config.toAddress,
        subject,
        body: html,
        isHtml: true,
        fromEmail: config.fromAddress,
        from: {
          name: "Bot Message Report",
          email: config.fromAddress
        }
      }),
      signal: controller.signal
    });
    const responseBody = await response.text();

    if (!response.ok) {
      throw new Error(`Email sender returned ${response.status}: ${responseBody}`);
    }

    return {
      status: response.status,
      responseBody
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function sendBotMessageReportEmail(
  options: SendBotMessageReportEmailOptions = {}
): Promise<SendBotMessageReportEmailResult> {
  const env = options.env ?? process.env;
  const logger = options.logger ?? console;
  const config = resolveConfig(env, options.forceSend);
  const now = options.now ?? new Date();
  const current = getTimeZoneParts(now, config.timeZone);

  if (!config.forceSend && current.hour !== config.expectedHour) {
    logger.log(`[message-report-email] Skipped because current ${config.timeZone} hour is ${current.hour}, not ${config.expectedHour}.`);
    return {
      sent: false,
      skipped: true,
      reason: "outside-send-hour"
    };
  }

  const state = ensureEmailReportScheduleState({
    logDir: config.logDir,
    reportDays: config.reportDays,
    now,
    timeZone: config.timeZone
  });

  if (!config.forceSend && current.dateKey < state.nextSendDate) {
    logger.log(`[message-report-email] Skipped because next send date is ${state.nextSendDate}.`);
    return {
      sent: false,
      skipped: true,
      reason: "not-due",
      nextSendDate: state.nextSendDate
    };
  }

  if (!fs.existsSync(config.reportPath)) {
    throw new Error(`Message report file not found: ${config.reportPath}`);
  }

  const html = fs.readFileSync(config.reportPath, "utf8");
  const subject = buildSubject(current.dateKey, config.reportDays);
  const response = await postEmail(config, subject, html, options.fetchFn ?? fetch);
  const nextSendDate = config.forceSend
    ? state.nextSendDate
    : advanceNextSendDate(state.nextSendDate, current.dateKey, config.reportDays);
  const updatedState: EmailReportState = {
    ...state,
    intervalDays: config.reportDays,
    lastSentAt: now.toISOString(),
    lastSentDate: current.dateKey,
    nextSendDate,
    updatedAt: now.toISOString()
  };
  writeState(config.statePath, updatedState);

  logger.log(`[message-report-email] Email sent to ${config.toAddress}; next send date is ${nextSendDate}.`);

  return {
    sent: true,
    skipped: false,
    nextSendDate,
    status: response.status,
    responseBody: response.responseBody
  };
}

async function runFromEnv(): Promise<void> {
  const result = await sendBotMessageReportEmail();
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  runFromEnv().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[message-report-email] ${message}`);
    process.exitCode = 1;
  });
}
