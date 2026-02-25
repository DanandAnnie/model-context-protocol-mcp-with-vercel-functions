#!/usr/bin/env node
/**
 * Auto-detect ngrok URL and update VAPI assistant's Server URL.
 *
 * Usage:
 *   node scripts/update-vapi-server-url.mjs
 *
 * What it does:
 *   1. Queries local ngrok API (localhost:4040) for the public tunnel URL
 *   2. Lists your VAPI assistants
 *   3. Updates the chosen assistant's server URL to:
 *        https://<ngrok-url>/vapi/<API_KEY>
 *
 * Environment variables (or edit defaults below):
 *   VAPI_API_KEY      – your VAPI private/secret key
 *   VAPI_ASSISTANT_ID – assistant ID (optional, picks first if omitted)
 *   API_KEY           – bridge auth token (default: daniel-command-center-2026)
 *   NGROK_API         – ngrok local API (default: http://127.0.0.1:4040)
 */

const VAPI_KEY     = process.env.VAPI_API_KEY      || 'b95cbe6d-7c2f-467c-bb67-2d57fea2b27a';
const ASSISTANT_ID = process.env.VAPI_ASSISTANT_ID  || '';
const BRIDGE_TOKEN = process.env.API_KEY            || 'daniel-command-center-2026';
const NGROK_API    = process.env.NGROK_API          || 'http://127.0.0.1:4040';

const VAPI_BASE = 'https://api.vapi.ai';

// --- Helpers ---
async function vapiRequest(method, path, body) {
  const opts = {
    method,
    headers: {
      'Authorization': `Bearer ${VAPI_KEY}`,
      'Content-Type': 'application/json',
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${VAPI_BASE}${path}`, opts);
  const data = await res.json();
  if (!res.ok) {
    console.error(`VAPI [${res.status}]`, JSON.stringify(data, null, 2));
    process.exit(1);
  }
  return data;
}

async function getNgrokUrl() {
  try {
    const res = await fetch(`${NGROK_API}/api/tunnels`);
    const data = await res.json();
    const tunnel = data.tunnels.find(t => t.proto === 'https') || data.tunnels[0];
    if (!tunnel) throw new Error('No active ngrok tunnels found');
    return tunnel.public_url;
  } catch (err) {
    console.error(`Could not reach ngrok API at ${NGROK_API}`);
    console.error('Make sure ngrok is running: ngrok http 3456');
    console.error(`(Error: ${err.message})`);
    process.exit(1);
  }
}

// --- Main ---
async function main() {
  // Step 1: Get ngrok URL
  console.log('Detecting ngrok tunnel...');
  const ngrokUrl = await getNgrokUrl();
  console.log(`  Ngrok URL: ${ngrokUrl}`);

  const serverUrl = `${ngrokUrl}/vapi/${BRIDGE_TOKEN}`;
  console.log(`  Server URL: ${serverUrl}`);

  // Step 2: Find assistant
  let assistantId = ASSISTANT_ID;
  if (!assistantId) {
    console.log('\nFetching VAPI assistants...');
    const assistants = await vapiRequest('GET', '/assistant');
    if (!assistants.length) {
      console.error('No assistants found. Create one in the VAPI dashboard first.');
      process.exit(1);
    }
    assistants.forEach((a, i) => {
      console.log(`  ${i + 1}. ${a.name || '(unnamed)'}  →  ID: ${a.id}`);
    });
    assistantId = assistants[0].id;
    console.log(`\nUsing first assistant: ${assistants[0].name || assistantId}`);
  }

  // Step 3: Get current assistant config to show the old URL
  const assistant = await vapiRequest('GET', `/assistant/${assistantId}`);
  const oldUrl = assistant.serverUrl || assistant.server?.url || '(not set)';
  console.log(`\nCurrent Server URL: ${oldUrl}`);

  // Step 4: Update the assistant's server URL
  console.log(`Updating to: ${serverUrl}`);
  const updated = await vapiRequest('PATCH', `/assistant/${assistantId}`, {
    serverUrl: serverUrl,
  });

  const newUrl = updated.serverUrl || updated.server?.url || serverUrl;
  console.log(`\n========================================`);
  console.log(`  UPDATED SUCCESSFULLY`);
  console.log(`========================================`);
  console.log(`  Assistant   : ${updated.name || assistantId}`);
  console.log(`  Assistant ID: ${assistantId}`);
  console.log(`  Server URL  : ${newUrl}`);
  console.log(`========================================`);
  console.log(`\nVAPI will now send webhooks to your bridge with auth built in.`);
  console.log(`Make sure the bridge is running: node claude-bridge/server.js`);
}

main().catch((err) => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
