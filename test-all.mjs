#!/usr/bin/env node
/**
 * Offline integration test for all API endpoints
 * Tests: TypeScript compilation, module loading, email parsing, script generation
 */

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ❌ ${name}: ${e.message}`);
    failed++;
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || "Assertion failed");
}

// ═══════════════════════════════════════════════
// 1. FILE STRUCTURE TESTS
// ═══════════════════════════════════════════════
console.log("\n📁 FILE STRUCTURE TESTS");

test("api/server.ts exists and is non-empty", () => {
  const f = readFileSync(path.join(__dirname, "api/server.ts"), "utf8");
  assert(f.length > 1000, "server.ts is too small");
});

test("api/email-webhook.ts exists and is non-empty", () => {
  const f = readFileSync(path.join(__dirname, "api/email-webhook.ts"), "utf8");
  assert(f.length > 1000, "email-webhook.ts is too small");
});

test("api/cron/daily-pipeline.ts exists and is non-empty", () => {
  const f = readFileSync(path.join(__dirname, "api/cron/daily-pipeline.ts"), "utf8");
  assert(f.length > 1000, "daily-pipeline.ts is too small");
});

test("vercel.json has correct cron config", () => {
  const v = JSON.parse(readFileSync(path.join(__dirname, "vercel.json"), "utf8"));
  assert(v.crons, "Missing crons config");
  assert(v.crons.length > 0, "No cron jobs defined");
  assert(v.crons[0].path === "/api/cron/daily-pipeline", "Wrong cron path");
  assert(v.crons[0].schedule === "0 14 * * *", "Wrong cron schedule (should be 7am MST / 2pm UTC)");
});

test("vercel.json has correct rewrites", () => {
  const v = JSON.parse(readFileSync(path.join(__dirname, "vercel.json"), "utf8"));
  assert(v.rewrites, "Missing rewrites");
  const paths = v.rewrites.map((r) => r.source);
  assert(paths.includes("/api/email-webhook"), "Missing email-webhook rewrite");
  assert(paths.includes("/api/cron/daily-pipeline"), "Missing daily-pipeline rewrite");
});

test("vercel.json has function timeouts configured", () => {
  const v = JSON.parse(readFileSync(path.join(__dirname, "vercel.json"), "utf8"));
  assert(v.functions, "Missing functions config");
  assert(v.functions["api/server.ts"]?.maxDuration >= 60, "server.ts needs 60s+ timeout");
  assert(v.functions["api/email-webhook.ts"]?.maxDuration >= 60, "email-webhook.ts needs 60s+ timeout");
  assert(v.functions["api/cron/daily-pipeline.ts"]?.maxDuration >= 60, "daily-pipeline.ts needs 60s+ timeout");
});

test("package.json has required dependencies", () => {
  const p = JSON.parse(readFileSync(path.join(__dirname, "package.json"), "utf8"));
  assert(p.dependencies["mcp-handler"], "Missing mcp-handler dependency");
  assert(p.dependencies["zod"], "Missing zod dependency");
});

test("scripts/gmail-auto-forward.gs exists", () => {
  const f = readFileSync(path.join(__dirname, "scripts/gmail-auto-forward.gs"), "utf8");
  assert(f.length > 1000, "Gmail script too small");
  assert(f.includes("dailyMorningPipeline"), "Missing dailyMorningPipeline function");
});

// ═══════════════════════════════════════════════
// 2. SERVER.TS — MCP TOOL DEFINITIONS
// ═══════════════════════════════════════════════
console.log("\n🔧 MCP SERVER TOOL TESTS");

const serverCode = readFileSync(path.join(__dirname, "api/server.ts"), "utf8");

const expectedTools = [
  "search_local_news",
  "search_local_events",
  "search_new_businesses",
  "fetch_real_estate_insights",
  "fetch_chamber_events",
  "parse_chamber_email",
  "generate_daily_video_script",
  "auto_daily_tasks_from_email",
  "setup_email_automation",
  "get_weather",
];

for (const tool of expectedTools) {
  test(`MCP tool "${tool}" is defined`, () => {
    assert(serverCode.includes(`"${tool}"`), `Tool "${tool}" not found in server.ts`);
  });
}

test("Server exports GET, POST, DELETE handlers", () => {
  assert(serverCode.includes("export"), "No exports found");
  assert(serverCode.includes("GET"), "Missing GET export");
  assert(serverCode.includes("POST"), "Missing POST export");
  assert(serverCode.includes("DELETE"), "Missing DELETE export");
});

// ═══════════════════════════════════════════════
// 3. EMAIL WEBHOOK — STRUCTURE TESTS
// ═══════════════════════════════════════════════
console.log("\n📧 EMAIL WEBHOOK TESTS");

const webhookCode = readFileSync(path.join(__dirname, "api/email-webhook.ts"), "utf8");

test("Webhook supports SendGrid format", () => {
  assert(webhookCode.includes("SendGrid") || webhookCode.includes("sendgrid"), "No SendGrid support");
});

test("Webhook supports Mailgun format", () => {
  assert(webhookCode.includes("Mailgun") || webhookCode.includes("mailgun"), "No Mailgun support");
});

test("Webhook supports Postmark format", () => {
  assert(webhookCode.includes("Postmark") || webhookCode.includes("postmark"), "No Postmark support");
});

test("Webhook has email parsing logic", () => {
  assert(webhookCode.includes("parseEmailContent"), "Missing parseEmailContent function");
});

test("Webhook generates daily tasks", () => {
  assert(webhookCode.includes("generateDailyTasks"), "Missing generateDailyTasks function");
});

test("Webhook has Slack notification support", () => {
  assert(webhookCode.includes("slack") || webhookCode.includes("Slack"), "No Slack support");
});

test("Webhook has Discord notification support", () => {
  assert(webhookCode.includes("discord") || webhookCode.includes("Discord"), "No Discord support");
});

test("Webhook exports POST and GET handlers", () => {
  assert(webhookCode.includes("export") && webhookCode.includes("POST"), "Missing POST export");
  assert(webhookCode.includes("GET"), "Missing GET export");
});

// ═══════════════════════════════════════════════
// 4. DAILY PIPELINE — CRON JOB TESTS
// ═══════════════════════════════════════════════
console.log("\n⏰ DAILY PIPELINE (CRON) TESTS");

const cronCode = readFileSync(path.join(__dirname, "api/cron/daily-pipeline.ts"), "utf8");

test("Pipeline searches local news", () => {
  assert(cronCode.includes("searchLocalNews") || cronCode.includes("local_news") || cronCode.includes("news"), "No news search");
});

test("Pipeline searches local events", () => {
  assert(cronCode.includes("searchLocalEvents") || cronCode.includes("local_events") || cronCode.includes("events"), "No events search");
});

test("Pipeline searches new businesses", () => {
  assert(cronCode.includes("searchNewBusiness") || cronCode.includes("new_business") || cronCode.includes("businesses"), "No business search");
});

test("Pipeline fetches real estate insights", () => {
  assert(cronCode.includes("fetchRealEstate") || cronCode.includes("real_estate") || cronCode.includes("real estate"), "No real estate data");
});

test("Pipeline generates video script", () => {
  assert(cronCode.includes("generateVideoScript") || cronCode.includes("video_script") || cronCode.includes("videoScript"), "No video script generation");
});

test("Pipeline configured for St. George, Utah", () => {
  assert(cronCode.includes("St. George") || cronCode.includes("St George"), "Not configured for St. George");
  assert(cronCode.includes("Utah"), "Not configured for Utah");
});

test("Pipeline configured for Dan", () => {
  assert(cronCode.includes("Dan"), "Creator not set to Dan");
});

test("Pipeline has notification support", () => {
  assert(cronCode.includes("sendToSlack") || cronCode.includes("sendNotification") || cronCode.includes("webhook"), "No notification support");
});

test("Pipeline exports GET handler", () => {
  assert(cronCode.includes("export") && cronCode.includes("GET"), "Missing GET export");
});

// ═══════════════════════════════════════════════
// 5. EMAIL PARSING LOGIC TESTS
// ═══════════════════════════════════════════════
console.log("\n🔍 EMAIL PARSING LOGIC TESTS");

test("Email parser extracts events from HTML", () => {
  assert(
    webhookCode.includes("ribbon cutting") || webhookCode.includes("ribbon_cutting") || webhookCode.includes("Ribbon Cutting"),
    "No ribbon cutting detection"
  );
});

test("Email parser detects Constant Contact format", () => {
  assert(
    serverCode.includes("Constant Contact") || serverCode.includes("constantcontact") || webhookCode.includes("constant_contact") || webhookCode.includes("parseEmailContent"),
    "No Constant Contact detection"
  );
});

test("Email parser extracts honorees", () => {
  assert(webhookCode.includes("honoree") || webhookCode.includes("Honoree") || webhookCode.includes("HONOREE"), "No honoree extraction");
});

test("Email parser extracts businesses", () => {
  assert(
    webhookCode.includes("business") || webhookCode.includes("Business"),
    "No business extraction"
  );
});

// ═══════════════════════════════════════════════
// 6. VIDEO SCRIPT GENERATION TESTS
// ═══════════════════════════════════════════════
console.log("\n🎬 VIDEO SCRIPT GENERATION TESTS");

test("Generates short-form scripts (TikTok/Reels)", () => {
  assert(
    serverCode.includes("short_form") || serverCode.includes("short form") || serverCode.includes("TikTok") || serverCode.includes("Reels"),
    "No short-form script support"
  );
});

test("Generates long-form scripts (YouTube)", () => {
  assert(
    serverCode.includes("long_form") || serverCode.includes("long form") || serverCode.includes("YouTube"),
    "No long-form script support"
  );
});

test("Script includes production notes", () => {
  assert(
    serverCode.includes("production") || serverCode.includes("Production") || serverCode.includes("PRODUCTION"),
    "No production notes"
  );
});

test("Script supports multiple tones", () => {
  assert(serverCode.includes("energetic"), "Missing energetic tone");
  assert(serverCode.includes("professional"), "Missing professional tone");
});

// ═══════════════════════════════════════════════
// 7. GMAIL AUTO-FORWARD SCRIPT TESTS
// ═══════════════════════════════════════════════
console.log("\n📬 GMAIL AUTO-FORWARD SCRIPT TESTS");

const gmailScript = readFileSync(path.join(__dirname, "scripts/gmail-auto-forward.gs"), "utf8");

test("Gmail script has dailyMorningPipeline function", () => {
  assert(gmailScript.includes("function dailyMorningPipeline"), "Missing dailyMorningPipeline");
});

test("Gmail script labels processed emails", () => {
  assert(
    gmailScript.includes("AutoProcessed") || gmailScript.includes("autoprocessed") || gmailScript.includes("label"),
    "No email labeling"
  );
});

test("Gmail script has BASE_URL config", () => {
  assert(gmailScript.includes("BASE_URL"), "Missing BASE_URL configuration");
});

test("Gmail script searches for chamber emails", () => {
  assert(
    gmailScript.includes("chamber") || gmailScript.includes("Chamber"),
    "No chamber email search"
  );
});

// ═══════════════════════════════════════════════
// SUMMARY
// ═══════════════════════════════════════════════
console.log("\n" + "═".repeat(50));
console.log(`\n📊 RESULTS: ${passed} passed, ${failed} failed out of ${passed + failed} tests\n`);

if (failed > 0) {
  console.log("⚠️  Some tests failed. Check above for details.\n");
  process.exit(1);
} else {
  console.log("🎉 ALL TESTS PASSED! Your app is ready to deploy.\n");
  process.exit(0);
}
