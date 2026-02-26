/**
 * Gmail → Full Daily Pipeline Auto-Forward Script
 *
 * This script does TWO things every day at 7:00 AM MST:
 * 1. Forwards any new chamber emails to your webhook for parsing
 * 2. Triggers the FULL daily pipeline (news, events, businesses, real estate, video script)
 *
 * SETUP (one time, ~3 minutes):
 * 1. Go to https://script.google.com → New Project
 * 2. Delete the default code and paste this entire file
 * 3. UPDATE the CONFIG section below with your actual Vercel URL
 * 4. Click Run → testWebhookConnection → Authorize when prompted
 * 5. Click Triggers (clock icon) → Add Trigger:
 *    - Function: dailyMorningPipeline
 *    - Event source: Time-driven
 *    - Type: Day timer → 7am to 8am
 * 6. (Optional) Add a second trigger for email checking:
 *    - Function: checkChamberEmails
 *    - Event source: Time-driven
 *    - Type: Minutes timer → Every 15 minutes
 *      (catches emails that arrive during the day)
 * 7. Done! You'll get your full daily script + tasks at 7am every morning.
 */

// ═══════════════════════════════════════════════════════════════
// CONFIGURATION — UPDATE THESE VALUES
// ═══════════════════════════════════════════════════════════════

var CONFIG = {
  // Your deployed Vercel app URL (NO trailing slash)
  // After deploying, replace with your actual URL like:
  // "https://your-app.vercel.app"
  BASE_URL: "https://YOUR-APP.vercel.app",

  // (Optional) Slack webhook URL for notifications
  // Get this from: https://api.slack.com/apps → Incoming Webhooks
  // Leave empty string "" if you don't want Slack notifications
  SLACK_WEBHOOK: "",

  // (Optional) CRON_SECRET — must match your Vercel env variable
  // Set in Vercel: Settings → Environment Variables → CRON_SECRET
  // Leave empty if you haven't set one
  CRON_SECRET: "",

  // Gmail search query to find chamber emails
  SEARCH_QUERY: "from:(*chamber* OR *stgeorgechamber*) newer_than:1d",

  // Maximum emails to process per run
  MAX_EMAILS: 5,

  // Label name for processed emails (auto-created)
  PROCESSED_LABEL: "AutoProcessed-DailyTasks",

  // Your info (must match the webhook defaults)
  CITY: "St. George area",
  CREATOR: "Dan",
};

// ═══════════════════════════════════════════════════════════════
// DAILY MORNING PIPELINE — Runs at 7am
// ═══════════════════════════════════════════════════════════════

/**
 * Main morning function — set this on a 7am daily trigger.
 * 1. Checks for new chamber emails and forwards them
 * 2. Triggers the full daily pipeline (all searches + script generation)
 */
function dailyMorningPipeline() {
  Logger.log("=== DAILY MORNING PIPELINE — " + new Date().toLocaleString() + " ===");

  // Step 1: Process any new chamber emails
  Logger.log("Step 1: Checking for new chamber emails...");
  checkChamberEmails();

  // Step 2: Trigger the full daily pipeline
  Logger.log("Step 2: Running full daily pipeline (news, events, businesses, real estate, script)...");
  triggerFullPipeline();

  Logger.log("=== PIPELINE COMPLETE ===");
}

/**
 * Trigger the Vercel cron daily-pipeline endpoint.
 * This runs all 5 searches and generates the full video script.
 */
function triggerFullPipeline() {
  var pipelineUrl = CONFIG.BASE_URL + "/api/cron/daily-pipeline";

  // Add auth if configured
  if (CONFIG.CRON_SECRET) {
    pipelineUrl += "?key=" + encodeURIComponent(CONFIG.CRON_SECRET);
  }

  // Add Slack notification if configured
  if (CONFIG.SLACK_WEBHOOK) {
    var sep = pipelineUrl.indexOf("?") >= 0 ? "&" : "?";
    pipelineUrl += sep + "notify=" + encodeURIComponent(CONFIG.SLACK_WEBHOOK);
  }

  try {
    var response = UrlFetchApp.fetch(pipelineUrl, {
      method: "get",
      muteHttpExceptions: true,
    });

    var code = response.getResponseCode();
    if (code === 200) {
      var result = JSON.parse(response.getContentText());
      Logger.log("Full pipeline SUCCESS!");
      Logger.log("  Duration: " + result.duration);
      Logger.log("  Total items found: " + result.data.totalItems);
      Logger.log("  - News: " + result.data.news);
      Logger.log("  - Events: " + result.data.events);
      Logger.log("  - Businesses: " + result.data.businesses);
      Logger.log("  - Real Estate: " + result.data.realEstate);
      Logger.log("  - Chamber Events: " + result.data.chamberEvents);
      Logger.log("  Tasks generated: " + result.tasks.length);
      if (result.notification && result.notification.success) {
        Logger.log("  Slack notification: SENT");
      }
    } else {
      Logger.log("Pipeline ERROR: HTTP " + code);
      Logger.log(response.getContentText().substring(0, 500));
    }
  } catch (e) {
    Logger.log("Pipeline connection failed: " + e.message);
  }
}

// ═══════════════════════════════════════════════════════════════
// EMAIL FORWARDING — Checks for and forwards new chamber emails
// ═══════════════════════════════════════════════════════════════

function checkChamberEmails() {
  var threads = GmailApp.search(CONFIG.SEARCH_QUERY, 0, CONFIG.MAX_EMAILS);

  if (threads.length === 0) {
    Logger.log("No new chamber emails found.");
    return;
  }

  // Get or create the processed label
  var label =
    GmailApp.getUserLabelByName(CONFIG.PROCESSED_LABEL) ||
    GmailApp.createLabel(CONFIG.PROCESSED_LABEL);

  var processedCount = 0;

  for (var i = 0; i < threads.length; i++) {
    var thread = threads[i];

    // Skip if already processed
    var labels = thread.getLabels();
    var alreadyProcessed = false;
    for (var j = 0; j < labels.length; j++) {
      if (labels[j].getName() === CONFIG.PROCESSED_LABEL) {
        alreadyProcessed = true;
        break;
      }
    }
    if (alreadyProcessed) continue;

    // Get the latest message in the thread
    var messages = thread.getMessages();
    var msg = messages[messages.length - 1];

    // Build the webhook payload
    var payload = {
      from: msg.getFrom(),
      subject: msg.getSubject(),
      body: msg.getBody(),
      text: msg.getPlainBody(),
    };

    // Build webhook URL
    var webhookUrl =
      CONFIG.BASE_URL +
      "/api/email-webhook?city=" +
      encodeURIComponent(CONFIG.CITY) +
      "&creator=" +
      encodeURIComponent(CONFIG.CREATOR);

    if (CONFIG.SLACK_WEBHOOK) {
      webhookUrl += "&notify=" + encodeURIComponent(CONFIG.SLACK_WEBHOOK);
    }

    try {
      var response = UrlFetchApp.fetch(webhookUrl, {
        method: "post",
        contentType: "application/json",
        payload: JSON.stringify(payload),
        muteHttpExceptions: true,
      });

      var code = response.getResponseCode();
      if (code === 200) {
        thread.addLabel(label);
        processedCount++;

        var result = JSON.parse(response.getContentText());
        Logger.log(
          "  Processed: " +
            msg.getSubject() +
            " → " +
            result.tasks.length +
            " tasks generated"
        );

        // Log pipeline data if available
        if (result.pipeline && result.pipeline.totalLiveItems) {
          Logger.log(
            "  + Live data: " +
              result.pipeline.totalLiveItems +
              " additional items from news/events/businesses/real estate searches"
          );
        }
      } else {
        Logger.log(
          "  Webhook error for '" +
            msg.getSubject() +
            "': HTTP " +
            code
        );
      }
    } catch (e) {
      Logger.log("  Error processing '" + msg.getSubject() + "': " + e.message);
    }
  }

  Logger.log(
    "Email check done. Processed " +
      processedCount +
      " of " +
      threads.length +
      " chamber emails."
  );
}

// ═══════════════════════════════════════════════════════════════
// TEST FUNCTIONS — Run these manually to verify setup
// ═══════════════════════════════════════════════════════════════

/**
 * Test 1: Verify the email webhook works.
 * Click Run → testWebhookConnection
 */
function testWebhookConnection() {
  Logger.log("Testing email webhook...");

  var testPayload = {
    from: "test@stgeorgechamber.com",
    subject: "Test Email — Webhook Verification",
    body:
      "EVENTS COMING UP! " +
      "Annual Business Awards Gala on March 20 at Dixie Convention Center. Register here. " +
      "Small Business Workshop March 5 at 9:00 AM at Chamber Office. Register here. " +
      "RIBBON CUTTINGS " +
      "Crumbl Cookies Grand Opening March 3 at Red Cliffs Mall. " +
      "TechHub Coworking Space Grand Opening March 10 downtown.",
  };

  var webhookUrl =
    CONFIG.BASE_URL +
    "/api/email-webhook?city=" +
    encodeURIComponent(CONFIG.CITY) +
    "&creator=" +
    encodeURIComponent(CONFIG.CREATOR);

  if (CONFIG.SLACK_WEBHOOK) {
    webhookUrl += "&notify=" + encodeURIComponent(CONFIG.SLACK_WEBHOOK);
  }

  try {
    var response = UrlFetchApp.fetch(webhookUrl, {
      method: "post",
      contentType: "application/json",
      payload: JSON.stringify(testPayload),
      muteHttpExceptions: true,
    });

    var code = response.getResponseCode();
    if (code === 200) {
      var result = JSON.parse(response.getContentText());
      Logger.log("SUCCESS! Email webhook is working.");
      Logger.log("Tasks generated: " + result.tasks.length);
      for (var i = 0; i < result.tasks.length; i++) {
        var t = result.tasks[i];
        Logger.log(
          "  " +
            (t.priority === "high" ? "🔴" : t.priority === "medium" ? "🟡" : "🟢") +
            " [" + t.category + "] " + t.task
        );
      }
      if (result.pipeline && result.pipeline.totalLiveItems) {
        Logger.log("Live search data: " + result.pipeline.totalLiveItems + " items");
      }
      if (result.notification && result.notification.success) {
        Logger.log("Slack notification: SENT");
      }
    } else {
      Logger.log("ERROR: HTTP " + code);
      Logger.log(response.getContentText().substring(0, 500));
    }
  } catch (e) {
    Logger.log("Connection failed: " + e.message);
    Logger.log("Make sure CONFIG.BASE_URL is correct and the app is deployed.");
  }
}

/**
 * Test 2: Verify the full daily pipeline works.
 * Click Run → testFullPipeline
 */
function testFullPipeline() {
  Logger.log("Testing full daily pipeline...");
  triggerFullPipeline();
}

/**
 * Test 3: Run the entire morning pipeline (emails + full pipeline).
 * Click Run → testMorningPipeline
 * This is exactly what will run every day at 7am.
 */
function testMorningPipeline() {
  Logger.log("Running full morning pipeline test...");
  dailyMorningPipeline();
}
