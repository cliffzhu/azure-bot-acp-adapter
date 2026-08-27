import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import {
  applyReportCronBootstrap,
  createReportCronBlock,
  parsePositiveReportDays,
  upsertManagedCronBlock
} from "../src/reportCronBootstrap";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "report-cron-bootstrap-"));
}

test("parsePositiveReportDays only enables positive integer values", () => {
  assert.equal(parsePositiveReportDays(undefined), null);
  assert.equal(parsePositiveReportDays(""), null);
  assert.equal(parsePositiveReportDays("0"), null);
  assert.equal(parsePositiveReportDays("-1"), null);
  assert.equal(parsePositiveReportDays("1.5"), null);
  assert.equal(parsePositiveReportDays("abc"), null);
  assert.equal(parsePositiveReportDays("7"), 7);
});

test("createReportCronBlock schedules the compiled report script for 16:00 UTC", () => {
  const block = createReportCronBlock({
    reportDays: 7,
    logDir: "/app/logs",
    appDir: "/app",
    nodePath: "/usr/local/bin/node",
    nodeEnv: "production"
  });

  assert.match(block, /^# azure-bot-acp-adapter message report cron:start\n0 16 \* \* \*/);
  assert.ok(block.includes("LOG_REPORT_DAYS='7'"));
  assert.ok(block.includes("LOG_DIR='/app/logs'"));
  assert.ok(block.includes("NODE_ENV='production'"));
  assert.ok(block.includes("'/usr/local/bin/node' '/app/dist/getBotMessageReport.js'"));
  assert.ok(block.includes(">> '/app/logs/bot-message-report.cron.log' 2>&1"));
});

test("upsertManagedCronBlock replaces the managed block without duplicating it", () => {
  const original = [
    "SHELL=/bin/sh",
    "# azure-bot-acp-adapter message report cron:start",
    "0 17 * * * old command",
    "# azure-bot-acp-adapter message report cron:end",
    "15 2 * * * other command",
    ""
  ].join("\n");
  const block = createReportCronBlock({
    reportDays: 3,
    logDir: "/app/logs",
    appDir: "/app",
    nodePath: "/usr/local/bin/node"
  });

  const updated = upsertManagedCronBlock(original, block);

  assert.equal((updated.match(/message report cron:start/g) ?? []).length, 1);
  assert.ok(updated.includes("SHELL=/bin/sh"));
  assert.ok(updated.includes("15 2 * * * other command"));
  assert.ok(updated.includes("LOG_REPORT_DAYS='3'"));
  assert.ok(!updated.includes("old command"));
});

test("applyReportCronBootstrap writes crontab and does not start real cron when disabled in options", () => {
  const root = tempDir();
  const crontabPath = path.join(root, "root-crontab");
  const appDir = path.join(root, "app");

  const result = applyReportCronBootstrap({
    env: {
      LOG_REPORT_DAYS: "7",
      LOG_DIR: "logs",
      NODE_ENV: "production"
    },
    appDir,
    nodePath: "/usr/local/bin/node",
    crontabPath,
    platform: "linux",
    startCronDaemon: false,
    logger: { log: () => undefined, warn: () => undefined }
  });

  assert.deepEqual(result, {
    enabled: true,
    changed: true,
    crontabPath
  });

  const crontab = fs.readFileSync(crontabPath, "utf8");
  const expectedLogDir = path.join(appDir, "logs").replace(/\\/g, "/");
  assert.ok(crontab.includes("0 16 * * *"));
  assert.ok(crontab.includes(`LOG_DIR='${expectedLogDir}'`));
});

test("applyReportCronBootstrap removes managed block when LOG_REPORT_DAYS is not enabled", () => {
  const root = tempDir();
  const crontabPath = path.join(root, "root-crontab");
  fs.writeFileSync(
    crontabPath,
    [
      "SHELL=/bin/sh",
      "# azure-bot-acp-adapter message report cron:start",
      "0 17 * * * old command",
      "# azure-bot-acp-adapter message report cron:end",
      "15 2 * * * other command",
      ""
    ].join("\n"),
    "utf8"
  );

  const result = applyReportCronBootstrap({
    env: { LOG_REPORT_DAYS: "0" },
    crontabPath,
    platform: "linux",
    startCronDaemon: false,
    logger: { log: () => undefined, warn: () => undefined }
  });

  assert.equal(result.enabled, false);
  assert.equal(result.changed, true);

  const crontab = fs.readFileSync(crontabPath, "utf8");
  assert.ok(crontab.includes("SHELL=/bin/sh"));
  assert.ok(crontab.includes("15 2 * * * other command"));
  assert.ok(!crontab.includes("message report cron:start"));
});

test("applyReportCronBootstrap no-ops outside Linux", () => {
  const result = applyReportCronBootstrap({
    env: { LOG_REPORT_DAYS: "7" },
    platform: "win32",
    logger: { log: () => undefined, warn: () => undefined }
  });

  assert.equal(result.enabled, false);
  assert.equal(result.changed, false);
  assert.equal(result.reason, "unsupported-platform");
});
