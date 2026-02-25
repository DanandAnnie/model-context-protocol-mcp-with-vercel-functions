#!/usr/bin/env node
/**
 * Setup script: buys a VAPI phone number and assigns it to your assistant.
 *
 * Usage:
 *   node scripts/setup-vapi-phone.mjs
 *
 * Environment variables (or edit the defaults below):
 *   VAPI_API_KEY      – your VAPI private/secret key
 *   VAPI_AREA_CODE    – desired area code (default: 512)
 *   VAPI_ASSISTANT_ID – assistant ID to assign (optional, will list assistants if omitted)
 */

const API_KEY      = process.env.VAPI_API_KEY      || 'b95cbe6d-7c2f-467c-bb67-2d57fea2b27a';
const AREA_CODE    = process.env.VAPI_AREA_CODE    || '512';
const ASSISTANT_ID = process.env.VAPI_ASSISTANT_ID || '';

const BASE = 'https://api.vapi.ai';

async function api(method, path, body) {
  const opts = {
    method,
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${BASE}${path}`, opts);
  const data = await res.json();
  if (!res.ok) {
    console.error(`[${res.status}]`, JSON.stringify(data, null, 2));
    process.exit(1);
  }
  return data;
}

async function main() {
  // Step 1: If no assistant ID provided, list them so user can pick
  let assistantId = ASSISTANT_ID;
  if (!assistantId) {
    console.log('\n--- Your VAPI Assistants ---');
    const assistants = await api('GET', '/assistant');
    if (!assistants.length) {
      console.log('No assistants found. Create one in the VAPI dashboard first.');
      process.exit(1);
    }
    assistants.forEach((a, i) => {
      console.log(`  ${i + 1}. ${a.name || '(unnamed)'}  →  ID: ${a.id}`);
    });
    // Use the first one by default
    assistantId = assistants[0].id;
    console.log(`\nUsing assistant: ${assistants[0].name || assistantId}`);
  }

  // Step 2: Buy a phone number
  console.log(`\n--- Buying phone number (area code ${AREA_CODE}) ---`);
  const phone = await api('POST', '/phone-number', {
    provider: 'vapi',
    numberDesiredAreaCode: AREA_CODE,
  });
  console.log(`  Purchased: ${phone.number}`);
  console.log(`  Phone ID:  ${phone.id}`);

  // Step 3: Assign assistant to the number
  console.log(`\n--- Assigning assistant to phone number ---`);
  const updated = await api('PATCH', `/phone-number/${phone.id}`, {
    assistantId: assistantId,
  });
  console.log(`  Assigned assistant ${assistantId} to ${updated.number}`);

  // Summary
  console.log('\n========================================');
  console.log('  SETUP COMPLETE');
  console.log('========================================');
  console.log(`  Phone Number : ${updated.number}`);
  console.log(`  Phone ID     : ${updated.id}`);
  console.log(`  Assistant ID : ${assistantId}`);
  console.log('========================================');
  console.log('\nCall that number to talk to Claude!');
  console.log('\nFor the PWA voice button, you also need your VAPI Public Key.');
  console.log('Find it at: dashboard.vapi.ai → Organization → Public Key');
}

main().catch((err) => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
