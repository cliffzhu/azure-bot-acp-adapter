import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import {
  applyEmailReportCronBootstrap,
  createEmailReportCronBlock,
  upsertManagedEmailCronBlock
} from "../src/emailReportCronBootstrap";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "email-report-cron-"));
}

function makeEnv(logDir = "/app/logs"): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "production",
    LOG_DIR: logDir,
    LOG_REPORT_DAYS: "7",
    MAIL_SENDER_ENDPOINT: "https://mail.example.test/send",
    MAIL_SENDER_ENDPOINT_AUTHCODE: "secret-auth-code",
    MAIL_FROM_ADDRESS: "bot@example.test",
    MAIL_TO_ADDRESS: "ops@example.test"
  };
}

test("createEmailReportCronBlock creates a 10am Pacific gated cron command", () => {
  const block = createEmailReportCronBlock({
    reportDays: 7,
    logDir: "/app/logs",
    appDir: "/app",
    nodePath: "/usr/local/bin/node",
    env: makeEnv()
  });

  assert.match(block, /^# azure-bot-acp-adapter email message report cron:start\n/);
  assert.ok(block.includes("0 17,18 * * *"));
  assert.ok(block.includes("LOG_REPORT_DAYS='7'"));
  assert.ok(block.includes("LOG_DIR='/app/logs'"));
  assert.ok(block.includes("MAIL_REPORT_TIME_ZONE='America/Los_Angeles'"));
  assert.ok(block.includes("MAIL_REPORT_EXPECTED_HOUR='10'"));
  assert.ok(block.includes("MAIL_SENDER_ENDPOINT='https://mail.example.test/send'"));
  assert.ok(block.includes("MAIL_SENDER_ENDPOINT_AUTHCODE='secret-auth-code'"));
  assert.ok(block.includes("'/usr/local/bin/node' '/app/dist/sendBotMessageReportEmail.js'"));
  assert.ok(block.includes(">> '/app/logs/bot-message-report-email.cron.log' 2>&1"));
});

test("upsertManagedEmailCronBlock replaces only the email block", () => {
  const original = [
    "# azure-bot-acp-adapter message report cron:start",
    "0 17 * * * report command",
    "# azure-bot-acp-adapter message report cron:end",
    "# azure-bot-acp-adapter email message report cron:start",
    "0 17,18 * * * old email command",
    "# azure-bot-acp-adapter email message report cron:end",
    ""
  ].join("\n");
  const block = createEmailReportCronBlock({
    reportDays: 3,
    logDir: "/app/logs",
    appDir: "/app",
    nodePath: "/usr/local/bin/node",
    env: makeEnv()
  });

  const updated = upsertManagedEmailCronBlock(original, block);

  assert.equal((updated.match(/email message report cron:start/g) ?? []).length, 1);
  assert.ok(updated.includes("report command"));
  assert.ok(updated.includes("LOG_REPORT_DAYS='3'"));
  assert.ok(!updated.includes("old email command"));
});

test("applyEmailReportCronBootstrap writes crontab and initializes next Monday state", () => {
  const root = tempDir();
  const crontabPath = path.join(root, "root-crontab");
  const appDir = path.join(root, "app");
  const logDir = path.join(root, "logs");

  const result = applyEmailReportCronBootstrap({
    env: makeEnv(logDir),
    appDir,
    nodePath: "/usr/local/bin/node",
    crontabPath,
    platform: "linux",
    now: new Date("2026-08-27T17:00:00.000Z"),
    startCronDaemon: false,
    logger: { log: () => undefined, warn: () => undefined }
  });

  assert.deepEqual(result, {
    enabled: true,
    changed: true,
    crontabPath
  });

  const crontab = fs.readFileSync(crontabPath, "utf8");
  assert.ok(crontab.includes("0 17,18 * * *"));
  assert.ok(crontab.includes("sendBotMessageReportEmail.js"));

  const state = JSON.parse(fs.readFileSync(path.join(logDir, "bot-message-report-email-state.json"), "utf8"));
  assert.equal(state.nextSendDate, "2026-08-31");
});

test("applyEmailReportCronBootstrap removes email cron when mail settings are missing", () => {
  const root = tempDir();
  const crontabPath = path.join(root, "root-crontab");
  fs.writeFileSync(
    crontabPath,
    [
      "SHELL=/bin/sh",
      "# azure-bot-acp-adapter email message report cron:start",
      "0 17,18 * * * old email command",
      "# azure-bot-acp-adapter email message report cron:end",
      ""
    ].join("\n"),
    "utf8"
  );

  const result = applyEmailReportCronBootstrap({
    env: {
      LOG_REPORT_DAYS: "7",
      MAIL_SENDER_ENDPOINT: "https://mail.example.test/send"
    },
    crontabPath,
    platform: "linux",
    startCronDaemon: false,
    logger: { log: () => undefined, warn: () => undefined }
  });

  assert.equal(result.enabled, false);
  assert.equal(result.changed, true);
  assert.deepEqual(result.missing, [
    "MAIL_SENDER_ENDPOINT_AUTHCODE",
    "MAIL_FROM_ADDRESS",
    "MAIL_TO_ADDRESS"
  ]);

  const crontab = fs.readFileSync(crontabPath, "utf8");
  assert.ok(crontab.includes("SHELL=/bin/sh"));
  assert.ok(!crontab.includes("email message report cron:start"));
});
