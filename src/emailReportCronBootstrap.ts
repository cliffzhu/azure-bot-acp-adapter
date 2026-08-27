import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { ensureEmailReportScheduleState, getMissingEmailReportEnv } from "./sendBotMessageReportEmail";
import { parsePositiveReportDays } from "./reportCronBootstrap";

const EMAIL_CRON_START_MARKER = "# azure-bot-acp-adapter email message report cron:start";
const EMAIL_CRON_END_MARKER = "# azure-bot-acp-adapter email message report cron:end";
const DEFAULT_CRONTAB_PATH = "/etc/crontabs/root";
const PACIFIC_TIME_ZONE = "America/Los_Angeles";
const PACIFIC_SEND_HOUR = 10;

type SpawnSyncFn = typeof spawnSync;

export type EmailReportCronBootstrapResult = {
  enabled: boolean;
  changed: boolean;
  crontabPath?: string;
  reason?: string;
  missing?: string[];
};

export type EmailReportCronBootstrapOptions = {
  env?: NodeJS.ProcessEnv;
  appDir?: string;
  nodePath?: string;
  crontabPath?: string;
  platform?: NodeJS.Platform;
  now?: Date;
  startCronDaemon?: boolean;
  spawnSyncFn?: SpawnSyncFn;
  logger?: Pick<Console, "log" | "warn">;
};

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function resolveLogDir(rawLogDir: string | undefined, appDir: string): string {
  const trimmed = rawLogDir?.trim();
  return path.resolve(appDir, trimmed && trimmed.length > 0 ? trimmed : "logs");
}

function toPosixPath(value: string): string {
  return value.replace(/\\/g, "/");
}

function optionalEnvAssignment(env: NodeJS.ProcessEnv, name: string): string | null {
  const value = env[name]?.trim();
  return value ? `${name}=${shellQuote(value)}` : null;
}

export function createEmailReportCronBlock(params: {
  reportDays: number;
  logDir: string;
  appDir: string;
  nodePath: string;
  env: NodeJS.ProcessEnv;
}): string {
  const appDir = toPosixPath(params.appDir);
  const logDir = toPosixPath(params.logDir);
  const emailScriptPath = path.posix.join(appDir, "dist", "sendBotMessageReportEmail.js");
  const cronLogPath = path.posix.join(logDir, "bot-message-report-email.cron.log");
  const envAssignments = [
    `LOG_REPORT_DAYS=${shellQuote(String(params.reportDays))}`,
    `LOG_DIR=${shellQuote(logDir)}`,
    `MAIL_REPORT_TIME_ZONE=${shellQuote(PACIFIC_TIME_ZONE)}`,
    `MAIL_REPORT_EXPECTED_HOUR=${shellQuote(String(PACIFIC_SEND_HOUR))}`,
    optionalEnvAssignment(params.env, "NODE_ENV"),
    optionalEnvAssignment(params.env, "MAIL_SENDER_ENDPOINT"),
    optionalEnvAssignment(params.env, "MAIL_SENDER_ENDPOINT_AUTHCODE"),
    optionalEnvAssignment(params.env, "MAIL_FROM_ADDRESS"),
    optionalEnvAssignment(params.env, "MAIL_TO_ADDRESS"),
    optionalEnvAssignment(params.env, "MAIL_SENDER_TIMEOUT_MS")
  ].filter((value): value is string => Boolean(value));

  const command = [
    "cd",
    shellQuote(appDir),
    "&&",
    ...envAssignments,
    shellQuote(params.nodePath),
    shellQuote(emailScriptPath),
    ">>",
    shellQuote(cronLogPath),
    "2>&1"
  ].join(" ");

  return [
    EMAIL_CRON_START_MARKER,
    "# Runs at 17:00 and 18:00 UTC; the script only sends when local Pacific hour is 10.",
    `0 17,18 * * * ${command}`,
    EMAIL_CRON_END_MARKER
  ].join("\n");
}

function splitCrontab(content: string): string[] {
  return content.length === 0 ? [] : content.replace(/\r\n/g, "\n").split("\n");
}

function removeManagedEmailCronBlock(content: string): string {
  const lines = splitCrontab(content);
  const startIndex = lines.findIndex((line) => line.trim() === EMAIL_CRON_START_MARKER);

  if (startIndex < 0) {
    return content;
  }

  const endIndex = lines.findIndex((line, index) => index >= startIndex && line.trim() === EMAIL_CRON_END_MARKER);
  if (endIndex < startIndex) {
    return content;
  }

  lines.splice(startIndex, endIndex - startIndex + 1);
  return lines.filter((line, index) => line.length > 0 || index < lines.length - 1).join("\n").trimEnd();
}

export function upsertManagedEmailCronBlock(content: string, block: string): string {
  const withoutManagedBlock = removeManagedEmailCronBlock(content);
  const trimmedBlock = block.trimEnd();

  if (withoutManagedBlock.trim().length === 0) {
    return `${trimmedBlock}\n`;
  }

  return `${withoutManagedBlock.trimEnd()}\n${trimmedBlock}\n`;
}

function readCrontab(crontabPath: string): string {
  try {
    return fs.readFileSync(crontabPath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return "";
    }

    throw error;
  }
}

function writeCrontabIfChanged(crontabPath: string, content: string): boolean {
  const existing = readCrontab(crontabPath);
  if (existing === content) {
    return false;
  }

  fs.mkdirSync(path.dirname(crontabPath), { recursive: true });
  fs.writeFileSync(crontabPath, content, "utf8");
  return true;
}

function ensureCronDaemon(spawnSyncFn: SpawnSyncFn, logger: Pick<Console, "warn">): void {
  const result = spawnSyncFn(
    "sh",
    ["-c", "if command -v crond >/dev/null 2>&1; then pidof crond >/dev/null 2>&1 || crond -l 8; else exit 127; fi"],
    { stdio: "ignore" }
  );

  if (result.status === 127) {
    logger.warn("[email-report-cron] crond is not available; email report cron was written but may not run.");
    return;
  }

  if (result.error || result.status !== 0) {
    const detail = result.error instanceof Error ? result.error.message : `exit status ${result.status ?? "unknown"}`;
    logger.warn(`[email-report-cron] Could not verify/start crond: ${detail}`);
  }
}

function removeEmailCron(crontabPath: string, logger: Pick<Console, "log">, reason: string): EmailReportCronBootstrapResult {
  const existingCrontab = readCrontab(crontabPath);
  const updatedCrontab = removeManagedEmailCronBlock(existingCrontab);
  const changed = writeCrontabIfChanged(crontabPath, updatedCrontab.length > 0 ? `${updatedCrontab}\n` : "");

  if (changed) {
    logger.log(`[email-report-cron] Email report cron removed: ${reason}.`);
  }

  return {
    enabled: false,
    changed,
    crontabPath,
    reason
  };
}

export function applyEmailReportCronBootstrap(options: EmailReportCronBootstrapOptions = {}): EmailReportCronBootstrapResult {
  const env = options.env ?? process.env;
  const logger = options.logger ?? console;
  const reportDays = parsePositiveReportDays(env.LOG_REPORT_DAYS);
  const platform = options.platform ?? process.platform;
  const crontabPath = options.crontabPath ?? DEFAULT_CRONTAB_PATH;

  if (platform !== "linux") {
    return {
      enabled: false,
      changed: false,
      reason: "unsupported-platform"
    };
  }

  try {
    if (!reportDays) {
      return removeEmailCron(crontabPath, logger, "LOG_REPORT_DAYS is missing or not > 0");
    }

    const missing = getMissingEmailReportEnv(env);
    if (missing.length > 0) {
      const result = removeEmailCron(crontabPath, logger, `missing ${missing.join(", ")}`);
      return {
        ...result,
        missing
      };
    }

    const appDir = path.resolve(options.appDir ?? process.cwd());
    const logDir = resolveLogDir(env.LOG_DIR, appDir);
    const nodePath = options.nodePath ?? process.execPath;
    fs.mkdirSync(logDir, { recursive: true });
    const state = ensureEmailReportScheduleState({
      logDir,
      reportDays,
      now: options.now,
      timeZone: PACIFIC_TIME_ZONE
    });

    const existingCrontab = readCrontab(crontabPath);
    const cronBlock = createEmailReportCronBlock({
      reportDays,
      logDir,
      appDir,
      nodePath,
      env
    });
    const updatedCrontab = upsertManagedEmailCronBlock(existingCrontab, cronBlock);
    const changed = writeCrontabIfChanged(crontabPath, updatedCrontab);

    if (options.startCronDaemon !== false) {
      ensureCronDaemon(options.spawnSyncFn ?? spawnSync, logger);
    }

    logger.log(`[email-report-cron] Email report cron enabled for 10:00 ${PACIFIC_TIME_ZONE}; next send date is ${state.nextSendDate}.`);

    return {
      enabled: true,
      changed,
      crontabPath
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`[email-report-cron] Failed to apply email report cron: ${message}`);
    return {
      enabled: Boolean(reportDays),
      changed: false,
      crontabPath,
      reason: message
    };
  }
}
