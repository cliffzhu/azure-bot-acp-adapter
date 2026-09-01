import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { createInterface } from "readline";

dotenv.config();

const DEFAULT_REPORT_DAYS = 7;
const MAX_REPORT_DAYS = 36500;

type LogRecord = Record<string, unknown>;

type ReportItem = {
  timestamp: Date;
  direction: "Incoming" | "Outgoing";
  channel: string;
  message: string;
};

type ReportGroup = {
  sortTime: Date;
  incoming: ReportItem | null;
  outgoing: ReportItem | null;
  durationMs: number | null;
};

type ParsedLogEntry = {
  sourcePath: string;
  lineNumber: number;
  timestamp: Date;
  entry: LogRecord;
};

export type BotMessageReportResult = {
  outputPath: string;
  sourcePaths: string[];
  messages: number;
  completedPairs: number;
  unmatchedMessages: number;
  invalidLinesSkipped: number;
  cutoffUtc: string;
};

export type GenerateBotMessageReportOptions = {
  logDir?: string;
  reportDays?: number;
  outputPath?: string;
  now?: Date;
  onWarning?: (message: string) => void;
};

function asRecord(value: unknown): LogRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as LogRecord
    : null;
}

function getValue(record: LogRecord | null, pathParts: string[]): unknown {
  let current: unknown = record;
  for (const part of pathParts) {
    const currentRecord = asRecord(current);
    if (!currentRecord || !(part in currentRecord)) {
      return undefined;
    }

    current = currentRecord[part];
  }

  return current;
}

function getString(record: LogRecord | null, pathParts: string[]): string {
  const value = getValue(record, pathParts);
  if (value === undefined || value === null) {
    return "";
  }

  return String(value);
}

function parseTimestamp(value: unknown): Date {
  const timestamp = value instanceof Date
    ? value
    : new Date(typeof value === "number" ? value : String(value ?? ""));

  if (Number.isNaN(timestamp.getTime())) {
    throw new Error("Invalid timestamp");
  }

  return timestamp;
}

function parseReportDays(value: string | undefined): number {
  if (!value || value.trim().length === 0) {
    return DEFAULT_REPORT_DAYS;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_REPORT_DAYS) {
    throw new Error(`LOG_REPORT_DAYS must be an integer from 1 to ${MAX_REPORT_DAYS}`);
  }

  return parsed;
}

export function getEffectiveReportDays(reportDays: number): number {
  return reportDays > 0 ? reportDays + 1 : reportDays;
}

function resolveLogDir(value: string | undefined): string {
  const raw = value?.trim();
  return path.resolve(raw && raw.length > 0 ? raw : path.join(process.cwd(), "logs"));
}

function getIncomingKey(entry: LogRecord, body: LogRecord): string {
  return [
    getString(body, ["channelId"]),
    getString(body, ["conversation", "id"]),
    getString(body, ["from", "id"])
  ].join("|");
}

function getOutgoingKey(entry: LogRecord): string {
  return [
    getString(entry, ["channelId"]),
    getString(entry, ["conversationId"]),
    getString(entry, ["userId"])
  ].join("|");
}

function encodeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function convertToHtmlMessage(text: string | null | undefined): string {
  if (!text) {
    return "";
  }

  if (/<[A-Za-z][^>]*>/.test(text)) {
    return text;
  }

  return encodeHtml(text)
    .replace(/\r\n/g, "<br>")
    .replace(/\n/g, "<br>");
}

function formatLocalDateTime(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate())
  ].join("-") + " " + [
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds())
  ].join(":");
}

function formatLocalDateTimeWithOffset(date: Date): string {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absoluteOffset = Math.abs(offsetMinutes);
  const hours = String(Math.floor(absoluteOffset / 60)).padStart(2, "0");
  const minutes = String(absoluteOffset % 60).padStart(2, "0");

  return `${formatLocalDateTime(date)} ${sign}${hours}:${minutes}`;
}

function discoverLogFiles(logDir: string): string[] {
  return ["bot.log.older", "bot.log"]
    .map((name) => path.join(logDir, name))
    .filter((filePath) => {
      try {
        return fs.statSync(filePath).isFile();
      } catch {
        return false;
      }
    });
}

function makeReportItem(
  timestamp: Date,
  direction: "Incoming" | "Outgoing",
  channel: string,
  message: string
): ReportItem {
  return {
    timestamp,
    direction,
    channel,
    message
  };
}

async function processLogFile(
  filePath: string,
  cutoffTime: number,
  entries: ParsedLogEntry[],
  warn: (message: string) => void
): Promise<number> {
  const reader = createInterface({
    input: fs.createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Infinity
  });

  let lineNumber = 0;
  let invalidLineCount = 0;

  for await (const line of reader) {
    lineNumber++;
    if (line.trim().length === 0) {
      continue;
    }

    let entry: LogRecord;
    let timestamp: Date;

    try {
      entry = JSON.parse(line) as LogRecord;
      timestamp = parseTimestamp(entry.ts);
    } catch {
      invalidLineCount++;
      warn(`Skipping invalid JSON or timestamp at ${filePath}:${lineNumber}.`);
      continue;
    }

    if (timestamp.getTime() < cutoffTime) {
      continue;
    }

    entries.push({
      sourcePath: filePath,
      lineNumber,
      timestamp,
      entry
    });
  }

  return invalidLineCount;
}

function buildReportGroupsFromEntries(entries: ParsedLogEntry[]): {
  completedPairs: ReportGroup[];
  groups: ReportGroup[];
} {
  const pendingByConversation = new Map<string, ReportItem[]>();
  const completedPairs: ReportGroup[] = [];
  const unmatchedOutgoing: ReportItem[] = [];
  const sortedEntries = [...entries].sort((left, right) => {
    const timestampDiff = left.timestamp.getTime() - right.timestamp.getTime();
    if (timestampDiff !== 0) {
      return timestampDiff;
    }

    const sourceDiff = left.sourcePath.localeCompare(right.sourcePath);
    return sourceDiff !== 0 ? sourceDiff : left.lineNumber - right.lineNumber;
  });

  for (const { entry, timestamp } of sortedEntries) {
    const body = asRecord(entry.body);
    const bodyType = getString(body, ["type"]);
    const bodyText = getString(body, ["text"]);
    const direction = getString(entry, ["direction"]);

    if (
      direction === "incoming"
      && bodyType === "message"
      && bodyText.trim().length > 0
      && body
    ) {
      const key = getIncomingKey(entry, body);
      const queue = pendingByConversation.get(key) ?? [];
      queue.push(makeReportItem(
        timestamp,
        "Incoming",
        getString(body, ["channelId"]),
        bodyText
      ));
      pendingByConversation.set(key, queue);
      continue;
    }

    if (
      direction === "outgoing-activity"
      && getString(entry, ["status"]) === "success"
      && bodyType === "message"
    ) {
      const outgoing = makeReportItem(
        timestamp,
        "Outgoing",
        getString(entry, ["channelId"]),
        bodyText
      );
      const key = getOutgoingKey(entry);
      const queue = pendingByConversation.get(key);

      if (queue && queue.length > 0) {
        const incoming = queue.shift() ?? null;
        if (incoming) {
          completedPairs.push({
            sortTime: incoming.timestamp,
            incoming,
            outgoing,
            durationMs: outgoing.timestamp.getTime() - incoming.timestamp.getTime()
          });
        }
      } else {
        unmatchedOutgoing.push(outgoing);
      }
    }
  }

  return {
    completedPairs,
    groups: buildGroups(completedPairs, pendingByConversation, unmatchedOutgoing)
  };
}

function buildGroups(
  completedPairs: ReportGroup[],
  pendingByConversation: Map<string, ReportItem[]>,
  unmatchedOutgoing: ReportItem[]
): ReportGroup[] {
  const groups: ReportGroup[] = [...completedPairs];

  for (const queue of pendingByConversation.values()) {
    for (const incoming of queue) {
      groups.push({
        sortTime: incoming.timestamp,
        incoming,
        outgoing: null,
        durationMs: null
      });
    }
  }

  for (const outgoing of unmatchedOutgoing) {
    groups.push({
      sortTime: outgoing.timestamp,
      incoming: null,
      outgoing,
      durationMs: null
    });
  }

  return groups.sort((left, right) => left.sortTime.getTime() - right.sortTime.getTime());
}

function countMessages(groups: ReportGroup[]): number {
  return groups.reduce((total, group) => {
    return total + (group.incoming ? 1 : 0) + (group.outgoing ? 1 : 0);
  }, 0);
}

function formatDuration(durationMs: number | null): string {
  if (durationMs === null) {
    return "Unmatched";
  }

  return `${(durationMs / 1000).toFixed(3)} s`;
}

function renderRows(groups: ReportGroup[]): string {
  const rows: string[] = [];

  for (const group of groups) {
    const duration = formatDuration(group.durationMs);

    for (const item of [group.incoming, group.outgoing]) {
      if (!item) {
        continue;
      }

      const directionClass = item.direction.toLowerCase();
      rows.push(`            <tr class="${directionClass}">
                <td class="message">${convertToHtmlMessage(item.message)}</td>
                <td>${encodeHtml(formatLocalDateTime(item.timestamp))}</td>
                <td>${encodeHtml(duration)}</td>
                <td><span class="badge ${directionClass}">${encodeHtml(item.direction)}</span></td>
                <td>${encodeHtml(item.channel)}</td>
            </tr>`);
    }
  }

  return rows.join("\n");
}

function renderHtml(
  groups: ReportGroup[],
  reportDays: number,
  sourcePaths: string[],
  generatedAt: Date
): string {
  const rows = renderRows(groups);
  const recordCount = countMessages(groups);
  const sourceLabel = sourcePaths.length === 1 ? "Source" : "Sources";
  const sourceText = sourcePaths.map((sourcePath) => encodeHtml(sourcePath)).join("<br>");

  return `<!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Bot message report</title>
    <style>
        :root { color-scheme: light; --ink: #17211b; --muted: #667067; --line: #d8ded9; --paper: #ffffff; --canvas: #eef2ee; --incoming: #176b4d; --outgoing: #245aa5; }
        * { box-sizing: border-box; }
        body { margin: 0; background: var(--canvas); color: var(--ink); font-family: Aptos, Calibri, sans-serif; }
        main { width: min(1500px, calc(100% - 32px)); margin: 32px auto; }
        h1 { margin: 0 0 6px; font-family: Georgia, serif; font-size: 30px; letter-spacing: 0; }
        .summary { margin: 0 0 22px; color: var(--muted); }
        .table-wrap { overflow-x: auto; border: 1px solid var(--line); background: var(--paper); box-shadow: 0 10px 30px rgba(23, 33, 27, .08); }
        table { width: 100%; border-collapse: collapse; table-layout: fixed; }
        th { position: sticky; top: 0; z-index: 1; padding: 12px; background: #25332b; color: #fff; text-align: left; font-size: 13px; }
        td { padding: 12px; border-top: 1px solid var(--line); vertical-align: top; font-size: 14px; }
        tr.outgoing td { background: #f7faff; }
        tr.incoming td { border-top-width: 3px; }
        th:nth-child(n+2), td:nth-child(n+2) { width: 20ch; white-space: normal; overflow-wrap: anywhere; }
        .badge { display: inline-block; padding: 3px 7px; border-radius: 4px; color: #fff; font-size: 12px; font-weight: 700; }
        .badge.incoming { background: var(--incoming); }
        .badge.outgoing { background: var(--outgoing); }
        .message { overflow-wrap: anywhere; line-height: 1.45; }
        .message table { margin: 8px 0; table-layout: auto; }
        .message th, .message td { position: static; width: auto; padding: 6px 8px; border: 1px solid var(--line); background: #fff; color: var(--ink); white-space: normal; }
        @media (max-width: 760px) { main { width: calc(100% - 16px); margin: 16px auto; } th, td { padding: 9px; } }
    </style>
</head>
<body>
    <main>
        <h1>Bot message report</h1>
        <p class="summary">${recordCount} messages from the last ${reportDays} day(s) &middot; Generated ${encodeHtml(formatLocalDateTimeWithOffset(generatedAt))}<br>${sourceLabel}: ${sourceText}</p>
        <div class="table-wrap">
            <table>
                <thead><tr><th>Message</th><th>Date/time</th><th>Duration</th><th>Direction</th><th>Channel</th></tr></thead>
                <tbody>
${rows}
                </tbody>
            </table>
        </div>
    </main>
</body>
</html>
`;
}

export function resolveBotMessageReportConfig(env: NodeJS.ProcessEnv = process.env): {
  logDir: string;
  reportDays: number;
  outputPath: string;
} {
  const logDir = resolveLogDir(env.LOG_DIR);
  const reportDays = parseReportDays(env.LOG_REPORT_DAYS);

  return {
    logDir,
    reportDays,
    outputPath: path.join(logDir, "bot-message-report.html")
  };
}

export async function generateBotMessageReport(
  options: GenerateBotMessageReportOptions = {}
): Promise<BotMessageReportResult> {
  const logDir = path.resolve(options.logDir ?? resolveLogDir(process.env.LOG_DIR));
  const reportDays = options.reportDays ?? parseReportDays(process.env.LOG_REPORT_DAYS);

  if (!Number.isInteger(reportDays) || reportDays < 1 || reportDays > MAX_REPORT_DAYS) {
    throw new Error(`reportDays must be an integer from 1 to ${MAX_REPORT_DAYS}`);
  }

  const outputPath = path.resolve(options.outputPath ?? path.join(logDir, "bot-message-report.html"));
  const sourcePaths = discoverLogFiles(logDir);
  if (sourcePaths.length === 0) {
    throw new Error(`No bot log files found in LOG_DIR: ${logDir}`);
  }

  const now = options.now ?? new Date();
  const effectiveReportDays = getEffectiveReportDays(reportDays);
  const cutoffTime = now.getTime() - effectiveReportDays * 24 * 60 * 60 * 1000;
  const entries: ParsedLogEntry[] = [];
  const warn = options.onWarning ?? ((message: string) => console.warn(`[message-report] ${message}`));
  let invalidLinesSkipped = 0;

  for (const sourcePath of sourcePaths) {
    invalidLinesSkipped += await processLogFile(
      sourcePath,
      cutoffTime,
      entries,
      warn
    );
  }

  const { completedPairs, groups } = buildReportGroupsFromEntries(entries);
  const html = renderHtml(groups, effectiveReportDays, sourcePaths, now);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, html, { encoding: "utf8" });

  const messages = countMessages(groups);

  return {
    outputPath,
    sourcePaths,
    messages,
    completedPairs: completedPairs.length,
    unmatchedMessages: messages - completedPairs.length * 2,
    invalidLinesSkipped,
    cutoffUtc: new Date(cutoffTime).toISOString()
  };
}

async function runFromEnv(): Promise<void> {
  const result = await generateBotMessageReport();
  console.log(JSON.stringify({
    OutputPath: result.outputPath,
    SourcePaths: result.sourcePaths,
    Messages: result.messages,
    CompletedPairs: result.completedPairs,
    UnmatchedMessages: result.unmatchedMessages,
    InvalidLinesSkipped: result.invalidLinesSkipped,
    CutoffUtc: result.cutoffUtc
  }, null, 2));
}

if (require.main === module) {
  runFromEnv().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[message-report] ${message}`);
    process.exitCode = 1;
  });
}
