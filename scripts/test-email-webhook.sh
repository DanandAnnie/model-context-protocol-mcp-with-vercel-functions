#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# Test your Email-to-Daily-Tasks webhook
# ═══════════════════════════════════════════════════════════════
#
# Usage:
#   ./scripts/test-email-webhook.sh https://your-deployment.vercel.app
#
# This sends a sample St. George Area Chamber email to your webhook
# and shows the generated daily tasks.
# ═══════════════════════════════════════════════════════════════

BASE_URL="${1:-http://localhost:3000}"

echo "═══════════════════════════════════════════════════════════"
echo "  Testing Email Webhook: ${BASE_URL}/api/email-webhook"
echo "═══════════════════════════════════════════════════════════"
echo ""

curl -s -X POST "${BASE_URL}/api/email-webhook?city=St.+George+area&creator=Dan&sender=St.+George+Area+Chamber" \
  -H "Content-Type: application/json" \
  -d '{
    "from": "newsletter@stgeorgechamber.com",
    "subject": "Weekly Chamber Update — What'\''s Happening in St. George",
    "body": "<h1>St. George Area Chamber of Commerce</h1><p>We are proud to announce the honorees for the Annual Business Awards Gala, presented by Zions Bank!</p><p>* Carol Hollowell (Switchpoint): Carol has dedicated 15 years to serving the homeless population in Southern Utah.</p><p>* Mike Johnson (Red Rock Realty): Mike has been instrumental in growing the local real estate market.</p><p>Please join us on March 20th at the Dixie Convention Center</p><h2>WHAT'\''S IN THE NEWS</h2><p>New Trail System Opens in Red Cliffs Desert Reserve</p><p>St George News</p><p>David Wilson</p><p>The city of St. George has completed construction on a new 5-mile trail system that connects Snow Canyon State Park to the Red Cliffs National Conservation Area.</p><p>Read More</p><p>Tech Startup Hub Coming to Downtown St. George</p><p>The Spectrum</p><p>A new 50,000 square foot tech incubator is being developed on Main Street, expected to bring 200+ jobs to the area by 2027.</p><p>Read More</p><h2>EVENTS COMING UP!</h2><p>Annual Business Awards Gala</p><p>March 20, 2026 at 6:00 PM</p><p>Dixie Convention Center</p><p>Register here</p><p>After Hours Networking Mixer</p><p>March 15 at 5:30 PM</p><p>Ancestor Square</p><p>RSVP Now</p><p>Small Business Workshop: Social Media Marketing</p><p>March 22, 2026 at 9:00 AM</p><p>Chamber Office</p><p>Sign Up</p><h2>RIBBON CUTTINGS</h2><p>Red Desert Coffee Co. — Grand Opening</p><p>March 12 at 10:00 AM</p><p>123 E St George Blvd</p><p></p><p>Mountain View Dental — New Location</p><p>March 14 at 11:00 AM</p><p>456 S River Rd</p>"
  }' | python3 -m json.tool 2>/dev/null || echo "(install python3 for pretty JSON, or pipe to jq)"

echo ""
echo "═══════════════════════════════════════════════════════════"
echo "  Done! Check the output above for your generated tasks."
echo "═══════════════════════════════════════════════════════════"
