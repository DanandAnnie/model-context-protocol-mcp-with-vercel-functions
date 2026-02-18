/**
 * Email Webhook Endpoint
 *
 * Receives forwarded chamber/community emails via HTTP POST and automatically:
 * 1. Parses the email content (events, businesses, news, etc.)
 * 2. Generates daily video script tasks
 * 3. Sends a notification to your configured webhook (Slack, Discord, etc.)
 *
 * Supports inbound email formats from:
 * - SendGrid Inbound Parse
 * - Mailgun
 * - Postmark
 * - Zapier / Make.com (simple JSON POST)
 * - Direct HTTP POST (raw email body)
 */

// ── Utility helpers (shared with server.ts) ────────────────────────────────

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

// ── Email body extraction from different provider formats ──────────────────

interface ParsedInbound {
  from: string;
  subject: string;
  body: string;
}

function extractFromSendGrid(data: Record<string, unknown>): ParsedInbound {
  return {
    from: String(data.from ?? data.sender ?? ""),
    subject: String(data.subject ?? ""),
    body: String(data.html ?? data.text ?? data.email ?? ""),
  };
}

function extractFromMailgun(data: Record<string, unknown>): ParsedInbound {
  return {
    from: String(data.from ?? data.sender ?? ""),
    subject: String(data.subject ?? ""),
    body: String(data["body-html"] ?? data["body-plain"] ?? data["stripped-html"] ?? ""),
  };
}

function extractFromPostmark(data: Record<string, unknown>): ParsedInbound {
  return {
    from: String(data.FromFull ?? data.From ?? ""),
    subject: String(data.Subject ?? ""),
    body: String(data.HtmlBody ?? data.TextBody ?? ""),
  };
}

function extractFromGenericJSON(data: Record<string, unknown>): ParsedInbound {
  // Zapier, Make.com, or custom integrations
  return {
    from: String(
      data.from ?? data.sender ?? data.sender_name ?? data.from_email ?? "",
    ),
    subject: String(data.subject ?? data.title ?? ""),
    body: String(
      data.body ?? data.html ?? data.text ?? data.email_body ?? data.content ?? "",
    ),
  };
}

function detectAndExtract(data: Record<string, unknown>): ParsedInbound {
  // SendGrid: has "envelope" or "charsets" field
  if (data.envelope || data.charsets) {
    return extractFromSendGrid(data);
  }
  // Mailgun: has "body-html" or "body-plain"
  if (data["body-html"] || data["body-plain"] || data["stripped-html"]) {
    return extractFromMailgun(data);
  }
  // Postmark: has "HtmlBody" or "TextBody"
  if (data.HtmlBody || data.TextBody || data.FromFull) {
    return extractFromPostmark(data);
  }
  // Generic / Zapier / Make.com
  return extractFromGenericJSON(data);
}

// ── Email parsing logic (mirrors parse_chamber_email from server.ts) ──────

interface ExtractedItem {
  title: string;
  details: string;
  source?: string;
  date?: string;
  time?: string;
  venue?: string;
}

interface ParsedEmail {
  featuredStories: ExtractedItem[];
  newsArticles: ExtractedItem[];
  events: ExtractedItem[];
  honorees: ExtractedItem[];
  businesses: ExtractedItem[];
  announcements: ExtractedItem[];
  networking: ExtractedItem[];
  ribbonCuttings: ExtractedItem[];
}

function parseEmailContent(rawBody: string): ParsedEmail {
  let cleanText = stripHtml(rawBody);
  cleanText = cleanText.replace(/__/g, "");

  const featuredStories: ExtractedItem[] = [];
  const newsArticles: ExtractedItem[] = [];
  const events: ExtractedItem[] = [];
  const honorees: ExtractedItem[] = [];
  const businesses: ExtractedItem[] = [];
  const announcements: ExtractedItem[] = [];
  const networking: ExtractedItem[] = [];
  const ribbonCuttings: ExtractedItem[] = [];

  // Detect section headers
  const sectionPattern =
    /(?:WHAT'?S\s+IN\s+THE\s+NEWS|EVENTS?\s+COMING\s+UP|IN\s+CASE\s+YOU\s+MISSED\s+IT|UPCOMING\s+EVENTS?|MEMBER\s+(?:NEWS|SPOTLIGHT)|NEW\s+MEMBERS?|RIBBON\s+CUTTINGS?)/gi;

  const sectionHeaders = [...cleanText.matchAll(sectionPattern)];
  const sectionMap = new Map<string, string>();

  for (let i = 0; i < sectionHeaders.length; i++) {
    const header = sectionHeaders[i][0].toUpperCase();
    const startIdx = sectionHeaders[i].index! + header.length;
    const endIdx =
      i + 1 < sectionHeaders.length
        ? sectionHeaders[i + 1].index!
        : cleanText.length;
    sectionMap.set(header, cleanText.substring(startIdx, endIdx).trim());
  }

  const firstSectionStart =
    sectionHeaders.length > 0 ? sectionHeaders[0].index! : cleanText.length;
  const leadContent = cleanText.substring(0, firstSectionStart).trim();

  // Parse honorees from lead content
  const honoreePattern =
    /\*\s*([^(]+?)\s*\(([^)]+)\)\s*[:\-–]\s*([\s\S]*?)(?=\*\s*[A-Z]|\n\n|$)/g;
  let honoreeMatch;
  while ((honoreeMatch = honoreePattern.exec(leadContent)) !== null) {
    honorees.push({
      title: `${honoreeMatch[1].trim()} — ${honoreeMatch[2].trim()}`,
      details:
        honoreeMatch[3].trim().length > 200
          ? honoreeMatch[3].trim().substring(0, 197) + "..."
          : honoreeMatch[3].trim(),
    });
  }

  // Parse event invitations from lead
  const joinUsPattern =
    /(?:join us|please join|you'?re invited)\s+(?:on\s+)?([A-Z][a-z]+\s+\d{1,2}(?:st|nd|rd|th)?(?:\s*,?\s*\d{4})?)\s+(?:at\s+)?(?:the\s+)?([^.!]+)/gi;
  let joinMatch;
  while ((joinMatch = joinUsPattern.exec(leadContent)) !== null) {
    events.push({
      title: joinMatch[0].substring(0, 150).trim(),
      details: "",
      date: joinMatch[1],
      venue: joinMatch[2].trim(),
    });
  }

  // Parse featured award/event names
  const awardPattern =
    /(?:announce|celebrate|honor|present|proud)\w*\s+(?:the\s+)?(?:honorees?\s+for\s+(?:the\s+)?)?(.+?(?:Awards?|Gala|Luncheon|Summit|Event|Celebration|Ceremony)(?:\s*,\s*presented\s+by\s+[^.]+)?)/gi;
  let awardMatch;
  while ((awardMatch = awardPattern.exec(leadContent)) !== null) {
    featuredStories.push({
      title: awardMatch[1].trim(),
      details: "",
    });
  }

  // Parse NEWS section
  for (const [header, content] of sectionMap) {
    if (/NEWS/i.test(header)) {
      const articles = content
        .split(/Read\s+More/i)
        .filter((a) => a.trim().length > 30);
      for (const article of articles) {
        const lines = article
          .split(/\n/)
          .map((l) => l.trim())
          .filter((l) => l.length > 0);
        if (lines.length >= 2) {
          const titleLine = lines.find((l) => l.length > 20) ?? lines[0];
          const sourceLine = lines.find(
            (l) =>
              l.length < 40 &&
              /news|times|tribune|post|herald|press|media|journal|magazine|report/i.test(l),
          );
          const summaryLines = lines.filter(
            (l) =>
              l !== titleLine &&
              l !== sourceLine &&
              l.length > 30 &&
              !/register|rsvp|sign up|click here/i.test(l),
          );
          newsArticles.push({
            title: titleLine.substring(0, 150),
            details: summaryLines.join(" ").substring(0, 250),
            source: sourceLine ?? "",
          });
        }
      }
    }
  }

  // Parse EVENTS section
  for (const [header, content] of sectionMap) {
    if (/EVENT/i.test(header) && /COMING|UPCOMING/i.test(header)) {
      const eventBlocks = content
        .split(/(?:Register\s+(?:here|now)|RSVP\s+Now|Sign\s+Up)/i)
        .filter((b) => b.trim().length > 15);
      for (const block of eventBlocks) {
        const text = block.trim();
        if (text.length < 20) continue;
        const datePattern =
          /(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2}(?:st|nd|rd|th)?(?:\s*[-–]\s*\d{1,2}(?:st|nd|rd|th)?)?(?:\s*,?\s*\d{4})?/gi;
        const timePattern = /\d{1,2}:\d{2}\s*(?:am|pm|AM|PM)/gi;
        const dates = text.match(datePattern) ?? [];
        const times = text.match(timePattern) ?? [];
        const lines = text
          .split(/\n/)
          .map((l) => l.trim())
          .filter((l) => l.length > 5);
        events.push({
          title: (lines[0] ?? text).substring(0, 150),
          details: lines.slice(1).join(" ").substring(0, 200),
          date: dates[0] ?? "",
          time: times[0] ?? "",
        });
      }
    }
  }

  // Parse RIBBON CUTTINGS section
  for (const [header, content] of sectionMap) {
    if (/RIBBON/i.test(header)) {
      const blocks = content
        .split(/\n{2,}/)
        .filter((b) => b.trim().length > 15);
      for (const block of blocks) {
        ribbonCuttings.push({
          title: block.trim().substring(0, 150),
          details: "",
        });
      }
    }
  }

  // Fallback keyword scan
  const structuredCount =
    featuredStories.length +
    newsArticles.length +
    events.length +
    honorees.length +
    businesses.length +
    ribbonCuttings.length;

  if (structuredCount < 3) {
    const paragraphs = cleanText
      .split(/\n{2,}/)
      .filter((s) => s.trim().length > 20);

    const ribbonKeywords =
      /\b(?:ribbon.?cutting|ribbon.?ceremony|official opening|inaugural|dedication|unveiling|groundbreaking)\b/i;
    const networkKeywords =
      /\b(?:network(?:ing)?|mixer|happy hour|coffee chat|speed network|business after hours|after hours|mingle|meet and greet|social hour)\b/i;
    const businessKeywords =
      /\b(?:new (?:business|member|opening)|grand opening|now open|coming soon|just opened|welcome|new to|joining|launched|startup|entrepreneur|small business)\b/i;
    const eventKeywords =
      /\b(?:event|workshop|seminar|luncheon|breakfast|gala|fundraiser|meeting|summit|conference|class|training|tour|open house|celebration|ceremony|festival|fair|parade|concert|show)\b/i;
    const announcementKeywords =
      /\b(?:announce|update|reminder|notice|important|deadline|application|grant|award|scholarship|program|initiative|partnership|sponsor)\b/i;

    for (const para of paragraphs) {
      const trimmed = para.trim();
      if (trimmed.length < 25) continue;

      const datePatternGlobal =
        /(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2}(?:\s*[-–,]\s*\d{1,2})?(?:\s*,?\s*\d{4})?|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?/gi;
      const timePatternGlobal =
        /\d{1,2}:\d{2}\s*(?:am|pm|AM|PM)|(?:noon|midnight)/gi;
      const addressPattern =
        /\d+\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\s+(?:St(?:reet)?|Ave(?:nue)?|Blvd|Dr(?:ive)?|Rd|Road|Ln|Lane|Way|Ct|Court|Pl(?:ace)?|Pkwy|Hwy)/gi;

      const dates = trimmed.match(datePatternGlobal) ?? [];
      const times = trimmed.match(timePatternGlobal) ?? [];
      const addresses = trimmed.match(addressPattern) ?? [];

      const detailParts: string[] = [];
      if (dates.length > 0) detailParts.push(`Date: ${dates[0]}`);
      if (times.length > 0) detailParts.push(`Time: ${times[0]}`);
      if (addresses.length > 0) detailParts.push(`Location: ${addresses[0]}`);
      const meta = detailParts.length > 0 ? detailParts.join(" | ") : "";

      const title =
        trimmed.length > 150 ? trimmed.substring(0, 147) + "..." : trimmed;
      const item: ExtractedItem = { title, details: meta };

      if (ribbonKeywords.test(trimmed)) {
        ribbonCuttings.push(item);
      } else if (networkKeywords.test(trimmed)) {
        networking.push(item);
      } else if (businessKeywords.test(trimmed)) {
        businesses.push(item);
      } else if (eventKeywords.test(trimmed)) {
        events.push(item);
      } else if (announcementKeywords.test(trimmed)) {
        announcements.push(item);
      }
    }
  }

  return {
    featuredStories,
    newsArticles,
    events,
    honorees,
    businesses,
    announcements,
    networking,
    ribbonCuttings,
  };
}

// ── Daily tasks generation ─────────────────────────────────────────────────

interface DailyTask {
  id: number;
  priority: "high" | "medium" | "low";
  category: string;
  task: string;
  details: string;
  source: string;
  estimatedTime: string;
}

function generateDailyTasks(
  parsed: ParsedEmail,
  senderName: string,
  city: string,
  creatorName: string,
): DailyTask[] {
  const tasks: DailyTask[] = [];
  let id = 1;

  // Task 1: Always start with script preparation
  const totalItems =
    parsed.featuredStories.length +
    parsed.newsArticles.length +
    parsed.events.length +
    parsed.honorees.length +
    parsed.businesses.length +
    parsed.ribbonCuttings.length +
    parsed.networking.length +
    parsed.announcements.length;

  tasks.push({
    id: id++,
    priority: "high",
    category: "PREP",
    task: `Review today's ${senderName} email digest (${totalItems} items extracted)`,
    details: `Scan through the parsed content below and pick your top 3-5 talking points for today's video.`,
    source: senderName,
    estimatedTime: "10 min",
  });

  // Featured stories / honorees -> interview or feature tasks
  for (const honoree of parsed.honorees.slice(0, 3)) {
    tasks.push({
      id: id++,
      priority: "high",
      category: "FEATURE",
      task: `Feature story: ${honoree.title}`,
      details: honoree.details || "Reach out for a quick interview or quote.",
      source: senderName,
      estimatedTime: "15 min",
    });
  }

  for (const featured of parsed.featuredStories.slice(0, 2)) {
    tasks.push({
      id: id++,
      priority: "high",
      category: "FEATURE",
      task: `Cover featured story: ${featured.title}`,
      details: "Great lead for today's video hook.",
      source: senderName,
      estimatedTime: "10 min",
    });
  }

  // News articles -> report on them
  for (const news of parsed.newsArticles.slice(0, 3)) {
    tasks.push({
      id: id++,
      priority: "medium",
      category: "NEWS",
      task: `Report on: ${news.title}`,
      details: news.details || "Read the full article and summarize key points.",
      source: news.source || senderName,
      estimatedTime: "5 min",
    });
  }

  // Events -> attend or promote
  for (const event of parsed.events.slice(0, 4)) {
    const dateInfo = event.date ? ` (${event.date}${event.time ? " at " + event.time : ""})` : "";
    tasks.push({
      id: id++,
      priority: "medium",
      category: "EVENT",
      task: `Promote event: ${event.title}${dateInfo}`,
      details: event.venue
        ? `Venue: ${event.venue}. Mention in today's video events segment.`
        : "Include in today's video events roundup.",
      source: senderName,
      estimatedTime: "3 min",
    });
  }

  // Ribbon cuttings -> film/attend
  for (const ribbon of parsed.ribbonCuttings.slice(0, 3)) {
    tasks.push({
      id: id++,
      priority: "high",
      category: "RIBBON CUTTING",
      task: `Film ribbon cutting: ${ribbon.title}`,
      details: "Great B-roll opportunity! Try to attend and get footage.",
      source: senderName,
      estimatedTime: "30 min",
    });
  }

  // New businesses -> spotlight
  for (const biz of parsed.businesses.slice(0, 3)) {
    tasks.push({
      id: id++,
      priority: "medium",
      category: "BUSINESS",
      task: `Spotlight new business: ${biz.title}`,
      details: biz.details || "Visit the location, film a quick walkthrough or interview.",
      source: senderName,
      estimatedTime: "20 min",
    });
  }

  // Networking -> attend or mention
  for (const net of parsed.networking.slice(0, 2)) {
    tasks.push({
      id: id++,
      priority: "low",
      category: "NETWORKING",
      task: `Attend/promote: ${net.title}`,
      details: net.details || "Good networking opportunity — mention on social media.",
      source: senderName,
      estimatedTime: "5 min",
    });
  }

  // Announcements -> share
  for (const ann of parsed.announcements.slice(0, 2)) {
    tasks.push({
      id: id++,
      priority: "low",
      category: "ANNOUNCEMENT",
      task: `Share announcement: ${ann.title}`,
      details: ann.details || "Quick mention in your video or social post.",
      source: senderName,
      estimatedTime: "2 min",
    });
  }

  // Final task: create and film the video
  tasks.push({
    id: id++,
    priority: "high",
    category: "PRODUCE",
    task: `Film & publish today's ${city} local update video`,
    details:
      `Use the tasks above as your script outline. ` +
      `Suggested format: Hook -> Top headline -> Events -> New businesses -> CTA. ` +
      `Aim for short-form (60-90s) AND long-form (5-10 min).`,
    source: "Auto-generated",
    estimatedTime: "60 min",
  });

  return tasks;
}

// ── Format tasks for output ────────────────────────────────────────────────

function formatTasksAsText(
  tasks: DailyTask[],
  senderName: string,
  city: string,
  creatorName: string,
): string {
  const date = todayDate();
  const priorityEmoji = { high: "🔴", medium: "🟡", low: "🟢" };

  const lines = [
    `${"═".repeat(60)}`,
    `📋 DAILY TASKS — ${date}`,
    `   Creator: ${creatorName} | City: ${city}`,
    `   Source: ${senderName} (auto-processed)`,
    `${"═".repeat(60)}`,
    "",
  ];

  // Group by priority
  const high = tasks.filter((t) => t.priority === "high");
  const medium = tasks.filter((t) => t.priority === "medium");
  const low = tasks.filter((t) => t.priority === "low");

  if (high.length > 0) {
    lines.push(`🔴 HIGH PRIORITY (${high.length})`);
    lines.push(`${"─".repeat(40)}`);
    for (const t of high) {
      lines.push(`  [ ] #${t.id} [${t.category}] ${t.task}`);
      lines.push(`      ${t.details}`);
      lines.push(`      ⏱ ${t.estimatedTime}`);
      lines.push("");
    }
  }

  if (medium.length > 0) {
    lines.push(`🟡 MEDIUM PRIORITY (${medium.length})`);
    lines.push(`${"─".repeat(40)}`);
    for (const t of medium) {
      lines.push(`  [ ] #${t.id} [${t.category}] ${t.task}`);
      lines.push(`      ${t.details}`);
      lines.push(`      ⏱ ${t.estimatedTime}`);
      lines.push("");
    }
  }

  if (low.length > 0) {
    lines.push(`🟢 LOW PRIORITY (${low.length})`);
    lines.push(`${"─".repeat(40)}`);
    for (const t of low) {
      lines.push(`  [ ] #${t.id} [${t.category}] ${t.task}`);
      lines.push(`      ${t.details}`);
      lines.push(`      ⏱ ${t.estimatedTime}`);
      lines.push("");
    }
  }

  lines.push(`${"═".repeat(60)}`);
  lines.push(`📊 Summary: ${tasks.length} tasks generated`);
  lines.push(
    `   🔴 ${high.length} high | 🟡 ${medium.length} medium | 🟢 ${low.length} low`,
  );
  lines.push("");

  return lines.join("\n");
}

// ── Format tasks for Slack notification ────────────────────────────────────

function formatTasksForSlack(
  tasks: DailyTask[],
  senderName: string,
  city: string,
  creatorName: string,
): Record<string, unknown> {
  const date = todayDate();
  const high = tasks.filter((t) => t.priority === "high");
  const medium = tasks.filter((t) => t.priority === "medium");

  const taskLines = tasks
    .slice(0, 15) // Slack has message size limits
    .map(
      (t) =>
        `${t.priority === "high" ? "🔴" : t.priority === "medium" ? "🟡" : "🟢"} *[${t.category}]* ${t.task}`,
    )
    .join("\n");

  return {
    text: `📋 Daily Tasks for ${creatorName} — ${date}`,
    blocks: [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: `📋 Daily Tasks — ${date}`,
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Source:* ${senderName}\n*City:* ${city}\n*Tasks:* ${tasks.length} (🔴 ${high.length} high, 🟡 ${medium.length} medium)`,
        },
      },
      {
        type: "divider",
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: taskLines,
        },
      },
    ],
  };
}

// ── Format tasks for Discord notification ──────────────────────────────────

function formatTasksForDiscord(
  tasks: DailyTask[],
  senderName: string,
  city: string,
  creatorName: string,
): Record<string, unknown> {
  const date = todayDate();
  const high = tasks.filter((t) => t.priority === "high");
  const medium = tasks.filter((t) => t.priority === "medium");

  const taskLines = tasks
    .slice(0, 20)
    .map(
      (t) =>
        `${t.priority === "high" ? "🔴" : t.priority === "medium" ? "🟡" : "🟢"} **[${t.category}]** ${t.task}`,
    )
    .join("\n");

  return {
    content: `📋 **Daily Tasks for ${creatorName}** — ${date}`,
    embeds: [
      {
        title: `📋 Daily Tasks — ${date}`,
        description: `**Source:** ${senderName}\n**City:** ${city}\n**Tasks:** ${tasks.length} (🔴 ${high.length} high, 🟡 ${medium.length} medium)`,
        color: 3447003, // blue
        fields: [
          {
            name: "Tasks",
            value: taskLines.substring(0, 1024),
          },
        ],
      },
    ],
  };
}

// ── Send notification to webhook ───────────────────────────────────────────

async function sendNotification(
  webhookUrl: string,
  tasks: DailyTask[],
  senderName: string,
  city: string,
  creatorName: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    // Detect webhook type from URL
    let payload: Record<string, unknown>;
    if (webhookUrl.includes("hooks.slack.com")) {
      payload = formatTasksForSlack(tasks, senderName, city, creatorName);
    } else if (webhookUrl.includes("discord.com/api/webhooks")) {
      payload = formatTasksForDiscord(tasks, senderName, city, creatorName);
    } else {
      // Generic webhook — send full data
      payload = {
        event: "daily_tasks_generated",
        date: todayDate(),
        creator: creatorName,
        city,
        source: senderName,
        tasks,
        summary: formatTasksAsText(tasks, senderName, city, creatorName),
      };
    }

    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      return { success: false, error: `Webhook returned HTTP ${res.status}` };
    }
    return { success: true };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ── Main webhook handler ───────────────────────────────────────────────────

export async function POST(request: Request): Promise<Response> {
  try {
    const contentType = request.headers.get("content-type") ?? "";

    let data: Record<string, unknown>;

    if (contentType.includes("application/json")) {
      data = await request.json();
    } else if (contentType.includes("multipart/form-data") || contentType.includes("application/x-www-form-urlencoded")) {
      // SendGrid and Mailgun send form data
      const formData = await request.formData();
      data = {};
      for (const [key, value] of formData.entries()) {
        data[key] = value;
      }
    } else {
      // Raw text body
      const text = await request.text();
      data = { body: text };
    }

    // Extract email fields
    const inbound = detectAndExtract(data);

    if (!inbound.body || inbound.body.trim().length < 20) {
      return new Response(
        JSON.stringify({
          error: "No email body found. Send email content in the POST body.",
          hint: "Supported formats: SendGrid Inbound Parse, Mailgun, Postmark, or JSON with 'body'/'html'/'text' field.",
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    // Configuration from query params or headers
    const url = new URL(request.url);
    const city =
      url.searchParams.get("city") ??
      (data.city as string) ??
      "St. George";
    const creatorName =
      url.searchParams.get("creator") ??
      (data.creator_name as string) ??
      "Creator";
    const notifyUrl =
      url.searchParams.get("notify") ??
      (data.notification_webhook as string) ??
      "";
    const senderName =
      inbound.from ||
      url.searchParams.get("sender") ??
      "Chamber Email";

    // Parse the email
    const parsed = parseEmailContent(inbound.body);

    // Generate daily tasks
    const tasks = generateDailyTasks(parsed, senderName, city, creatorName);

    // Format as readable text
    const tasksText = formatTasksAsText(tasks, senderName, city, creatorName);

    // Send notification if webhook URL provided
    let notificationResult = null;
    if (notifyUrl) {
      notificationResult = await sendNotification(
        notifyUrl,
        tasks,
        senderName,
        city,
        creatorName,
      );
    }

    // Return the result
    return new Response(
      JSON.stringify({
        success: true,
        date: todayDate(),
        source: senderName,
        subject: inbound.subject,
        city,
        creator: creatorName,
        parsed: {
          featuredStories: parsed.featuredStories.length,
          newsArticles: parsed.newsArticles.length,
          events: parsed.events.length,
          honorees: parsed.honorees.length,
          businesses: parsed.businesses.length,
          announcements: parsed.announcements.length,
          networking: parsed.networking.length,
          ribbonCuttings: parsed.ribbonCuttings.length,
        },
        tasks,
        tasksText,
        notification: notificationResult,
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  } catch (err) {
    return new Response(
      JSON.stringify({
        error: "Failed to process email",
        details: err instanceof Error ? err.message : String(err),
      }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
}

// Health check
export async function GET(): Promise<Response> {
  return new Response(
    JSON.stringify({
      status: "ok",
      service: "Email-to-Daily-Tasks Webhook",
      description:
        "POST an email to this endpoint to auto-generate daily video script tasks. " +
        "Supports SendGrid Inbound Parse, Mailgun, Postmark, Zapier, Make.com, and raw JSON.",
      parameters: {
        query: {
          city: "Your city (default: St. George)",
          creator: "Your name/channel name",
          notify: "Slack/Discord/webhook URL for notifications",
          sender: "Email sender name (auto-detected from email if possible)",
        },
        body: "Email content as JSON, form-data, or raw text",
      },
      example:
        "POST /api/email-webhook?city=St.+George&creator=Annie&notify=https://hooks.slack.com/xxx",
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    },
  );
}
