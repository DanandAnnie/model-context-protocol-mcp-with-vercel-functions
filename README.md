# Run an MCP Server on Vercel

## Usage

Update `api/server.ts` with your tools, prompts, and resources following the [MCP TypeScript SDK documentation](https://github.com/modelcontextprotocol/typescript-sdk/tree/main?tab=readme-ov-file#server).

[There is also a Next.js version of this template](https://vercel.com/templates/next.js/model-context-protocol-mcp-with-next-js)

## MCP Client Integration

When adding this server to an MCP client application, use your deployment URL followed by `/mcp`:

```
https://your-deployment-url.vercel.app/mcp
```

## Example Tools

The template includes two example tools to get you started:

- **`roll_dice`** - Rolls an N-sided die (minimum 2 sides)
- **`get_weather`** - Gets current weather data (via an API) for a location using latitude, longitude, and city name

These tools demonstrate basic functionality and API integration patterns. Replace them with your own tools.

## Notes for running on Vercel

- Make sure you have [Fluid compute](https://vercel.com/docs/functions/fluid-compute) enabled for efficient execution
- After enabling Fluid compute, open `vercel.json` and adjust max duration to 800 if you using a Vercel Pro or Enterprise account
- [Deploy the MCP template](https://vercel.com/templates/other/model-context-protocol-mcp-with-vercel-functions)

## Local dev

- Run `vercel dev` for local development
- Alternatively, integrate the system into the server framework of your choice.

## Sample Client

`script/test-client.mjs` contains a sample client to try invocations.

```sh
node scripts/test-client.mjs https://mcp-on-vercel.vercel.app
```

## Speed-to-Lead Engine

Captures a lead from any source, scores it instantly, drafts a personalized
first response (<60s SLA), routes it to the right pipeline, and generates a
7–21 touch follow-up cadence across SMS, email, and call tasks.

### Webhook: `POST /api/lead`

Point any source at this endpoint — website forms, portal webhooks
(Zillow/Realtor/Redfin), Facebook/Google lead ads, or social DMs. Field names
are normalized automatically (`name`/`firstName`, `phone`/`phone_number`,
`message`/`comments`, etc.). JSON and form-encoded bodies are both accepted.

```sh
curl -X POST "https://your-deployment.vercel.app/api/lead?source=zillow" \
  -H "x-webhook-secret: $LEAD_WEBHOOK_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"firstName":"Jamie","phone":"435-555-0142","email":"jamie@example.com",
       "message":"Pre-approved, need to buy ASAP. Tour 742 Evergreen this week?",
       "propertyAddress":"742 Evergreen Terrace"}'
```

The response contains the normalized lead, the score (0–100, grade, priority),
the routing decision, the ready-to-send first response, and the full cadence.
An instant Telegram alert is also sent to the operator.

- **Auth**: a Mission Control bearer token, or `LEAD_WEBHOOK_SECRET` via the
  `x-webhook-secret` header or `?key=` query param.
- **Dry-run by default**: no CRM writes happen unless you pass `?execute=true`
  (or set `LEAD_AUTOEXECUTE=on`). With execution on and GHL configured, the
  contact is upserted, tagged, an opportunity is created, and call tasks are
  scheduled.
- **First response sending is opt-in**: it is only sent when
  `LEAD_AUTORESPONDER=on` (or `sendFirstResponse:true`); otherwise it's drafted
  and returned but not sent.

See `.env.example` for all related variables (`GHL_PIPELINE_MAP`, `AGENT_NAME`,
`LEAD_TIMEZONE`, etc.).

### MCP tools

The same engine is exposed as MCP tools so an agent (or the Mission Control
dashboard) can drive it: `score_lead`, `route_lead`, `plan_follow_up`, and
`intake_lead`.

### Tests

```sh
bash scripts/test-lead-intake.sh http://localhost:3100
```
