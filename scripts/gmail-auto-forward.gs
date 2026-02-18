/**
 * Gmail → Daily Tasks Auto-Forward Script
 *
 * SETUP (one time):
 * 1. Go to https://script.google.com → New Project
 * 2. Delete the default code and paste this entire file
 * 3. UPDATE the CONFIG section below with your actual URLs
 * 4. Click Run → checkChamberEmails → Authorize when prompted
 * 5. Click Triggers (clock icon) → Add Trigger:
 *    - Function: checkChamberEmails
 *    - Event source: Time-driven
 *    - Type: Minutes timer → Every 15 minutes
 * 6. Done! Chamber emails will auto-generate daily tasks.
 */

// ═══════════════════════════════════════════════════════════════
// CONFIGURATION — UPDATE THESE VALUES
// ═══════════════════════════════════════════════════════════════

const CONFIG = {
  // Your deployed Vercel webhook URL
  // After deploying, replace with your actual URL like:
  // "https://your-app.vercel.app/api/email-webhook?city=St.+George+area&creator=Dan"
  WEBHOOK_URL:
    "https://YOUR-APP.vercel.app/api/email-webhook?city=St.+George+area&creator=Dan",

  // (Optional) Slack webhook URL for notifications
  // Get this from: https://api.slack.com/apps → Incoming Webhooks
  // Leave empty string "" if you don't want Slack notifications
  SLACK_WEBHOOK: "",

  // Gmail search query to find chamber emails
  // Customize this to match the emails you want to auto-process
  SEARCH_QUERY: "from:(*chamber* OR *stgeorgechamber*) newer_than:1d",

  // Maximum emails to process per run
  MAX_EMAILS: 5,

  // Label name for processed emails (auto-created)
  PROCESSED_LABEL: "AutoProcessed-DailyTasks",
};

// ═══════════════════════════════════════════════════════════════
// MAIN FUNCTION — Do not edit below unless you know what you do
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
      body: msg.getBody(), // HTML body
      text: msg.getPlainBody(), // Plain text fallback
    };

    // Build webhook URL with optional Slack notification
    var url = CONFIG.WEBHOOK_URL;
    if (CONFIG.SLACK_WEBHOOK) {
      url += "&notify=" + encodeURIComponent(CONFIG.SLACK_WEBHOOK);
    }

    try {
      var response = UrlFetchApp.fetch(url, {
        method: "post",
        contentType: "application/json",
        payload: JSON.stringify(payload),
        muteHttpExceptions: true,
      });

      var code = response.getResponseCode();
      if (code === 200) {
        // Label as processed
        thread.addLabel(label);
        processedCount++;

        var result = JSON.parse(response.getContentText());
        Logger.log(
          "Processed: " +
            msg.getSubject() +
            " → " +
            result.tasks.length +
            " tasks generated"
        );
      } else {
        Logger.log(
          "Webhook error for '" +
            msg.getSubject() +
            "': HTTP " +
            code +
            " - " +
            response.getContentText()
        );
      }
    } catch (e) {
      Logger.log("Error processing '" + msg.getSubject() + "': " + e.message);
    }
  }

  Logger.log(
    "Done. Processed " +
      processedCount +
      " of " +
      threads.length +
      " chamber emails."
  );
}

/**
 * One-time test function — run this manually to verify everything works.
 * Click Run → testWebhookConnection
 */
function testWebhookConnection() {
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

  var url = CONFIG.WEBHOOK_URL;
  if (CONFIG.SLACK_WEBHOOK) {
    url += "&notify=" + encodeURIComponent(CONFIG.SLACK_WEBHOOK);
  }

  try {
    var response = UrlFetchApp.fetch(url, {
      method: "post",
      contentType: "application/json",
      payload: JSON.stringify(testPayload),
      muteHttpExceptions: true,
    });

    var code = response.getResponseCode();
    var body = response.getContentText();

    if (code === 200) {
      var result = JSON.parse(body);
      Logger.log("SUCCESS! Webhook is working.");
      Logger.log("Tasks generated: " + result.tasks.length);
      for (var i = 0; i < result.tasks.length; i++) {
        var t = result.tasks[i];
        Logger.log(
          "  " +
            (t.priority === "high"
              ? "🔴"
              : t.priority === "medium"
                ? "🟡"
                : "🟢") +
            " [" +
            t.category +
            "] " +
            t.task
        );
      }
      if (result.notification && result.notification.success) {
        Logger.log("Slack notification sent successfully!");
      }
    } else {
      Logger.log("ERROR: HTTP " + code);
      Logger.log(body);
    }
  } catch (e) {
    Logger.log("Connection failed: " + e.message);
    Logger.log(
      "Make sure your WEBHOOK_URL in CONFIG is correct and the app is deployed."
    );
  }
}
