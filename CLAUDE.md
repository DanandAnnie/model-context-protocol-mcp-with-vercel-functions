# CLAUDE.md

## Project Overview

MCP (Model Context Protocol) server for **Let's Play Music St George**, a music education studio in Washington, UT. Exposes tools to AI/LLM clients (e.g., Claude) for browsing programs, class schedules, enrollment, contact info, and free trial booking. Built with TypeScript and the `mcp-handler` library, deployed as a Vercel Function.

## Repository Structure

```
├── api/
│   └── server.ts              # MCP server entry point — all tools defined here
├── public/
│   └── index.html             # Static landing page
├── scripts/
│   ├── test-client.mjs        # SSE transport test client
│   └── test-streamable-http-client.mjs  # HTTP transport test client
├── package.json               # Dependencies and metadata
├── pnpm-lock.yaml             # pnpm lockfile
├── tsconfig.json              # TypeScript configuration
├── vercel.json                # Vercel deployment and routing config
└── .gitignore
```

## Tech Stack

- **Runtime:** Node.js >= 18, TypeScript (strict mode, ES2021 target, NodeNext modules)
- **Package manager:** pnpm 9.4.0 (required — declared in `package.json` `packageManager` field)
- **Key dependencies:**
  - `mcp-handler` — abstracts the MCP SDK into a `createMcpHandler` factory
  - `zod` — schema validation for tool parameters
- **Deployment:** Vercel Functions (serverless), configured in `vercel.json`

## Development

### Setup

```sh
pnpm install
```

### Local dev server

```sh
vercel dev
```

This starts the Vercel development environment with hot reloading.

### Testing with sample clients

```sh
# HTTP/Streamable transport (preferred)
node scripts/test-streamable-http-client.mjs http://localhost:3000

# SSE transport
node scripts/test-client.mjs http://localhost:3000
```

### No build step required

Vercel Functions compile TypeScript on deploy. There is no explicit build script.

### No test framework

The project has no test runner configured. The `test` script in `package.json` is a placeholder.

### No linter/formatter configured

No ESLint, Prettier, or similar tooling is set up.

## Architecture

### Request Flow

All HTTP requests matching `/(.*+)` are rewritten to `/api/server` via `vercel.json`. The server function (`api/server.ts`) exports a single handler for GET, POST, and DELETE methods:

```
Client → Vercel Edge → rewrite → /api/server.ts handler → MCP protocol response
```

### Adding Tools

All tools are defined in `api/server.ts` inside the `createMcpHandler` callback. Each tool is registered with:

1. **Name** — string identifier
2. **Description** — human-readable purpose
3. **Schema** — Zod schema defining parameters
4. **Handler** — async function returning `{content: [{type: "text", text: "..."}]}`

Example pattern:

```typescript
server.tool(
  "tool_name",
  "Description of the tool",
  { param: z.string() },
  async ({ param }) => {
    return {
      content: [{ type: "text", text: `Result: ${param}` }],
    };
  },
);
```

### Existing Tools

- **`get_programs`** — list all music programs, optionally filtered by child's age (param: `age?`)
- **`browse_classes`** — search/filter the weekly class schedule (params: `program?`, `age?`, `day?`, `teacher?`)
- **`get_class_details`** — full details for a specific class (param: `class_id`)
- **`get_contact_and_location`** — studio address, phone, email, hours, team info (no params)
- **`get_enrollment_link`** — enrollment URL and availability for a class (param: `class_id`)
- **`get_free_trial_info`** — free trial class booking and email list signup (no params)

### MCP Client Endpoint

Clients connect to `/mcp` (HTTP transport) or `/sse` (SSE transport).

## Deployment

- Deployed to Vercel as a serverless function
- `vercel.json` sets `maxDuration: 60` (seconds) for the server function
- Enable [Fluid Compute](https://vercel.com/docs/functions/fluid-compute) for efficient execution
- On Vercel Pro/Enterprise, increase `maxDuration` to 800 in `vercel.json`

## Environment Variables

No environment variables are currently required. All data (programs, classes, contact info) is defined as constants in `api/server.ts`. If you add tools that need secrets, configure them in Vercel project settings and reference via `process.env`.

## Voice AI (VAPI + ElevenLabs)

The site includes an embedded voice AI assistant powered by [VAPI](https://vapi.ai) and [ElevenLabs](https://elevenlabs.io). Visitors can click a button on the landing page to talk to an AI that answers questions about programs, schedules, enrollment, and contact info — using the same MCP tools defined in `api/server.ts`.

### Architecture

```
Website visitor clicks "Ask about classes!" button
  → VAPI Web Widget (embedded in public/index.html)
  → VAPI Platform (orchestrates STT + LLM + TTS)
  → LLM calls MCP tools at /mcp on this server
  → Voice response streamed back to visitor
```

VAPI connects directly to the MCP server endpoint at `/mcp` using its native MCP client support. All 6 tools are auto-discovered — no additional backend code is needed.

### How the Widget Works

`public/index.html` includes a `<vapi-widget>` custom element loaded via CDN:

```html
<script src="https://unpkg.com/@vapi-ai/client-sdk-react/dist/embed/widget.umd.js"></script>
<vapi-widget
  public-key="YOUR_VAPI_PUBLIC_KEY"
  assistant-id="YOUR_VAPI_ASSISTANT_ID"
  mode="voice"
  ...
></vapi-widget>
```

The widget handles microphone permissions, WebRTC audio, transcription display, and call state automatically. It appears as a floating button in the bottom-right corner.

### Setup Instructions

#### 1. Create accounts

- **VAPI**: Sign up at [vapi.ai](https://vapi.ai) (free tier includes ~$10 credit)
- **ElevenLabs**: Sign up at [elevenlabs.io](https://elevenlabs.io) (Starter plan $5/month minimum)

#### 2. Add ElevenLabs to VAPI

1. In VAPI dashboard, go to **Settings > Integrations** (or **Provider Keys**)
2. Add your ElevenLabs API key

#### 3. Create an assistant

In the VAPI dashboard, create a new assistant with these settings:

**Model:**
- Provider: OpenAI (or Anthropic)
- Model: `gpt-4o-mini` (recommended for cost) or `claude-haiku-4-5-20251001`

**Voice:**
- Provider: ElevenLabs
- Choose a warm, friendly voice (e.g., "Sarah", "Rachel")
- Stability: 0.5, Similarity Boost: 0.75

**System Prompt:**

```
You are the friendly virtual receptionist for Let's Play Music St George,
a music education studio in Washington, Utah. Your name is Melody.

Personality: Warm, enthusiastic about music education, patient, and helpful.
Keep responses concise — aim for 1-3 sentences since this is a voice
conversation. Speak naturally and conversationally.

You can help callers with:
- Finding the right music program for their child's age
- Checking the class schedule (days, times, teachers)
- Getting enrollment information
- Booking a free trial class
- Studio location, hours, and contact info

Important:
- If asked about pricing, say to contact the studio directly or check the
  enrollment page for current rates.
- If you don't know something, offer to take a message or provide the
  studio's contact information.
- Always be encouraging about music education for children.
- If a parent seems unsure, suggest the free trial class.
- Keep it brief — this is voice, not text. One to three sentences per turn.
```

**Tools (MCP):**
- Add an MCP tool source
- Server URL: `https://<your-vercel-domain>/mcp`
- VAPI will auto-discover all 6 tools (`get_programs`, `browse_classes`, `get_class_details`, `get_contact_and_location`, `get_enrollment_link`, `get_free_trial_info`)

#### 4. Get a phone number (optional)

1. In VAPI dashboard, go to **Phone Numbers**
2. Create a new number (choose 435 area code for Washington, UT)
3. Assign your assistant to the phone number
4. Anyone calling that number talks to the AI assistant 24/7

#### 5. Update the website

1. In VAPI dashboard, copy your **Public Key** (safe for client-side use) and the **Assistant ID**
2. In `public/index.html`, replace the placeholder values:
   - `YOUR_VAPI_PUBLIC_KEY` → your actual public key
   - `YOUR_VAPI_ASSISTANT_ID` → your actual assistant ID
3. Deploy to Vercel

### Widget Configuration Reference

The `<vapi-widget>` element in `public/index.html` supports these attributes:

| Attribute | Current Value | Description |
|-----------|--------------|-------------|
| `public-key` | placeholder | VAPI public API key |
| `assistant-id` | placeholder | VAPI assistant ID |
| `mode` | `voice` | `voice`, `chat`, or `hybrid` |
| `theme` | `light` | `light` or `dark` |
| `size` | `compact` | `tiny`, `compact`, or `full` |
| `position` | `bottom-right` | Widget placement on page |
| `accent-color` | `#6b3fa0` | Brand purple to match the page |
| `voice-show-transcript` | `true` | Show real-time transcription |

Full attribute reference: https://github.com/VapiAI/client-sdk-react

### Estimated Monthly Cost

For ~200 minutes of voice calls per month (light usage):

| Component | Rate | Monthly |
|-----------|------|---------|
| VAPI platform | $0.05/min | $10 |
| ElevenLabs TTS | ~$0.036/min | $7 |
| Deepgram STT | ~$0.01/min | $2 |
| GPT-4o-mini LLM | ~$0.02/min | $4 |
| Phone number | free (VAPI) | $0 |
| **Total** | | **~$23/month** |

For very light usage (5-10 min/day), expect ~$15-20/month.

### Troubleshooting

- **Widget doesn't appear**: Check browser console for errors. Ensure the CDN script loads (HTTPS required).
- **Microphone denied**: The browser must be on HTTPS and the user must grant mic permission.
- **"Assistant not found"**: Verify the `assistant-id` in `index.html` matches the one in VAPI dashboard.
- **Tools not working**: Confirm the MCP server URL in the assistant's tool config points to your deployed Vercel domain (e.g., `https://your-app.vercel.app/mcp`).
- **Latency**: Each MCP tool call adds ~200-500ms. GPT-4o-mini is faster than GPT-4o. Deepgram Nova-2 is the fastest STT.

## Conventions

- All MCP tools go in `api/server.ts` — single-file server pattern
- Use Zod schemas for all tool parameter validation
- Tool handlers are async functions returning the MCP content format
- ESM throughout (`"type": "module"` in `package.json`)
- TypeScript strict mode is enabled
- Trailing commas used in function arguments (Prettier-like style)
- Test scripts use `.mjs` extension for Node ESM compatibility
