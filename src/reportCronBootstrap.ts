import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";

const CRON_START_MARKER = "# azure-bot-acp-adapter message report cron:start";
const CRON_END_MARKER = "# azure-bot-acp-adapter message report cron:end";
const DEFAULT_CRONTAB_PATH = "/etc/crontabs/root";
const DAILY_REPORT_CRON = "0 16 * * *";

type SpawnSyncFn = typeof spawnSync;

export type ReportCronBootstrapResult = {
  enabled: boolean;
  changed: boolean;
  crontabPath?: string;
  reason?: string;
};

export type ReportCronBootstrapOptions = {
  env?: NodeJS.ProcessEnv;
  appDir?: string;
  nodePath?: string;
  crontabPath?: string;
  platform?: NodeJS.Platform;
  startCronDaemon?: boolean;
  spawnSyncFn?: SpawnSyncFn;
  logger?: Pick<Console, "log" | "warn">;
};

export function parsePositiveReportDays(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim().length === 0) {
    return null;
  }

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return null;
  }

  return parsed;
}

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

export function createReportCronBlock(params: {
  reportDays: number;
  logDir: string;
  appDir: string;
  nodePath: string;
  nodeEnv?: string;
}): string {
  const appDir = toPosixPath(params.appDir);
  const logDir = toPosixPath(params.logDir);
  const reportScriptPath = path.posix.join(appDir, "dist", "getBotMessageReport.js");
  const cronLogPath = path.posix.join(logDir, "bot-message-report.cron.log");
  const envAssignments = [
    `LOG_REPORT_DAYS=${shellQuote(String(params.reportDays))}`,
    `LOG_DIR=${shellQuote(logDir)}`
  ];

  if (params.nodeEnv && params.nodeEnv.trim().length > 0) {
    envAssignments.push(`NODE_ENV=${shellQuote(params.nodeEnv.trim())}`);
  }

  const command = [
    "cd",
    shellQuote(appDir),
    "&&",
    ...envAssignments,
    shellQuote(params.nodePath),
    shellQuote(reportScriptPath),
    ">>",
    shellQuote(cronLogPath),
    "2>&1"
  ].join(" ");

  return [
    CRON_START_MARKER,
    `${DAILY_REPORT_CRON} ${command}`,
    CRON_END_MARKER
  ].join("\n");
}

function splitCrontab(content: string): string[] {
  return content.length === 0 ? [] : content.replace(/\r\n/g, "\n").split("\n");
}

function removeManagedCronBlock(content: string): string {
  const lines = splitCrontab(content);
  const startIndex = lines.findIndex((line) => line.trim() === CRON_START_MARKER);

  if (startIndex < 0) {
    return content;
  }

  const endIndex = lines.findIndex((line, index) => index >= startIndex && line.trim() === CRON_END_MARKER);
  if (endIndex < startIndex) {
    return content;
  }

  lines.splice(startIndex, endIndex - startIndex + 1);
  return lines.filter((line, index) => line.length > 0 || index < lines.length - 1).join("\n").trimEnd();
}

export function upsertManagedCronBlock(content: string, block: string): string {
  const withoutManagedBlock = removeManagedCronBlock(content);
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
    logger.warn("[report-cron] crond is not available; daily report cron was written but may not run.");
    return;
  }

  if (result.error || result.status !== 0) {
    const detail = result.error instanceof Error ? result.error.message : `exit status ${result.status ?? "unknown"}`;
    logger.warn(`[report-cron] Could not verify/start crond: ${detail}`);
  }
}

export function applyReportCronBootstrap(options: ReportCronBootstrapOptions = {}): ReportCronBootstrapResult {
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
    const existingCrontab = readCrontab(crontabPath);

    if (!reportDays) {
      const updatedCrontab = removeManagedCronBlock(existingCrontab);
      const changed = writeCrontabIfChanged(crontabPath, updatedCrontab.length > 0 ? `${updatedCrontab}\n` : "");
      if (changed) {
        logger.log("[report-cron] Daily message report cron removed because LOG_REPORT_DAYS is missing or not > 0.");
      }

      return {
        enabled: false,
        changed,
        crontabPath,
        reason: "disabled"
      };
    }

    const appDir = path.resolve(options.appDir ?? process.cwd());
    const logDir = resolveLogDir(env.LOG_DIR, appDir);
    const nodePath = options.nodePath ?? process.execPath;
    const cronBlock = createReportCronBlock({
      reportDays,
      logDir,
      appDir,
      nodePath,
      nodeEnv: env.NODE_ENV
    });
    const updatedCrontab = upsertManagedCronBlock(existingCrontab, cronBlock);

    fs.mkdirSync(logDir, { recursive: true });
    const changed = writeCrontabIfChanged(crontabPath, updatedCrontab);

    if (options.startCronDaemon !== false) {
      ensureCronDaemon(options.spawnSyncFn ?? spawnSync, logger);
    }

    logger.log(`[report-cron] Daily message report cron enabled for 16:00 UTC with LOG_REPORT_DAYS=${reportDays}.`);

    return {
      enabled: true,
      changed,
      crontabPath
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`[report-cron] Failed to apply daily message report cron: ${message}`);
    return {
      enabled: Boolean(reportDays),
      changed: false,
      crontabPath,
      reason: message
    };
  }
}
