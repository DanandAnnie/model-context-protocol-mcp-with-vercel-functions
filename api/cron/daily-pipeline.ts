/**
 * Daily Pipeline — Vercel Cron Job
 *
 * Runs every day at 7:00 AM MST (14:00 UTC) and automatically:
 * 1. Fetches chamber events from RSS/iCal feeds
 * 2. Searches local news for St. George area
 * 3. Searches local events (grand openings, ribbon cuttings, etc.)
 * 4. Searches new businesses opening in the area
 * 5. Fetches real estate market insights
 * 6. Generates a full daily video script (short-form + long-form)
 * 7. Sends the complete package to Slack
 *
 * Trigger: Vercel Cron at 0 14 * * * (7am MST)
 * Manual trigger: GET /api/cron/daily-pipeline?key=YOUR_CRON_SECRET
 */

// ── Utility helpers ────────────────────────────────────────────────────────

function extractTagContent(xml: string, tag: string): string[] {
  const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "gi");
  const matches: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = regex.exec(xml)) !== null) {
    matches.push(m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").trim());
  }
  return matches;
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function todayDate(): string {
  return new Date().toISOString().split("T")[0];
}

// ── Configuration ──────────────────────────────────────────────────────────

const CONFIG = {
  creatorName: "Dan",
  city: "St. George",
  state: "Utah",
  location: "St. George area",
  niche: "real estate",
  tone: "energetic" as const,
  chamberUrl: "https://business.stgeorgechamber.com",
  chamberName: "St. George Area Chamber",
};

// ── Search functions ───────────────────────────────────────────────────────

interface NewsItem {
  title: string;
  link: string;
  published: string;
  summary: string;
  category?: string;
}

async function searchLocalNews(city: string, topics: string[] = []): Promise<NewsItem[]> {
  const searchTerms = [city, ...topics].join(" ");
  const encoded = encodeURIComponent(searchTerms);
  const rssUrl = `https://news.google.com/rss/search?q=${encoded}&hl=en-US&gl=US&ceid=US:en`;

  try {
    const res = await fetch(rssUrl);
    if (!res.ok) return [];
    const xml = await res.text();
    const titles = extractTagContent(xml, "title").slice(1);
    const links = extractTagContent(xml, "link").slice(1);
    const pubDates = extractTagContent(xml, "pubDate");
    const descriptions = extractTagContent(xml, "description");

    return titles.slice(0, 10).map((title, i) => ({
      title: stripHtml(title),
      link: links[i] ?? "",
      published: pubDates[i] ?? "",
      summary: stripHtml(descriptions[i] ?? ""),
    }));
  } catch {
    return [];
  }
}

async function searchLocalEvents(location: string): Promise<NewsItem[]> {
  const eventTypes = [
    "events",
    "grand opening",
    "ribbon cutting",
    "community event",
  ];

  const fetches = eventTypes.map(async (eventType) => {
    const query = encodeURIComponent(`${location} ${eventType}`);
    const rssUrl = `https://news.google.com/rss/search?q=${query}&hl=en-US&gl=US&ceid=US:en`;
    try {
      const res = await fetch(rssUrl);
      if (!res.ok) return [];
      const xml = await res.text();
      const titles = extractTagContent(xml, "title").slice(1);
      const links = extractTagContent(xml, "link").slice(1);
      const pubDates = extractTagContent(xml, "pubDate");
      const descriptions = extractTagContent(xml, "description");
      return titles.map((title, i) => ({
        title: stripHtml(title),
        link: links[i] ?? "",
        published: pubDates[i] ?? "",
        summary: stripHtml(descriptions[i] ?? ""),
        category: eventType,
      }));
    } catch {
      return [];
    }
  });

  const all = (await Promise.all(fetches)).flat();
  const seen = new Set<string>();
  return all.filter((item) => {
    const key = item.title.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 10);
}

async function searchNewBusinesses(location: string): Promise<NewsItem[]> {
  const types = ["new business opening", "new restaurant", "coming soon", "now open"];

  const fetches = types.map(async (searchTerm) => {
    const query = encodeURIComponent(`${location} ${searchTerm}`);
    const rssUrl = `https://news.google.com/rss/search?q=${query}&hl=en-US&gl=US&ceid=US:en`;
    try {
      const res = await fetch(rssUrl);
      if (!res.ok) return [];
      const xml = await res.text();
      const titles = extractTagContent(xml, "title").slice(1);
      const links = extractTagContent(xml, "link").slice(1);
      const pubDates = extractTagContent(xml, "pubDate");
      const descriptions = extractTagContent(xml, "description");
      return titles.map((title, i) => ({
        title: stripHtml(title),
        link: links[i] ?? "",
        published: pubDates[i] ?? "",
        summary: stripHtml(descriptions[i] ?? ""),
        category: searchTerm,
      }));
    } catch {
      return [];
    }
  });

  const all = (await Promise.all(fetches)).flat();
  const seen = new Set<string>();
  return all.filter((item) => {
    const key = item.title.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 10);
}

async function fetchRealEstateInsights(location: string): Promise<NewsItem[]> {
  const topics = [
    "real estate market",
    "home prices trends",
    "new housing development",
    "real estate investment",
  ];

  const fetches = topics.map(async (topic) => {
    const query = encodeURIComponent(`${location} ${topic}`);
    const rssUrl = `https://news.google.com/rss/search?q=${query}&hl=en-US&gl=US&ceid=US:en`;
    try {
      const res = await fetch(rssUrl);
      if (!res.ok) return [];
      const xml = await res.text();
      const titles = extractTagContent(xml, "title").slice(1);
      const links = extractTagContent(xml, "link").slice(1);
      const pubDates = extractTagContent(xml, "pubDate");
      const descriptions = extractTagContent(xml, "description");
      return titles.map((title, i) => ({
        title: stripHtml(title),
        link: links[i] ?? "",
        published: pubDates[i] ?? "",
        summary: stripHtml(descriptions[i] ?? ""),
        category: topic,
      }));
    } catch {
      return [];
    }
  });

  const all = (await Promise.all(fetches)).flat();
  const seen = new Set<string>();
  return all.filter((item) => {
    const key = item.title.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 10);
}

async function fetchChamberEvents(chamberUrl: string): Promise<NewsItem[]> {
  const base = chamberUrl.replace(/\/$/, "");
  const feedUrls = [
    `${base}/events/rss`,
    `${base}/events/rss/`,
    `${base}/events.rss`,
    `${base}/events/ical`,
  ];

  for (const feedUrl of feedUrls) {
    try {
      const res = await fetch(feedUrl, {
        headers: { "User-Agent": "MCP-VideoScript/1.0" },
      });
      if (!res.ok) continue;

      const text = await res.text();

      if (text.includes("BEGIN:VCALENDAR") || text.includes("BEGIN:VEVENT")) {
        const eventBlocks = text.split("BEGIN:VEVENT").slice(1);
        return eventBlocks.slice(0, 15).map((block) => {
          const getField = (field: string) => {
            const match = block.match(new RegExp(`${field}[^:]*:(.+?)(?:\\r?\\n|$)`));
            return match?.[1]?.trim() ?? "";
          };
          return {
            title: getField("SUMMARY"),
            link: getField("URL"),
            published: getField("DTSTART"),
            summary: getField("DESCRIPTION").replace(/\\n/g, " ").replace(/\\,/g, ",").substring(0, 200),
          };
        });
      } else if (text.includes("<rss") || text.includes("<feed") || text.includes("<item")) {
        const titles = extractTagContent(text, "title").slice(1);
        const links = extractTagContent(text, "link").slice(1);
        const pubDates = extractTagContent(text, "pubDate");
        const descriptions = extractTagContent(text, "description");
        return titles.slice(0, 15).map((title, i) => ({
          title: stripHtml(title),
          link: links[i] ?? "",
          published: pubDates[i] ?? "",
          summary: stripHtml(descriptions[i] ?? "").substring(0, 200),
        }));
      }
    } catch {
      continue;
    }
  }

  // Fallback: Google News search for chamber events
  return searchLocalNews(`${CONFIG.chamberName} events`);
}

// ── Script generation ──────────────────────────────────────────────────────

function generateVideoScript(
  news: NewsItem[],
  events: NewsItem[],
  businesses: NewsItem[],
  realEstate: NewsItem[],
  chamberEvents: NewsItem[],
): string {
  const date = todayDate();
  const { creatorName, city, location, niche, tone } = CONFIG;

  const toneGuide = {
    professional: {
      greeting: `Good morning, I'm ${creatorName}, your local ${niche} expert in ${city}.`,
      energy: "Speak clearly and confidently. Maintain authority.",
      cta: `For more market insights, follow me and reach out anytime.`,
    },
    casual: {
      greeting: `Hey what's up, it's ${creatorName} here in ${city}!`,
      energy: "Keep it relaxed and conversational, like talking to a friend.",
      cta: `Drop a comment if you've seen any of these spots! Follow for more local updates.`,
    },
    energetic: {
      greeting: `What's going on everybody! It's ${creatorName} coming to you LIVE from ${city}!`,
      energy: "High energy! Speak with excitement, use hand gestures, lean into the camera.",
      cta: `SMASH that follow button and comment your favorite spot in ${city}! Let's connect!`,
    },
    educational: {
      greeting: `Welcome back. I'm ${creatorName}, and today we're breaking down what's happening in ${city}.`,
      energy: "Informative and measured. Use data points and explain context.",
      cta: `If this was helpful, share it with someone looking at ${city}. Follow for weekly updates.`,
    },
  };

  const t = toneGuide[tone];

  // Pick top items
  const topNews = news.slice(0, 3).map((n) => `${n.title}`);
  const topEvents = [...chamberEvents.slice(0, 3), ...events.slice(0, 2)].map((e) => `${e.title}`);
  const topBiz = businesses.slice(0, 3).map((b) => `${b.title}`);
  const topRE = realEstate.slice(0, 3).map((r) => `${r.title}`);

  const newsSection = topNews.length > 0
    ? topNews.map((n, i) => `   ${i + 1}. ${n}`).join("\n")
    : "   [No local news found today — mention 1-2 things you've seen around town]";

  const eventsSection = topEvents.length > 0
    ? topEvents.map((e, i) => `   ${i + 1}. ${e}`).join("\n")
    : "   [No events found — mention upcoming community activities]";

  const bizSection = topBiz.length > 0
    ? topBiz.map((b, i) => `   ${i + 1}. ${b}`).join("\n")
    : "   [No new businesses found — mention construction or coming-soon signs]";

  const reSection = topRE.length > 0
    ? topRE.map((r, i) => `   ${i + 1}. ${r}`).join("\n")
    : "   [No real estate data today — share your own market observations]";

  return `
${"═".repeat(60)}
📋 DAILY VIDEO SCRIPT PACKAGE — ${date}
   Creator: ${creatorName} | Location: ${location} | Niche: ${niche}
${"═".repeat(60)}

📊 CONTENT INVENTORY:
   • Local news items: ${news.length}
   • Chamber events: ${chamberEvents.length}
   • Local events: ${events.length}
   • New businesses: ${businesses.length}
   • ${niche} insights: ${realEstate.length}
   • Total content pieces: ${news.length + events.length + businesses.length + realEstate.length + chamberEvents.length}

${"═".repeat(60)}
📱 SHORT-FORM SCRIPT (60-90 seconds — TikTok / Reels / Shorts)
${"═".repeat(60)}

🎬 HOOK (0-3 seconds):
"Here's what's happening in ${city} TODAY that you NEED to know about!"
[Look directly at camera, point at viewer]

📍 SEGMENT 1 — The Headline (3-15 seconds):
${topNews[0] ? `"${topNews[0]}"` : "[Insert today's biggest local news headline]"}
[Quick cut or walk-and-talk]

${topBiz[0] ? `🏪 SEGMENT 2 — New in Town (15-30 seconds):\n"${topBiz[0]}"\n[Show the location or B-roll if possible]` : ""}

${topEvents[0] ? `🎉 SEGMENT 3 — Don't Miss This (30-45 seconds):\n"${topEvents[0]}"\n[Overlay event details on screen]` : ""}

${topRE[0] ? `🏠 SEGMENT 4 — ${niche.charAt(0).toUpperCase() + niche.slice(1)} Quick Take (45-60 seconds):\n"${topRE[0]}"\n[Use on-screen text for key numbers]` : ""}

🎤 CTA (last 5-10 seconds):
"${t.cta}"
[Point at camera, smile, cut]

🎵 PRODUCTION NOTES:
- Tone: ${t.energy}
- Add trending audio if on TikTok/Reels
- Use captions — 80% of viewers watch on mute
- Keep transitions snappy (0.5s max)

${"═".repeat(60)}
🎥 LONG-FORM SCRIPT (5-10 minutes — YouTube / Facebook / Podcast)
${"═".repeat(60)}

🎬 COLD OPEN / HOOK (0-30 seconds):
"If you live in ${city} — or you're thinking about moving here — you need to see what's happening right now."
[Drone shot or driving footage of ${city} if available]

👋 INTRO (30 sec - 1 min):
"${t.greeting}"
"Every day, I bring you the latest on what's happening in our community — from new businesses opening their doors, to events you don't want to miss, to what the ${niche} market is doing. Let's dive in!"
[Intro graphic / music sting]

${"─".repeat(40)}
📰 SEGMENT 1: LOCAL NEWS & HEADLINES (1-2 min)
${"─".repeat(40)}
"Let's start with what's making headlines..."

${newsSection}

[Transition: "Now here's something exciting..."]

${"─".repeat(40)}
🏪 SEGMENT 2: NEW BUSINESSES & OPENINGS (1-2 min)
${"─".repeat(40)}
"You know I love spotlighting businesses that are investing in our community..."

${bizSection}

[Tip: Visit these spots and film quick walkthroughs for B-roll]
[Transition: "And speaking of things happening around town..."]

${"─".repeat(40)}
🎉 SEGMENT 3: EVENTS & COMMUNITY (1-2 min)
${"─".repeat(40)}
"Here's what's coming up that you should have on your calendar..."

${eventsSection}

[Transition: "Now let's talk about what everyone always asks me about..."]

${"─".repeat(40)}
🏠 SEGMENT 4: ${niche.toUpperCase()} MARKET UPDATE (2-3 min)
${"─".repeat(40)}
"Alright, let's get into the ${niche} market. Here's what you need to know..."

${reSection}

[Use screen recordings, charts, or on-screen graphics for data points]
[Share personal insight: What does this mean for buyers/sellers/investors?]

${"─".repeat(40)}
🎤 OUTRO & CTA (30 sec)
${"─".repeat(40)}
"That's your ${city} update for ${date}!"
"${t.cta}"
"I'm ${creatorName} — I'll see you in the next one!"
[End screen: Subscribe + Related Videos]

📋 PRODUCTION NOTES:
- Total target: 5-10 minutes
- Tone: ${t.energy}
- Film B-roll of mentioned locations when possible
- Add lower-third graphics for business names and addresses
- Include chapter timestamps in the description
- Thumbnail idea: Your face + "${city} UPDATE" text + key image from the top story

${"═".repeat(60)}
📌 POST-PRODUCTION CHECKLIST:
${"═".repeat(60)}
□ Film all segments (or compile from existing footage)
□ Add captions / subtitles for accessibility
□ Create eye-catching thumbnail
□ Write SEO-optimized title and description
□ Add relevant hashtags: #${city.replace(/\s+/g, "")} #${niche.replace(/\s+/g, "")} #LocalBusiness #CommunityUpdate #SouthernUtah
□ Schedule post for optimal time (typically 9 AM or 6 PM local)
□ Cross-post to all platforms (YouTube, TikTok, Instagram, Facebook)
□ Engage with comments within first hour of posting
`;
}

// ── Daily tasks generation ─────────────────────────────────────────────────

interface DailyTask {
  id: number;
  priority: "high" | "medium" | "low";
  category: string;
  task: string;
  details: string;
  estimatedTime: string;
}

function generateDailyTasks(
  news: NewsItem[],
  events: NewsItem[],
  businesses: NewsItem[],
  realEstate: NewsItem[],
  chamberEvents: NewsItem[],
): DailyTask[] {
  const tasks: DailyTask[] = [];
  let id = 1;
  const total = news.length + events.length + businesses.length + realEstate.length + chamberEvents.length;

  tasks.push({
    id: id++,
    priority: "high",
    category: "PREP",
    task: `Review today's content digest (${total} items found across all sources)`,
    details: "Scan the script and pick your top 3-5 talking points. Star the ones you want to film on-location.",
    estimatedTime: "10 min",
  });

  // Top news stories
  for (const n of news.slice(0, 3)) {
    tasks.push({
      id: id++, priority: "medium", category: "NEWS",
      task: `Report on: ${n.title}`,
      details: n.summary ? n.summary.substring(0, 150) : "Read the full article and summarize key points.",
      estimatedTime: "5 min",
    });
  }

  // Chamber events
  for (const e of chamberEvents.slice(0, 3)) {
    tasks.push({
      id: id++, priority: "high", category: "CHAMBER EVENT",
      task: `Promote: ${e.title}`,
      details: e.summary ? e.summary.substring(0, 150) : "Feature in events segment.",
      estimatedTime: "5 min",
    });
  }

  // Local events
  for (const e of events.slice(0, 3)) {
    tasks.push({
      id: id++, priority: "medium", category: "EVENT",
      task: `Cover event: ${e.title}`,
      details: "Include in today's events roundup.",
      estimatedTime: "3 min",
    });
  }

  // New businesses
  for (const b of businesses.slice(0, 3)) {
    tasks.push({
      id: id++, priority: "medium", category: "BUSINESS",
      task: `Spotlight: ${b.title}`,
      details: "Visit location if possible, get B-roll.",
      estimatedTime: "20 min",
    });
  }

  // Real estate
  for (const r of realEstate.slice(0, 2)) {
    tasks.push({
      id: id++, priority: "medium", category: "REAL ESTATE",
      task: `Market update: ${r.title}`,
      details: r.summary ? r.summary.substring(0, 150) : "Break down the numbers for your audience.",
      estimatedTime: "5 min",
    });
  }

  // Final production task
  tasks.push({
    id: id++,
    priority: "high",
    category: "PRODUCE",
    task: `Film & publish today's ${CONFIG.location} update video`,
    details: "Short-form (60-90s) + Long-form (5-10 min). Script is ready — just film!",
    estimatedTime: "60 min",
  });

  return tasks;
}

// ── Slack notification ─────────────────────────────────────────────────────

async function sendToSlack(
  webhookUrl: string,
  script: string,
  tasks: DailyTask[],
): Promise<{ success: boolean; error?: string }> {
  const date = todayDate();
  const high = tasks.filter((t) => t.priority === "high");
  const medium = tasks.filter((t) => t.priority === "medium");

  const taskList = tasks
    .slice(0, 15)
    .map(
      (t) =>
        `${t.priority === "high" ? ":red_circle:" : t.priority === "medium" ? ":large_yellow_circle:" : ":large_green_circle:"} *[${t.category}]* ${t.task}`,
    )
    .join("\n");

  // Slack has a 3000 char limit per section, so we truncate the script
  const scriptPreview = script.substring(0, 2800);

  const payload = {
    text: `Daily Video Script for ${CONFIG.creatorName} — ${date}`,
    blocks: [
      {
        type: "header",
        text: { type: "plain_text", text: `📋 Daily Script & Tasks — ${date}` },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Creator:* ${CONFIG.creatorName} | *City:* ${CONFIG.location}\n*Tasks:* ${tasks.length} total (🔴 ${high.length} high, 🟡 ${medium.length} medium)`,
        },
      },
      { type: "divider" },
      {
        type: "section",
        text: { type: "mrkdwn", text: `*Today's Tasks:*\n${taskList}` },
      },
      { type: "divider" },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Script Preview:*\n\`\`\`${scriptPreview}\`\`\``,
        },
      },
    ],
  };

  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      return { success: false, error: `Slack returned HTTP ${res.status}` };
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── Generic webhook notification ───────────────────────────────────────────

async function sendToWebhook(
  webhookUrl: string,
  script: string,
  tasks: DailyTask[],
  news: NewsItem[],
  events: NewsItem[],
  businesses: NewsItem[],
  realEstate: NewsItem[],
  chamberEvents: NewsItem[],
): Promise<{ success: boolean; error?: string }> {
  const payload = {
    event: "daily_pipeline_complete",
    date: todayDate(),
    creator: CONFIG.creatorName,
    city: CONFIG.location,
    data: {
      news: news.length,
      events: events.length,
      businesses: businesses.length,
      realEstate: realEstate.length,
      chamberEvents: chamberEvents.length,
    },
    tasks,
    script,
  };

  try {
    // Detect Slack vs Discord vs generic
    if (webhookUrl.includes("hooks.slack.com")) {
      return sendToSlack(webhookUrl, script, tasks);
    }

    if (webhookUrl.includes("discord.com/api/webhooks")) {
      const high = tasks.filter((t) => t.priority === "high");
      const taskLines = tasks.slice(0, 15).map(
        (t) => `${t.priority === "high" ? "🔴" : t.priority === "medium" ? "🟡" : "🟢"} **[${t.category}]** ${t.task}`,
      ).join("\n");

      const discordPayload = {
        content: `📋 **Daily Script & Tasks for ${CONFIG.creatorName}** — ${todayDate()}`,
        embeds: [{
          title: `📋 Daily Pipeline Complete — ${todayDate()}`,
          description: `**Creator:** ${CONFIG.creatorName}\n**City:** ${CONFIG.location}\n**Tasks:** ${tasks.length} (🔴 ${high.length} high)`,
          color: 3447003,
          fields: [
            { name: "Tasks", value: taskLines.substring(0, 1024) },
            { name: "Script", value: script.substring(0, 1024) },
          ],
        }],
      };

      const res = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(discordPayload),
      });
      return res.ok ? { success: true } : { success: false, error: `HTTP ${res.status}` };
    }

    // Generic webhook
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return res.ok ? { success: true } : { success: false, error: `HTTP ${res.status}` };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── Main handler ───────────────────────────────────────────────────────────

export async function GET(request: Request): Promise<Response> {
  const startTime = Date.now();

  // Verify cron secret for security (optional but recommended)
  const url = new URL(request.url);
  const authHeader = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;

  // Allow Vercel cron (sends authorization header) or manual with ?key= param
  if (cronSecret && authHeader !== `Bearer ${cronSecret}` && url.searchParams.get("key") !== cronSecret) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Optional: override notification URL via query param
  const notifyUrl =
    url.searchParams.get("notify") ?? process.env.NOTIFICATION_WEBHOOK ?? "";

  try {
    console.log(`[Daily Pipeline] Starting at ${new Date().toISOString()}`);

    // ── Run all searches in parallel ──────────────────────────────────
    const [news, events, businesses, realEstate, chamberEvents] = await Promise.all([
      searchLocalNews(`${CONFIG.city} ${CONFIG.state}`),
      searchLocalEvents(`${CONFIG.city} ${CONFIG.state}`),
      searchNewBusinesses(`${CONFIG.city} ${CONFIG.state}`),
      fetchRealEstateInsights(`${CONFIG.city} ${CONFIG.state}`),
      fetchChamberEvents(CONFIG.chamberUrl),
    ]);

    console.log(
      `[Daily Pipeline] Fetched: ${news.length} news, ${events.length} events, ` +
      `${businesses.length} businesses, ${realEstate.length} RE, ${chamberEvents.length} chamber`,
    );

    // ── Generate video script ─────────────────────────────────────────
    const script = generateVideoScript(news, events, businesses, realEstate, chamberEvents);

    // ── Generate daily tasks ──────────────────────────────────────────
    const tasks = generateDailyTasks(news, events, businesses, realEstate, chamberEvents);

    // ── Send notification ─────────────────────────────────────────────
    let notification = null;
    if (notifyUrl) {
      notification = await sendToWebhook(
        notifyUrl, script, tasks, news, events, businesses, realEstate, chamberEvents,
      );
      console.log(
        `[Daily Pipeline] Notification: ${notification.success ? "sent" : "failed — " + notification.error}`,
      );
    }

    const duration = Date.now() - startTime;
    console.log(`[Daily Pipeline] Complete in ${duration}ms`);

    return new Response(
      JSON.stringify({
        success: true,
        date: todayDate(),
        creator: CONFIG.creatorName,
        city: CONFIG.location,
        duration: `${duration}ms`,
        data: {
          news: news.length,
          events: events.length,
          businesses: businesses.length,
          realEstate: realEstate.length,
          chamberEvents: chamberEvents.length,
          totalItems: news.length + events.length + businesses.length + realEstate.length + chamberEvents.length,
        },
        tasks,
        script,
        notification,
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  } catch (err) {
    console.error(`[Daily Pipeline] Error: ${err}`);
    return new Response(
      JSON.stringify({
        error: "Pipeline failed",
        details: err instanceof Error ? err.message : String(err),
      }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
}
