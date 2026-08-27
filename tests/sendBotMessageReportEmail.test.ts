import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import {
  addDaysToDateKey,
  ensureEmailReportScheduleState,
  getMissingEmailReportEnv,
  nextMondayDateKey,
  sendBotMessageReportEmail
} from "../src/sendBotMessageReportEmail";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "send-report-email-"));
}

function makeEnv(logDir: string): NodeJS.ProcessEnv {
  return {
    LOG_DIR: logDir,
    LOG_REPORT_DAYS: "7",
    MAIL_SENDER_ENDPOINT: "https://mail.example.test/send",
    MAIL_SENDER_ENDPOINT_AUTHCODE: "secret-auth-code",
    MAIL_FROM_ADDRESS: "bot@example.test",
    MAIL_TO_ADDRESS: "ops@example.test",
    MAIL_REPORT_TIME_ZONE: "America/Los_Angeles",
    MAIL_REPORT_EXPECTED_HOUR: "10"
  };
}

test("date helpers calculate the next Monday and interval date keys", () => {
  assert.equal(nextMondayDateKey("2026-08-27"), "2026-08-31");
  assert.equal(nextMondayDateKey("2026-08-31"), "2026-09-07");
  assert.equal(addDaysToDateKey("2026-08-31", 7), "2026-09-07");
});

test("sendBotMessageReportEmail skips before the first scheduled Monday", async () => {
  const logDir = tempDir();
  fs.writeFileSync(path.join(logDir, "bot-message-report.html"), "<html>report</html>", "utf8");

  const result = await sendBotMessageReportEmail({
    env: makeEnv(logDir),
    now: new Date("2026-08-27T17:00:00.000Z"),
    fetchFn: async () => {
      throw new Error("fetch should not be called");
    },
    logger: { log: () => undefined, warn: () => undefined, error: () => undefined }
  });

  assert.equal(result.sent, false);
  assert.equal(result.skipped, true);
  assert.equal(result.reason, "not-due");
  assert.equal(result.nextSendDate, "2026-08-31");

  const state = JSON.parse(fs.readFileSync(path.join(logDir, "bot-message-report-email-state.json"), "utf8"));
  assert.equal(state.nextSendDate, "2026-08-31");
});

test("sendBotMessageReportEmail posts the report when schedule is due", async () => {
  const logDir = tempDir();
  const html = "<html><body>report</body></html>";
  fs.writeFileSync(path.join(logDir, "bot-message-report.html"), html, "utf8");
  ensureEmailReportScheduleState({
    logDir,
    reportDays: 7,
    now: new Date("2026-08-27T17:00:00.000Z"),
    timeZone: "America/Los_Angeles"
  });

  let capturedUrl = "";
  let capturedRequest: RequestInit | undefined;
  const result = await sendBotMessageReportEmail({
    env: makeEnv(logDir),
    now: new Date("2026-08-31T17:00:00.000Z"),
    fetchFn: async (url, request) => {
      capturedUrl = String(url);
      capturedRequest = request;
      return new Response("ok", { status: 200 });
    },
    logger: { log: () => undefined, warn: () => undefined, error: () => undefined }
  });

  assert.equal(result.sent, true);
  assert.equal(result.skipped, false);
  assert.equal(result.nextSendDate, "2026-09-07");
  assert.equal(capturedUrl, "https://mail.example.test/send");
  assert.equal(capturedRequest?.method, "POST");

  const headers = capturedRequest?.headers as Record<string, string>;
  assert.equal(headers.Authorization, "Bearer secret-auth-code");
  assert.equal(headers["X-Auth-Code"], "secret-auth-code");

  const body = JSON.parse(String(capturedRequest?.body));
  assert.equal(body.to, "ops@example.test");
  assert.equal(body.fromEmail, "bot@example.test");
  assert.equal(body.isHtml, true);
  assert.equal(body.body, html);
  assert.equal(body.subject, "Bot message report - 2026-08-31 - last 8 days");

  const state = JSON.parse(fs.readFileSync(path.join(logDir, "bot-message-report-email-state.json"), "utf8"));
  assert.equal(state.lastSentDate, "2026-08-31");
  assert.equal(state.nextSendDate, "2026-09-07");
});

test("sendBotMessageReportEmail skips outside the configured Pacific send hour", async () => {
  const logDir = tempDir();
  fs.writeFileSync(path.join(logDir, "bot-message-report.html"), "<html>report</html>", "utf8");
  ensureEmailReportScheduleState({
    logDir,
    reportDays: 7,
    now: new Date("2026-08-27T17:00:00.000Z"),
    timeZone: "America/Los_Angeles"
  });

  const result = await sendBotMessageReportEmail({
    env: makeEnv(logDir),
    now: new Date("2026-08-31T16:00:00.000Z"),
    fetchFn: async () => {
      throw new Error("fetch should not be called");
    },
    logger: { log: () => undefined, warn: () => undefined, error: () => undefined }
  });

  assert.equal(result.sent, false);
  assert.equal(result.skipped, true);
  assert.equal(result.reason, "outside-send-hour");
});

test("getMissingEmailReportEnv reports required mail settings", () => {
  assert.deepEqual(getMissingEmailReportEnv({}), [
    "MAIL_SENDER_ENDPOINT",
    "MAIL_SENDER_ENDPOINT_AUTHCODE",
    "MAIL_FROM_ADDRESS",
    "MAIL_TO_ADDRESS"
  ]);
  assert.deepEqual(getMissingEmailReportEnv(makeEnv("logs")), []);
});
