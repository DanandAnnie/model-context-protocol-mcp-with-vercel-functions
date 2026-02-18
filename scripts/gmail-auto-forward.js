/**
 * ═══════════════════════════════════════════════════════════════
 * GMAIL AUTO-FORWARD TO DAILY TASKS — for Dan in St. George
 * ═══════════════════════════════════════════════════════════════
 *
 * HOW TO SET THIS UP (takes ~3 minutes):
 *
 * 1. Go to https://script.google.com
 * 2. Click "New Project"
 * 3. Delete the default code and paste this ENTIRE file
 * 4. Update YOUR_VERCEL_URL below with your actual Vercel deployment URL
 * 5. Update YOUR_SLACK_WEBHOOK_URL with your Slack webhook (see below)
 * 6. Click the floppy disk icon (Save)
 * 7. Click "Run" to test it once (you'll need to authorize it)
 * 8. Click the clock icon (Triggers) on the left sidebar
 * 9. Click "+ Add Trigger" with these settings:
 *      • Function: checkChamberEmails
 *      • Event source: Time-driven
 *      • Type: Minutes timer
 *      • Interval: Every 15 minutes
 * 10. Click Save — done! It runs automatically forever.
 *
 * ─── GET YOUR SLACK WEBHOOK URL ───────────────────────────────
 *
 * 1. Go to https://api.slack.com/apps
 * 2. Click "Create New App" → "From scratch"
 * 3. Name it "Daily Tasks Bot", pick your workspace
 * 4. In the left sidebar, click "Incoming Webhooks"
 * 5. Toggle "Activate Incoming Webhooks" to ON
 * 6. Click "Add New Webhook to Workspace"
 * 7. Choose the channel (e.g. #daily-tasks or #general)
 * 8. Copy the webhook URL and paste it below
 *
 * ══════════════════════════════════════════════════════════════
 */

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ⚡ UPDATE THESE TWO VALUES WITH YOUR URLS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
var VERCEL_WEBHOOK_URL = "https://YOUR_VERCEL_URL.vercel.app/api/email-webhook";
var SLACK_WEBHOOK_URL  = "https://hooks.slack.com/services/YOUR/SLACK/WEBHOOK";
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// Your details (already configured)
var CREATOR_NAME = "Dan";
var CITY = "St. George area";

// Email senders to watch for (add more as needed)
var EMAIL_FILTERS = [
  "stgeorgechamber",
  "chamber of commerce",
  "st george area chamber",
  "sgchamber",
  // Add more senders here, e.g.:
  // "rotaryclub",
  // "bnichapter",
  // "downtownalliance",
];

/**
 * Main function — checks Gmail for new chamber emails and forwards them
 * to your Vercel webhook for auto-processing into daily tasks.
 */
function checkChamberEmails() {
  // Build search query from filter list
  var fromFilters = EMAIL_FILTERS.map(function(f) {
    return "from:*" + f + "*";
  }).join(" OR ");

  var searchQuery = "(" + fromFilters + ") newer_than:1d";

  Logger.log("Searching Gmail: " + searchQuery);

  var threads = GmailApp.search(searchQuery, 0, 10);
  Logger.log("Found " + threads.length + " matching threads");

  // Get or create the "AutoProcessed" label
  var label = GmailApp.getUserLabelByName("AutoProcessed");
  if (!label) {
    label = GmailApp.createLabel("AutoProcessed");
    Logger.log("Created 'AutoProcessed' label");
  }

  var processedCount = 0;

  for (var i = 0; i < threads.length; i++) {
    var thread = threads[i];

    // Skip if already processed
    var labels = thread.getLabels();
    var alreadyProcessed = false;
    for (var j = 0; j < labels.length; j++) {
      if (labels[j].getName() === "AutoProcessed") {
        alreadyProcessed = true;
        break;
      }
    }
    if (alreadyProcessed) {
      Logger.log("Skipping already-processed thread: " + thread.getFirstMessageSubject());
      continue;
    }

    // Get the latest message in the thread
    var messages = thread.getMessages();
    var msg = messages[messages.length - 1];

    Logger.log("Processing: " + msg.getSubject() + " from " + msg.getFrom());

    // Build the webhook URL with your details
    var webhookUrl = VERCEL_WEBHOOK_URL +
      "?city=" + encodeURIComponent(CITY) +
      "&creator=" + encodeURIComponent(CREATOR_NAME) +
      "&sender=" + encodeURIComponent(msg.getFrom());

    // Add Slack notification if configured
    if (SLACK_WEBHOOK_URL && SLACK_WEBHOOK_URL.indexOf("YOUR") === -1) {
      webhookUrl += "&notify=" + encodeURIComponent(SLACK_WEBHOOK_URL);
    }

    // Send to webhook
    var payload = {
      from: msg.getFrom(),
      subject: msg.getSubject(),
      body: msg.getBody(),       // HTML version
      text: msg.getPlainBody(),  // Plain text fallback
    };

    try {
      var response = UrlFetchApp.fetch(webhookUrl, {
        method: "post",
        contentType: "application/json",
        payload: JSON.stringify(payload),
        muteHttpExceptions: true,
      });

      var responseCode = response.getResponseCode();
      Logger.log("Webhook response: " + responseCode);

      if (responseCode === 200) {
        // Label as processed so we don't re-process it
        thread.addLabel(label);
        processedCount++;
        Logger.log("✅ Processed and labeled: " + msg.getSubject());
      } else {
        Logger.log("⚠️ Webhook returned " + responseCode + ": " + response.getContentText().substring(0, 200));
      }
    } catch (e) {
      Logger.log("❌ Error sending to webhook: " + e.message);
    }
  }

  Logger.log("Done! Processed " + processedCount + " new emails.");
}

/**
 * Manual test function — run this first to verify everything works.
 * It sends a sample email to your webhook.
 */
function testWebhook() {
  var testPayload = {
    from: "test@stgeorgechamber.com",
    subject: "Test — Weekly Chamber Update",
    body: "<h1>St. George Area Chamber Weekly Update</h1>" +
      "<h2>WHAT'S IN THE NEWS</h2>" +
      "<p>New Trail System Opens in Red Cliffs — St George News</p>" +
      "<p>The city has completed the new 5-mile trail connecting...</p>" +
      "<p>Read More</p>" +
      "<h2>EVENTS COMING UP!</h2>" +
      "<p>Annual Business Awards Gala — March 20, 2026 at 6:00 PM</p>" +
      "<p>Dixie Convention Center</p>" +
      "<p>Register here</p>" +
      "<p>Networking Mixer — March 15 at 5:30 PM</p>" +
      "<p>Ancestor Square</p>" +
      "<p>RSVP Now</p>" +
      "<h2>RIBBON CUTTINGS</h2>" +
      "<p>Red Desert Coffee — Grand Opening March 12 at 10:00 AM</p>" +
      "<p>123 Main St, St. George</p>",
    text: "Test email content",
  };

  var webhookUrl = VERCEL_WEBHOOK_URL +
    "?city=" + encodeURIComponent(CITY) +
    "&creator=" + encodeURIComponent(CREATOR_NAME) +
    "&sender=Test";

  if (SLACK_WEBHOOK_URL && SLACK_WEBHOOK_URL.indexOf("YOUR") === -1) {
    webhookUrl += "&notify=" + encodeURIComponent(SLACK_WEBHOOK_URL);
  }

  try {
    var response = UrlFetchApp.fetch(webhookUrl, {
      method: "post",
      contentType: "application/json",
      payload: JSON.stringify(testPayload),
      muteHttpExceptions: true,
    });

    Logger.log("Response code: " + response.getResponseCode());
    Logger.log("Response: " + response.getContentText().substring(0, 500));

    if (response.getResponseCode() === 200) {
      Logger.log("✅ SUCCESS! Your webhook is working. Check your Slack channel for the daily tasks.");
    } else {
      Logger.log("⚠️ Got a non-200 response. Check the response above for details.");
    }
  } catch (e) {
    Logger.log("❌ Error: " + e.message);
    Logger.log("Make sure you've updated VERCEL_WEBHOOK_URL with your actual Vercel URL.");
  }
}

/**
 * One-time setup — creates the AutoProcessed label.
 * Run this once if you want to manually create the label.
 */
function setupLabel() {
  var label = GmailApp.getUserLabelByName("AutoProcessed");
  if (!label) {
    GmailApp.createLabel("AutoProcessed");
    Logger.log("✅ Created 'AutoProcessed' label in Gmail");
  } else {
    Logger.log("Label 'AutoProcessed' already exists");
  }
}
