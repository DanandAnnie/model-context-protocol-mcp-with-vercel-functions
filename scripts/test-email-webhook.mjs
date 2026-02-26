#!/usr/bin/env node

/**
 * Test the email-to-daily-tasks webhook endpoint.
 *
 * Usage:
 *   node scripts/test-email-webhook.mjs                          # test against localhost
 *   node scripts/test-email-webhook.mjs https://your-app.vercel.app  # test against deployed
 */

const baseUrl = process.argv[2] || "http://localhost:3000";
const webhookUrl = `${baseUrl}/api/email-webhook?city=St.+George+area&creator=Dan`;

// Simulated St. George Area Chamber email (Constant Contact style)
const sampleChamberEmail = {
  from: "St. George Area Chamber <info@stgeorgechamber.com>",
  subject: "Chamber Weekly Update — What's Happening in St. George!",
  body: `
    <html>
    <body>
    <h1>St. George Area Chamber of Commerce</h1>
    <p>We are proud to announce the honorees for the <b>2026 Business Excellence Awards Gala</b>, presented by Zions Bank!</p>

    <p>* Carol Hollowell (Switchpoint): Carol has spent over a decade fighting homelessness in Washington County and continues to be a beacon of hope for our community.</p>

    <p>* Mike Johnson (Red Rock Realty): Mike has been a driving force behind real estate development in Southern Utah, mentoring new agents and supporting local charities.</p>

    <p>Please join us on March 20th at the Dixie Convention Center for a night of celebration!</p>

    <h2>WHAT'S IN THE NEWS</h2>

    <p>St. George named among top 10 fastest-growing cities in the nation for the third consecutive year, according to new Census Bureau data released this week.</p>
    <p>St George News</p>
    <p>David Wilson</p>
    <p>The latest population estimates show Washington County added over 8,000 new residents in 2025, bringing the total metro area population to nearly 220,000. City officials credit the thriving tech sector and quality of life.</p>
    <p>Read More</p>

    <p>New $45M medical campus breaks ground near Dinosaur Crossing, bringing 200+ healthcare jobs to the area. The facility will include urgent care, specialty clinics, and a surgery center.</p>
    <p>The Spectrum</p>
    <p>Read More</p>

    <p>Washington County School District announces plans for two new elementary schools to keep pace with rapid growth in the Santa Clara and Hurricane corridors.</p>
    <p>St George News</p>
    <p>Read More</p>

    <h2>EVENTS COMING UP!</h2>

    <p>Annual Business Excellence Awards Gala<br>
    March 20, 2026 | 6:00 PM<br>
    Dixie Convention Center<br>
    Black tie optional. Tickets at stgeorgechamber.com</p>
    <p>Register here</p>

    <p>Small Business Workshop: Digital Marketing 101<br>
    March 5, 2026 | 9:00 AM - 12:00 PM<br>
    Chamber Office, 136 N 100 E<br>
    Free for chamber members</p>
    <p>Register here</p>

    <p>Women in Business Luncheon<br>
    March 12, 2026 | 11:30 AM<br>
    Courtyard Marriott St. George</p>
    <p>RSVP Now</p>

    <p>Networking After Hours at Red Rock Brewing<br>
    March 8, 2026 | 5:00 PM - 7:00 PM<br>
    Complimentary appetizers, cash bar</p>
    <p>Sign Up</p>

    <h2>RIBBON CUTTINGS</h2>

    <p>Crumbl Cookies - New St. George Location<br>
    March 3, 2026 | 10:00 AM<br>
    Red Cliffs Mall, 1770 E Red Cliffs Dr</p>

    <p>Desert Hills Family Dentistry<br>
    March 7, 2026 | 11:00 AM<br>
    1234 S River Rd, Suite 200</p>

    <p>TechHub Coworking Space Grand Opening<br>
    March 10, 2026 | 4:00 PM<br>
    Downtown St. George, 50 E Tabernacle St</p>

    </body>
    </html>
  `,
};

console.log("=".repeat(60));
console.log("Testing Email-to-Daily-Tasks Webhook");
console.log("=".repeat(60));
console.log(`Endpoint: ${webhookUrl}`);
console.log(`Sender:   ${sampleChamberEmail.from}`);
console.log(`Subject:  ${sampleChamberEmail.subject}`);
console.log("=".repeat(60));
console.log("");

try {
  console.log("Sending sample chamber email...\n");

  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(sampleChamberEmail),
  });

  const data = await res.json();

  if (!res.ok) {
    console.error(`ERROR: HTTP ${res.status}`);
    console.error(JSON.stringify(data, null, 2));
    process.exit(1);
  }

  console.log("SUCCESS! Webhook processed the email.\n");

  // Show parsed counts
  console.log("Parsed from email:");
  const p = data.parsed;
  console.log(`  Featured stories: ${p.featuredStories}`);
  console.log(`  Honorees:         ${p.honorees}`);
  console.log(`  News articles:    ${p.newsArticles}`);
  console.log(`  Events:           ${p.events}`);
  console.log(`  Businesses:       ${p.businesses}`);
  console.log(`  Ribbon cuttings:  ${p.ribbonCuttings}`);
  console.log(`  Networking:       ${p.networking}`);
  console.log(`  Announcements:    ${p.announcements}`);
  console.log("");

  // Show generated tasks
  console.log(`Generated ${data.tasks.length} daily tasks:\n`);
  for (const task of data.tasks) {
    const emoji =
      task.priority === "high" ? "🔴" : task.priority === "medium" ? "🟡" : "🟢";
    console.log(`  ${emoji} #${task.id} [${task.category}] ${task.task}`);
    console.log(`     ${task.details}`);
    console.log(`     ⏱ ${task.estimatedTime}`);
    console.log("");
  }

  // Show full formatted text
  console.log("=".repeat(60));
  console.log("FULL FORMATTED OUTPUT:");
  console.log("=".repeat(60));
  console.log(data.tasksText);
} catch (err) {
  console.error("Failed to reach webhook:", err.message);
  console.error(
    "\nMake sure the server is running. Try:\n" +
      "  npx vercel dev    (local development)\n" +
      "  or deploy to Vercel first\n",
  );
  process.exit(1);
}
