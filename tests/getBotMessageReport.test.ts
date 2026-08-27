import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { generateBotMessageReport, getEffectiveReportDays } from "../src/getBotMessageReport";

function writeLog(filePath: string, entries: Array<object | string>): void {
  fs.writeFileSync(
    filePath,
    entries.map((entry) => typeof entry === "string" ? entry : JSON.stringify(entry)).join("\n") + "\n",
    "utf8"
  );
}

test("generateBotMessageReport pairs messages and writes HTML", async () => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "bot-message-report-"));

  writeLog(path.join(logDir, "bot.log.older"), [
    {
      ts: "2026-01-02T10:00:00.000Z",
      direction: "incoming",
      method: "POST",
      path: "/api/messages",
      body: {
        type: "message",
        channelId: "msteams",
        conversation: { id: "conversation-1" },
        from: { id: "user-1" },
        text: "Hello 5 < 6\nsecond line"
      }
    },
    "{not valid json"
  ]);

  writeLog(path.join(logDir, "bot.log"), [
    {
      ts: "2026-01-02T10:00:02.500Z",
      direction: "outgoing-activity",
      source: "api/messages",
      channelId: "msteams",
      conversationId: "conversation-1",
      userId: "user-1",
      status: "success",
      body: {
        type: "message",
        text: "<p>Reply with HTML</p>"
      }
    },
    {
      ts: "2026-01-02T10:01:00.000Z",
      direction: "incoming",
      body: {
        type: "message",
        channelId: "msteams",
        conversation: { id: "conversation-2" },
        from: { id: "user-2" },
        text: "Waiting for reply"
      }
    },
    {
      ts: "2026-01-02T10:02:00.000Z",
      direction: "outgoing-activity",
      channelId: "msteams",
      conversationId: "conversation-3",
      userId: "user-3",
      status: "success",
      body: {
        type: "message",
        text: "Stray reply"
      }
    }
  ]);

  const result = await generateBotMessageReport({
    logDir,
    reportDays: 7,
    now: new Date("2026-01-10T00:00:00.000Z"),
    onWarning: () => undefined
  });

  assert.equal(result.messages, 4);
  assert.equal(result.completedPairs, 1);
  assert.equal(result.unmatchedMessages, 2);
  assert.equal(result.invalidLinesSkipped, 1);
  assert.deepEqual(
    result.sourcePaths.map((sourcePath) => path.basename(sourcePath)),
    ["bot.log.older", "bot.log"]
  );

  const html = fs.readFileSync(result.outputPath, "utf8");
  assert.equal(result.cutoffUtc, "2026-01-02T00:00:00.000Z");
  assert.ok(html.includes("4 messages from the last 8 day(s)"));
  assert.ok(html.includes("Hello 5 &lt; 6<br>second line"));
  assert.ok(html.includes("<p>Reply with HTML</p>"));
  assert.ok(html.includes("2.500 s"));
  assert.ok(html.includes("Unmatched"));
});

test("getEffectiveReportDays adds one extra day for positive windows", () => {
  assert.equal(getEffectiveReportDays(7), 8);
  assert.equal(getEffectiveReportDays(1), 2);
  assert.equal(getEffectiveReportDays(0), 0);
});

test("generateBotMessageReport consolidates rotated logs by timestamp before pairing", async () => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "bot-message-report-"));

  writeLog(path.join(logDir, "bot.log.older"), [
    {
      ts: "2026-01-02T10:00:02.500Z",
      direction: "outgoing-activity",
      channelId: "msteams",
      conversationId: "conversation-1",
      userId: "user-1",
      status: "success",
      body: {
        type: "message",
        text: "Reply from rotated file"
      }
    }
  ]);

  writeLog(path.join(logDir, "bot.log"), [
    {
      ts: "2026-01-02T10:00:00.000Z",
      direction: "incoming",
      body: {
        type: "message",
        channelId: "msteams",
        conversation: { id: "conversation-1" },
        from: { id: "user-1" },
        text: "Incoming from current file"
      }
    }
  ]);

  const result = await generateBotMessageReport({
    logDir,
    reportDays: 1,
    now: new Date("2026-01-03T00:00:00.000Z"),
    onWarning: () => undefined
  });

  assert.equal(result.messages, 2);
  assert.equal(result.completedPairs, 1);
  assert.equal(result.unmatchedMessages, 0);

  const html = fs.readFileSync(result.outputPath, "utf8");
  assert.ok(html.includes("Incoming from current file"));
  assert.ok(html.includes("Reply from rotated file"));
  assert.ok(html.includes("2.500 s"));
});
