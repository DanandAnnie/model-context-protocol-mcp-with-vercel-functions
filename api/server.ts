import { createMcpHandler } from "mcp-handler";
import { z } from "zod";

// ── Utility helpers ──────────────────────────────────────────────────────────

/** Lightweight XML-tag text extractor (works on RSS / Atom feeds). */
function extractTagContent(xml: string, tag: string): string[] {
  const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "gi");
  const matches: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = regex.exec(xml)) !== null) {
    // Strip CDATA wrappers if present
    matches.push(m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").trim());
  }
  return matches;
}

/** Strip HTML tags for cleaner text output. */
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

/** Today's date formatted as YYYY-MM-DD. */
function todayDate(): string {
  return new Date().toISOString().split("T")[0];
}

// ── MCP Server ───────────────────────────────────────────────────────────────

const handler = createMcpHandler((server) => {
  // ── 1. Search Local News ──────────────────────────────────────────────────
  server.tool(
    "search_local_news",
    "Search for local news, happenings, and stories for a specific city or area. " +
      "Uses Google News RSS feeds — no API key required. " +
      "Great for finding content about local events, business openings, community updates, and more.",
    {
      city: z.string().describe("City name, e.g. 'Austin TX' or 'Nashville Tennessee'"),
      topics: z
        .array(z.string())
        .optional()
        .describe(
          "Optional additional search topics to include, e.g. ['new restaurants', 'grand opening', 'chamber of commerce']",
        ),
      max_results: z
        .number()
        .int()
        .min(1)
        .max(20)
        .optional()
        .describe("Maximum number of news items to return (default 10)"),
    },
    async ({ city, topics, max_results }) => {
      const limit = max_results ?? 10;
      const searchTerms = [city, ...(topics ?? [])].join(" ");
      const encoded = encodeURIComponent(searchTerms);
      const rssUrl = `https://news.google.com/rss/search?q=${encoded}&hl=en-US&gl=US&ceid=US:en`;

      try {
        const response = await fetch(rssUrl);
        if (!response.ok) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Failed to fetch news for "${city}": HTTP ${response.status}`,
              },
            ],
          };
        }

        const xml = await response.text();
        const titles = extractTagContent(xml, "title").slice(1); // skip feed title
        const links = extractTagContent(xml, "link").slice(1);
        const pubDates = extractTagContent(xml, "pubDate");
        const descriptions = extractTagContent(xml, "description");

        const items = titles.slice(0, limit).map((title, i) => ({
          title: stripHtml(title),
          link: links[i] ?? "",
          published: pubDates[i] ?? "",
          summary: stripHtml(descriptions[i] ?? ""),
        }));

        if (items.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No recent news found for "${city}" with topics: ${searchTerms}`,
              },
            ],
          };
        }

        const formatted = items
          .map(
            (item, i) =>
              `${i + 1}. **${item.title}**\n   Published: ${item.published}\n   Summary: ${item.summary}\n   Link: ${item.link}`,
          )
          .join("\n\n");

        return {
          content: [
            {
              type: "text" as const,
              text: `📰 Local News for ${city} (${todayDate()})\n${"─".repeat(50)}\n\n${formatted}\n\n---\nFound ${items.length} news items.`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error fetching local news: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    },
  );

  // ── 2. Search Local Events ────────────────────────────────────────────────
  server.tool(
    "search_local_events",
    "Search for local events, grand openings, community gatherings, chamber of commerce events, " +
      "festivals, and business networking opportunities in a specific area. " +
      "Pulls from Google News RSS targeting event-specific keywords.",
    {
      city: z.string().describe("City name, e.g. 'Austin TX'"),
      state: z.string().optional().describe("State name for more specific results"),
      event_types: z
        .array(z.string())
        .optional()
        .describe(
          "Types of events to search for. Defaults to broad local events. " +
            "Examples: ['grand opening', 'ribbon cutting', 'networking', 'festival', 'farmers market']",
        ),
      max_results: z.number().int().min(1).max(20).optional(),
    },
    async ({ city, state, event_types, max_results }) => {
      const limit = max_results ?? 10;
      const location = state ? `${city} ${state}` : city;
      const defaultEventTypes = [
        "events",
        "grand opening",
        "ribbon cutting",
        "chamber of commerce",
        "community event",
        "business opening",
      ];
      const types = event_types && event_types.length > 0 ? event_types : defaultEventTypes;

      // Fetch multiple RSS feeds in parallel for broader coverage
      const fetches = types.slice(0, 4).map(async (eventType) => {
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

      const allResults = (await Promise.all(fetches)).flat();

      // Deduplicate by title
      const seen = new Set<string>();
      const unique = allResults.filter((item) => {
        const key = item.title.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      const items = unique.slice(0, limit);

      if (items.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No local events found for "${location}". Try broadening your search terms.`,
            },
          ],
        };
      }

      const formatted = items
        .map(
          (item, i) =>
            `${i + 1}. **${item.title}**\n   Category: ${item.category}\n   Published: ${item.published}\n   Summary: ${item.summary}\n   Link: ${item.link}`,
        )
        .join("\n\n");

      return {
        content: [
          {
            type: "text" as const,
            text: `🎉 Local Events & Happenings in ${location} (${todayDate()})\n${"─".repeat(50)}\n\n${formatted}\n\n---\nFound ${items.length} event-related items across ${types.length} categories.`,
          },
        ],
      };
    },
  );

  // ── 3. Search New Businesses ──────────────────────────────────────────────
  server.tool(
    "search_new_businesses",
    "Find new and up-and-coming businesses, restaurant openings, retail stores, and commercial " +
      "developments in a specific area. Great for local content creation about what's new in town.",
    {
      city: z.string().describe("City name, e.g. 'Austin TX'"),
      state: z.string().optional().describe("State for more specific results"),
      business_types: z
        .array(z.string())
        .optional()
        .describe(
          "Specific types of businesses to search for. " +
            "Examples: ['restaurant', 'retail', 'coffee shop', 'brewery', 'fitness']",
        ),
      max_results: z.number().int().min(1).max(20).optional(),
    },
    async ({ city, state, business_types, max_results }) => {
      const limit = max_results ?? 10;
      const location = state ? `${city} ${state}` : city;
      const defaultTypes = [
        "new business opening",
        "new restaurant",
        "coming soon",
        "now open",
      ];
      const types = business_types && business_types.length > 0
        ? business_types.map((t) => `new ${t} opening`)
        : defaultTypes;

      const fetches = types.slice(0, 4).map(async (searchTerm) => {
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
            businessType: searchTerm,
          }));
        } catch {
          return [];
        }
      });

      const allResults = (await Promise.all(fetches)).flat();
      const seen = new Set<string>();
      const unique = allResults.filter((item) => {
        const key = item.title.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      const items = unique.slice(0, limit);

      if (items.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No new business openings found for "${location}". Try different business types or broader terms.`,
            },
          ],
        };
      }

      const formatted = items
        .map(
          (item, i) =>
            `${i + 1}. **${item.title}**\n   Type: ${item.businessType}\n   Published: ${item.published}\n   Summary: ${item.summary}\n   Link: ${item.link}`,
        )
        .join("\n\n");

      return {
        content: [
          {
            type: "text" as const,
            text: `🏪 New & Up-and-Coming Businesses in ${location} (${todayDate()})\n${"─".repeat(50)}\n\n${formatted}\n\n---\nFound ${items.length} new business items.`,
          },
        ],
      };
    },
  );

  // ── 4. Fetch Real Estate Insights ─────────────────────────────────────────
  server.tool(
    "fetch_real_estate_insights",
    "Fetch real estate market insights, trends, housing data, and property market news for a specific area. " +
      "Covers market trends, home prices, new developments, investment opportunities, and mortgage rate context. " +
      "Perfect for real estate content creators and agents.",
    {
      city: z.string().describe("City name, e.g. 'Austin TX'"),
      state: z.string().optional().describe("State for more specific results"),
      focus_areas: z
        .array(z.string())
        .optional()
        .describe(
          "Specific real estate topics to focus on. " +
            "Examples: ['home prices', 'new construction', 'market forecast', 'investment', 'rental market', 'first time buyers']",
        ),
      max_results: z.number().int().min(1).max(20).optional(),
    },
    async ({ city, state, focus_areas, max_results }) => {
      const limit = max_results ?? 10;
      const location = state ? `${city} ${state}` : city;
      const defaultFocus = [
        "real estate market",
        "home prices trends",
        "new housing development",
        "real estate investment",
      ];
      const topics = focus_areas && focus_areas.length > 0
        ? focus_areas.map((f) => `real estate ${f}`)
        : defaultFocus;

      // Fetch real estate news from RSS
      const fetches = topics.slice(0, 4).map(async (topic) => {
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
            topic,
          }));
        } catch {
          return [];
        }
      });

      // Also fetch current mortgage rate context from a public source
      let mortgageContext = "";
      try {
        const fredUrl =
          "https://api.open-meteo.com/v1/forecast?latitude=38.89&longitude=-77.03&current=temperature_2m&timezone=auto";
        // Note: Open-Meteo doesn't have mortgage data; this is a placeholder.
        // In production, you'd use FRED API (free key) or similar.
        mortgageContext =
          "\n💡 Tip: For current mortgage rates, check freddiemac.com/pmms or bankrate.com for the latest weekly averages.";
      } catch {
        // silently continue
      }

      const allResults = (await Promise.all(fetches)).flat();
      const seen = new Set<string>();
      const unique = allResults.filter((item) => {
        const key = item.title.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      const items = unique.slice(0, limit);

      if (items.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No real estate insights found for "${location}". Try broader focus areas.`,
            },
          ],
        };
      }

      const formatted = items
        .map(
          (item, i) =>
            `${i + 1}. **${item.title}**\n   Topic: ${item.topic}\n   Published: ${item.published}\n   Summary: ${item.summary}\n   Link: ${item.link}`,
        )
        .join("\n\n");

      return {
        content: [
          {
            type: "text" as const,
            text: `🏠 Real Estate Insights for ${location} (${todayDate()})\n${"─".repeat(50)}\n\n${formatted}${mortgageContext}\n\n---\nFound ${items.length} real estate items across ${topics.length} focus areas.`,
          },
        ],
      };
    },
  );

  // ── 5. Fetch Chamber Events (ChamberMaster / RSS / iCal) ─────────────────
  server.tool(
    "fetch_chamber_events",
    "Fetch events directly from a Chamber of Commerce website. Works with ChamberMaster-powered " +
      "chambers (like St. George Area Chamber) via their RSS feed, or any chamber that " +
      "publishes an RSS or iCal (.ics) events feed. " +
      "For St. George: use chamber_url 'https://business.stgeorgechamber.com' " +
      "or provide any direct RSS/iCal feed URL.",
    {
      chamber_url: z
        .string()
        .describe(
          "The chamber's ChamberMaster base URL (e.g. 'https://business.stgeorgechamber.com') " +
            "or a direct RSS/iCal feed URL. The tool will auto-detect the feed format.",
        ),
      category: z
        .enum([
          "all",
          "ribbon_cuttings",
          "networking",
          "luncheons",
          "workshops",
        ])
        .optional()
        .describe("Filter by event category (default: 'all')"),
      max_results: z.number().int().min(1).max(30).optional(),
    },
    async ({ chamber_url, category, max_results }) => {
      const limit = max_results ?? 15;
      const cat = category ?? "all";

      // Build possible feed URLs to try
      const feedUrls: string[] = [];

      if (chamber_url.endsWith(".rss") || chamber_url.endsWith(".xml") || chamber_url.includes("/rss")) {
        feedUrls.push(chamber_url);
      } else if (chamber_url.endsWith(".ics") || chamber_url.includes("/ical")) {
        feedUrls.push(chamber_url);
      } else {
        // ChamberMaster standard feed paths
        const base = chamber_url.replace(/\/$/, "");
        feedUrls.push(`${base}/events/rss`);
        feedUrls.push(`${base}/events/rss/`);
        feedUrls.push(`${base}/events.rss`);
        feedUrls.push(`${base}/events/ical`);
        // Also try Google News as fallback
        const chamberName = base
          .replace(/https?:\/\//, "")
          .replace(/business\./, "")
          .replace(/\.chambermaster\.com.*/, "")
          .replace(/\.com.*/, "")
          .replace(/[^a-z]/gi, " ")
          .trim();
        if (chamberName) {
          const catQuery = cat !== "all" ? ` ${cat.replace(/_/g, " ")}` : "";
          feedUrls.push(
            `https://news.google.com/rss/search?q=${encodeURIComponent(chamberName + " chamber of commerce" + catQuery)}&hl=en-US&gl=US&ceid=US:en`,
          );
        }
      }

      // Category filter keywords
      const catKeywords: Record<string, RegExp> = {
        ribbon_cuttings: /ribbon.?cut|grand open|official open|unveil|groundbreak/i,
        networking: /network|mixer|happy hour|after hours|social hour|meet.*greet/i,
        luncheons: /lunch|breakfast|dinner|gala|banquet/i,
        workshops: /workshop|seminar|training|class|learn|education/i,
      };

      interface EventItem {
        title: string;
        date: string;
        time: string;
        location: string;
        description: string;
        link: string;
        category: string;
      }

      let allEvents: EventItem[] = [];
      let feedSource = "";

      for (const feedUrl of feedUrls) {
        try {
          const res = await fetch(feedUrl, {
            headers: { "User-Agent": "MCP-VideoScript/1.0" },
          });
          if (!res.ok) continue;

          const text = await res.text();
          feedSource = feedUrl;

          // Detect format: iCal vs RSS
          if (text.includes("BEGIN:VCALENDAR") || text.includes("BEGIN:VEVENT")) {
            // Parse iCal
            const eventBlocks = text.split("BEGIN:VEVENT").slice(1);
            for (const block of eventBlocks) {
              const getField = (field: string) => {
                const match = block.match(new RegExp(`${field}[^:]*:(.+?)(?:\\r?\\n|$)`));
                return match?.[1]?.trim() ?? "";
              };
              const dtStart = getField("DTSTART");
              const summary = getField("SUMMARY");
              const desc = getField("DESCRIPTION")
                .replace(/\\n/g, " ")
                .replace(/\\,/g, ",");
              const loc = getField("LOCATION").replace(/\\,/g, ",");
              const url = getField("URL");

              // Format date from iCal format
              let dateStr = dtStart;
              if (/^\d{8}T?\d{0,6}/.test(dtStart)) {
                const y = dtStart.substring(0, 4);
                const mo = dtStart.substring(4, 6);
                const d = dtStart.substring(6, 8);
                dateStr = `${y}-${mo}-${d}`;
                if (dtStart.length >= 13) {
                  const h = dtStart.substring(9, 11);
                  const mi = dtStart.substring(11, 13);
                  dateStr += ` ${h}:${mi}`;
                }
              }

              allEvents.push({
                title: summary,
                date: dateStr,
                time: "",
                location: loc,
                description: desc.substring(0, 200),
                link: url,
                category: "event",
              });
            }
          } else if (text.includes("<rss") || text.includes("<feed") || text.includes("<item")) {
            // Parse RSS/Atom
            const titles = extractTagContent(text, "title").slice(1);
            const links = extractTagContent(text, "link").slice(1);
            const pubDates = extractTagContent(text, "pubDate");
            const descriptions = extractTagContent(text, "description");

            for (let i = 0; i < titles.length; i++) {
              const title = stripHtml(titles[i]);
              const desc = stripHtml(descriptions[i] ?? "");

              allEvents.push({
                title,
                date: pubDates[i] ?? "",
                time: "",
                location: "",
                description: desc.substring(0, 200),
                link: links[i] ?? "",
                category: "event",
              });
            }
          }

          if (allEvents.length > 0) break; // Got results, stop trying other URLs
        } catch {
          continue;
        }
      }

      // Apply category filter
      if (cat !== "all" && catKeywords[cat]) {
        const regex = catKeywords[cat];
        allEvents = allEvents.filter(
          (e) => regex.test(e.title) || regex.test(e.description),
        );
      }

      // Categorize events for labeling
      for (const event of allEvents) {
        if (/ribbon.?cut|grand open/i.test(event.title)) {
          event.category = "Ribbon Cutting";
        } else if (/network|mixer|happy hour|after hours/i.test(event.title)) {
          event.category = "Networking";
        } else if (/lunch|breakfast|dinner/i.test(event.title)) {
          event.category = "Luncheon/Meal";
        } else if (/workshop|seminar|training|class/i.test(event.title)) {
          event.category = "Workshop";
        } else {
          event.category = "Event";
        }
      }

      const items = allEvents.slice(0, limit);

      if (items.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                `No events found from chamber feed.\n\n` +
                `Tried URLs:\n${feedUrls.map((u) => `  • ${u}`).join("\n")}\n\n` +
                `💡 Tips:\n` +
                `  • Ask your chamber for their RSS or iCal feed URL\n` +
                `  • Check if they have a ChamberMaster portal (look for 'business.yourchamber.com')\n` +
                `  • Use parse_chamber_email instead — paste the email you receive from them\n` +
                `  • Many chambers list feeds at: yourchamber.com/events/rss`,
            },
          ],
        };
      }

      const formatted = items
        .map((e, i) => {
          const parts = [`${i + 1}. **${e.title}**`];
          parts.push(`   Type: ${e.category}`);
          if (e.date) parts.push(`   Date: ${e.date}`);
          if (e.location) parts.push(`   Location: ${e.location}`);
          if (e.description) parts.push(`   Details: ${e.description}`);
          if (e.link) parts.push(`   Link: ${e.link}`);
          return parts.join("\n");
        })
        .join("\n\n");

      return {
        content: [
          {
            type: "text" as const,
            text:
              `🏛️ Chamber Events (${todayDate()})\n` +
              `   Source: ${feedSource}\n` +
              `${"─".repeat(50)}\n\n` +
              `${formatted}\n\n` +
              `${"─".repeat(50)}\n` +
              `Found ${items.length} events${cat !== "all" ? ` (filtered: ${cat})` : ""}.`,
          },
        ],
      };
    },
  );

  // ── 6. Parse Chamber of Commerce Email ──────────────────────────────────
  server.tool(
    "parse_chamber_email",
    "Parse a Chamber of Commerce email (or any newsletter / community email) and extract " +
      "events, business openings, announcements, networking opportunities, and other content. " +
      "Paste the full email body — HTML or plain text — and get back structured, categorized items " +
      "ready to feed into generate_daily_video_script. " +
      "Works with any chamber, city newsletter, BNI, Rotary, or community organization email.",
    {
      email_body: z
        .string()
        .describe(
          "The full email body content. Can be HTML or plain text — just paste or forward it in.",
        ),
      sender_name: z
        .string()
        .optional()
        .describe(
          "Who sent the email, e.g. 'Springfield Chamber of Commerce', 'Downtown Business Alliance'",
        ),
      city: z
        .string()
        .optional()
        .describe("Your city, for tagging extracted items with a location"),
    },
    async ({ email_body, sender_name, city }) => {
      const source = sender_name ?? "Chamber Email";
      const location = city ?? "";

      // Clean the email: strip HTML if present, normalize whitespace
      const cleanText = stripHtml(email_body);

      // ── Pattern-based extraction ──────────────────────────────────────
      // We look for common patterns in chamber / community emails

      const events: Array<{ title: string; details: string }> = [];
      const businesses: Array<{ title: string; details: string }> = [];
      const announcements: Array<{ title: string; details: string }> = [];
      const networking: Array<{ title: string; details: string }> = [];
      const ribbonCuttings: Array<{ title: string; details: string }> = [];

      // Split into logical chunks — paragraphs or sections
      const sections = cleanText.split(/\n{2,}|\. {2,}/).filter((s) => s.trim().length > 15);

      // Date pattern: matches various date formats
      const datePattern =
        /(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2}(?:\s*[-–,]\s*\d{1,2})?(?:\s*,?\s*\d{4})?|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?/gi;

      // Time pattern
      const timePattern =
        /\d{1,2}:\d{2}\s*(?:am|pm|AM|PM)|(?:noon|midnight)/gi;

      // Address-like pattern
      const addressPattern =
        /\d+\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\s+(?:St(?:reet)?|Ave(?:nue)?|Blvd|Dr(?:ive)?|Rd|Road|Ln|Lane|Way|Ct|Court|Pl(?:ace)?|Pkwy|Hwy)/gi;

      // Keywords for categorization
      const eventKeywords =
        /\b(?:event|workshop|seminar|luncheon|breakfast|mixer|gala|fundraiser|meeting|summit|conference|class|training|tour|open house|celebration|ceremony|festival|fair|parade|concert|show)\b/i;
      const businessKeywords =
        /\b(?:new (?:business|member|opening)|grand opening|now open|coming soon|just opened|welcome|new to|joining|launched|startup|entrepreneur|small business)\b/i;
      const ribbonKeywords =
        /\b(?:ribbon.?cutting|ribbon.?ceremony|official opening|inaugural|dedication|unveiling|groundbreaking)\b/i;
      const networkKeywords =
        /\b(?:network(?:ing)?|mixer|happy hour|coffee chat|speed network|business after hours|after hours|connect|mingle|meet and greet|social hour)\b/i;
      const announcementKeywords =
        /\b(?:announce|update|reminder|notice|important|deadline|application|grant|award|scholarship|program|initiative|partnership|sponsor)\b/i;

      for (const section of sections) {
        const trimmed = section.trim();
        if (trimmed.length < 20) continue;

        // Extract any dates and times found in this section
        const dates = trimmed.match(datePattern) ?? [];
        const times = trimmed.match(timePattern) ?? [];
        const addresses = trimmed.match(addressPattern) ?? [];

        // Build a details string with extracted metadata
        const detailParts: string[] = [];
        if (dates.length > 0) detailParts.push(`Date: ${dates[0]}`);
        if (times.length > 0) detailParts.push(`Time: ${times[0]}`);
        if (addresses.length > 0) detailParts.push(`Location: ${addresses[0]}`);
        const meta = detailParts.length > 0 ? ` (${detailParts.join(" | ")})` : "";

        // Truncate long sections for a clean title
        const title =
          trimmed.length > 150 ? trimmed.substring(0, 147) + "..." : trimmed;

        const item = { title, details: meta };

        // Categorize based on keywords (check most specific first)
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
        } else if (dates.length > 0 || times.length > 0) {
          // Has a date/time? Likely an event
          events.push(item);
        }
      }

      // ── Format output ─────────────────────────────────────────────────
      const totalFound =
        events.length +
        businesses.length +
        ribbonCuttings.length +
        networking.length +
        announcements.length;

      const formatCategory = (
        label: string,
        emoji: string,
        items: Array<{ title: string; details: string }>,
      ) => {
        if (items.length === 0) return "";
        return `${emoji} ${label} (${items.length})\n${items.map((item, i) => `   ${i + 1}. ${item.title}${item.details}`).join("\n")}\n`;
      };

      const output = [
        `📧 Parsed: ${source}${location ? ` — ${location}` : ""} (${todayDate()})`,
        "─".repeat(50),
        "",
        formatCategory("EVENTS & HAPPENINGS", "🎉", events),
        formatCategory("NEW BUSINESSES & MEMBERS", "🏪", businesses),
        formatCategory("RIBBON CUTTINGS & OPENINGS", "✂️", ribbonCuttings),
        formatCategory("NETWORKING OPPORTUNITIES", "🤝", networking),
        formatCategory("ANNOUNCEMENTS & UPDATES", "📢", announcements),
        "─".repeat(50),
        `📊 Total items extracted: ${totalFound}`,
        "",
        totalFound > 0
          ? "✅ Ready to use! Pass these items into generate_daily_video_script:\n" +
            "   • Events + Ribbon Cuttings → local_events parameter\n" +
            "   • New Businesses → new_businesses parameter\n" +
            "   • Announcements → local_news parameter\n" +
            "   • Networking → local_events or custom_talking_points"
          : "⚠️  No structured items detected. The email may use unusual formatting.\n" +
            "   Try pasting just the main content section, or use the raw text as\n" +
            "   custom_talking_points in generate_daily_video_script.",
      ]
        .filter(Boolean)
        .join("\n");

      return {
        content: [
          {
            type: "text" as const,
            text: output,
          },
        ],
      };
    },
  );

  // ── 7. Generate Daily Video Script ──────────────────────────────────────
  server.tool(
    "generate_daily_video_script",
    "Generate a structured daily video script for local content creators. " +
      "Provide your gathered news, events, business openings, and real estate insights, " +
      "and this tool will structure them into a ready-to-shoot video script with hooks, " +
      "segments, transitions, and calls-to-action. " +
      "Best used AFTER calling the other tools (search_local_news, search_local_events, " +
      "search_new_businesses, fetch_real_estate_insights) to gather source material.",
    {
      creator_name: z.string().describe("Your name or channel name for personalized intros"),
      city: z.string().describe("Your city/area for location-specific references"),
      niche: z
        .string()
        .optional()
        .describe("Your content niche, e.g. 'real estate' (default: 'real estate')"),
      local_news: z
        .array(z.string())
        .optional()
        .describe("Array of local news headlines/summaries gathered from search_local_news"),
      local_events: z
        .array(z.string())
        .optional()
        .describe("Array of local events gathered from search_local_events"),
      new_businesses: z
        .array(z.string())
        .optional()
        .describe("Array of new business items gathered from search_new_businesses"),
      real_estate_insights: z
        .array(z.string())
        .optional()
        .describe("Array of real estate insights gathered from fetch_real_estate_insights"),
      custom_talking_points: z
        .array(z.string())
        .optional()
        .describe(
          "Any custom talking points, personal tips, or ideas you want included in the script",
        ),
      video_style: z
        .enum(["short_form", "long_form", "both"])
        .optional()
        .describe(
          "Video format: 'short_form' (60-90 sec TikTok/Reels), 'long_form' (5-10 min YouTube), 'both' (default: 'both')",
        ),
      tone: z
        .enum(["professional", "casual", "energetic", "educational"])
        .optional()
        .describe("Desired tone for the script (default: 'energetic')"),
    },
    async ({
      creator_name,
      city,
      niche,
      local_news,
      local_events,
      new_businesses,
      real_estate_insights,
      custom_talking_points,
      video_style,
      tone,
    }) => {
      const contentNiche = niche ?? "real estate";
      const style = video_style ?? "both";
      const scriptTone = tone ?? "energetic";
      const date = todayDate();

      // Count available content
      const newsCount = local_news?.length ?? 0;
      const eventsCount = local_events?.length ?? 0;
      const bizCount = new_businesses?.length ?? 0;
      const reCount = real_estate_insights?.length ?? 0;
      const customCount = custom_talking_points?.length ?? 0;
      const totalContent = newsCount + eventsCount + bizCount + reCount + customCount;

      // Tone-specific language
      const toneGuide: Record<string, { greeting: string; energy: string; cta: string }> = {
        professional: {
          greeting: `Good morning, I'm ${creator_name}, your local ${contentNiche} expert in ${city}.`,
          energy: "Speak clearly and confidently. Maintain authority.",
          cta: `For more market insights, follow me and reach out anytime.`,
        },
        casual: {
          greeting: `Hey what's up, it's ${creator_name} here in ${city}!`,
          energy: "Keep it relaxed and conversational, like talking to a friend.",
          cta: `Drop a comment if you've seen any of these spots! Follow for more local updates.`,
        },
        energetic: {
          greeting: `What's going on everybody! It's ${creator_name} coming to you LIVE from ${city}!`,
          energy: "High energy! Speak with excitement, use hand gestures, lean into the camera.",
          cta: `SMASH that follow button and comment your favorite spot in ${city}! Let's connect!`,
        },
        educational: {
          greeting: `Welcome back. I'm ${creator_name}, and today we're breaking down what's happening in ${city}.`,
          energy: "Informative and measured. Use data points and explain context.",
          cta: `If this was helpful, share it with someone looking at ${city}. Follow for weekly updates.`,
        },
      };

      const t = toneGuide[scriptTone] ?? toneGuide.energetic;

      // ── Build Short-Form Script ─────────────────────────────────────────
      let shortFormScript = "";
      if (style === "short_form" || style === "both") {
        // Pick the top highlight from each category
        const topNews = local_news?.[0] ?? null;
        const topEvent = local_events?.[0] ?? null;
        const topBiz = new_businesses?.[0] ?? null;
        const topRE = real_estate_insights?.[0] ?? null;
        const topCustom = custom_talking_points?.[0] ?? null;

        shortFormScript = `
${"═".repeat(60)}
📱 SHORT-FORM SCRIPT (60-90 seconds — TikTok / Reels / Shorts)
${"═".repeat(60)}

🎬 HOOK (0-3 seconds):
"Here's what's happening in ${city} TODAY that you NEED to know about!"
[Look directly at camera, point at viewer]

📍 SEGMENT 1 — The Headline (3-15 seconds):
${topNews ? `"${topNews}"` : `[Insert today's biggest local news headline]`}
[Quick cut or walk-and-talk]

${topBiz ? `🏪 SEGMENT 2 — New in Town (15-30 seconds):\n"${topBiz}"\n[Show the location or B-roll if possible]` : ""}

${topEvent ? `🎉 SEGMENT 3 — Don't Miss This (30-45 seconds):\n"${topEvent}"\n[Overlay event details on screen]` : ""}

${topRE ? `🏠 SEGMENT 4 — ${contentNiche.charAt(0).toUpperCase() + contentNiche.slice(1)} Quick Take (45-60 seconds):\n"${topRE}"\n[Use on-screen text for key numbers]` : ""}

${topCustom ? `💡 BONUS TIP:\n"${topCustom}"` : ""}

🎤 CTA (last 5-10 seconds):
"${t.cta}"
[Point at camera, smile, cut]

🎵 PRODUCTION NOTES:
- Tone: ${t.energy}
- Add trending audio if on TikTok/Reels
- Use captions — 80% of viewers watch on mute
- Keep transitions snappy (0.5s max)
`;
      }

      // ── Build Long-Form Script ──────────────────────────────────────────
      let longFormScript = "";
      if (style === "long_form" || style === "both") {
        const newsSection =
          newsCount > 0
            ? local_news!
                .map((item, i) => `   ${i + 1}. ${item}`)
                .join("\n")
            : "   [No local news items provided — mention 1-2 things you've seen around town]";

        const eventsSection =
          eventsCount > 0
            ? local_events!
                .map((item, i) => `   ${i + 1}. ${item}`)
                .join("\n")
            : "   [No events provided — mention any upcoming community activities]";

        const bizSection =
          bizCount > 0
            ? new_businesses!
                .map((item, i) => `   ${i + 1}. ${item}`)
                .join("\n")
            : "   [No new businesses provided — mention any construction or coming-soon signs you've noticed]";

        const reSection =
          reCount > 0
            ? real_estate_insights!
                .map((item, i) => `   ${i + 1}. ${item}`)
                .join("\n")
            : "   [No real estate data provided — share your own market observations]";

        const customSection =
          customCount > 0
            ? custom_talking_points!
                .map((item, i) => `   ${i + 1}. ${item}`)
                .join("\n")
            : "";

        longFormScript = `
${"═".repeat(60)}
🎥 LONG-FORM SCRIPT (5-10 minutes — YouTube / Facebook / Podcast)
${"═".repeat(60)}

🎬 COLD OPEN / HOOK (0-30 seconds):
"If you live in ${city} — or you're thinking about moving here — you need to see what's happening right now."
[Drone shot or driving footage of ${city} if available]

👋 INTRO (30 sec - 1 min):
"${t.greeting}"
"Every [day/week], I bring you the latest on what's happening in our community — from new businesses opening their doors, to events you don't want to miss, to what the ${contentNiche} market is doing. Let's dive in!"
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
🏠 SEGMENT 4: ${contentNiche.toUpperCase()} MARKET UPDATE (2-3 min)
${"─".repeat(40)}
"Alright, let's get into the ${contentNiche} market. Here's what you need to know..."

${reSection}

[Use screen recordings, charts, or on-screen graphics for data points]
[Share personal insight: What does this mean for buyers/sellers/investors?]

${
  customSection
    ? `${"─".repeat(40)}
💡 SEGMENT 5: PRO TIPS & PERSONAL INSIGHTS
${"─".repeat(40)}
"Before we wrap up, I want to share some tips..."

${customSection}
`
    : ""
}
${"─".repeat(40)}
🎤 OUTRO & CTA (30 sec)
${"─".repeat(40)}
"That's your ${city} update for ${date}!"
"${t.cta}"
"I'm ${creator_name} — I'll see you in the next one!"
[End screen: Subscribe + Related Videos]

📋 PRODUCTION NOTES:
- Total target: 5-10 minutes
- Tone: ${t.energy}
- Film B-roll of mentioned locations when possible
- Add lower-third graphics for business names and addresses
- Include chapter timestamps in the description
- Thumbnail idea: Your face + "${city} UPDATE" text + key image from the top story
`;
      }

      // ── Build Summary ───────────────────────────────────────────────────
      const summary = `
${"═".repeat(60)}
📋 DAILY VIDEO SCRIPT PACKAGE — ${date}
   Creator: ${creator_name} | Location: ${city} | Niche: ${contentNiche}
${"═".repeat(60)}

📊 CONTENT INVENTORY:
   • Local news items: ${newsCount}
   • Local events: ${eventsCount}
   • New businesses: ${bizCount}
   • ${contentNiche} insights: ${reCount}
   • Custom talking points: ${customCount}
   • Total content pieces: ${totalContent}

${totalContent === 0 ? "⚠️  No source content was provided. The script contains placeholder sections.\n   For best results, first run search_local_news, search_local_events,\n   search_new_businesses, and fetch_real_estate_insights, then pass the\n   results into this tool.\n" : "✅ Source content loaded and integrated into script segments.\n"}
${shortFormScript}
${longFormScript}

${"═".repeat(60)}
📌 POST-PRODUCTION CHECKLIST:
${"═".repeat(60)}
□ Film all segments (or compile from existing footage)
□ Add captions / subtitles for accessibility
□ Create eye-catching thumbnail
□ Write SEO-optimized title and description
□ Add relevant hashtags: #${city.replace(/\s+/g, "")} #${contentNiche.replace(/\s+/g, "")} #LocalBusiness #CommunityUpdate
□ Schedule post for optimal time (typically 9 AM or 6 PM local)
□ Cross-post to all platforms (YouTube, TikTok, Instagram, Facebook)
□ Engage with comments within first hour of posting
`;

      return {
        content: [
          {
            type: "text" as const,
            text: summary,
          },
        ],
      };
    },
  );

  // ── 8. Get Weather (kept from original) ─────────────────────────────────
  server.tool(
    "get_weather",
    "Get the current weather at a location — useful for video intros and local context.",
    {
      latitude: z.number(),
      longitude: z.number(),
      city: z.string(),
    },
    async ({ latitude, longitude, city }) => {
      const response = await fetch(
        `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,weathercode,relativehumidity_2m&timezone=auto`,
      );
      const weatherData = await response.json();
      return {
        content: [
          {
            type: "text" as const,
            text: `🌤️ Weather in ${city}: ${weatherData.current.temperature_2m}°C, Humidity: ${weatherData.current.relativehumidity_2m}%`,
          },
        ],
      };
    },
  );
});

export { handler as GET, handler as POST, handler as DELETE };
