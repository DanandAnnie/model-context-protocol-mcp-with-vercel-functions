#!/usr/bin/env node

/**
 * n8n Workflow Import Script
 * Imports email management workflows into n8n via the API
 */

import { readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');
const workflowsDir = join(rootDir, 'workflows');

// Configuration
const N8N_HOST = process.env.N8N_HOST || 'localhost';
const N8N_PORT = process.env.N8N_PORT || 5678;
const N8N_API_KEY = process.env.N8N_API_KEY || '';
const N8N_USER = process.env.N8N_BASIC_AUTH_USER || 'admin';
const N8N_PASSWORD = process.env.N8N_BASIC_AUTH_PASSWORD || 'changeme';

const baseUrl = `http://${N8N_HOST}:${N8N_PORT}`;

/**
 * Make authenticated request to n8n API
 */
async function n8nRequest(endpoint, method = 'GET', body = null) {
  const headers = {
    'Content-Type': 'application/json',
  };

  // Try API key first, then basic auth
  if (N8N_API_KEY) {
    headers['X-N8N-API-KEY'] = N8N_API_KEY;
  } else {
    const auth = Buffer.from(`${N8N_USER}:${N8N_PASSWORD}`).toString('base64');
    headers['Authorization'] = `Basic ${auth}`;
  }

  const options = {
    method,
    headers,
  };

  if (body) {
    options.body = JSON.stringify(body);
  }

  const response = await fetch(`${baseUrl}${endpoint}`, options);

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`API request failed: ${response.status} ${response.statusText}\n${text}`);
  }

  return response.json();
}

/**
 * Check if n8n is running
 */
async function checkN8nHealth() {
  try {
    const response = await fetch(`${baseUrl}/healthz`);
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Get existing workflows
 */
async function getExistingWorkflows() {
  try {
    const result = await n8nRequest('/api/v1/workflows');
    return result.data || [];
  } catch {
    return [];
  }
}

/**
 * Import a workflow
 */
async function importWorkflow(workflow) {
  try {
    // Check if workflow with same name exists
    const existing = await getExistingWorkflows();
    const existingWorkflow = existing.find(w => w.name === workflow.name);

    if (existingWorkflow) {
      console.log(`  Updating existing workflow: ${workflow.name}`);
      await n8nRequest(`/api/v1/workflows/${existingWorkflow.id}`, 'PATCH', workflow);
    } else {
      console.log(`  Creating new workflow: ${workflow.name}`);
      await n8nRequest('/api/v1/workflows', 'POST', workflow);
    }

    return true;
  } catch (error) {
    console.error(`  Failed to import ${workflow.name}: ${error.message}`);
    return false;
  }
}

/**
 * Main import function
 */
async function main() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║           n8n Email Workflow Import Script                 ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');

  // Check if n8n is running
  console.log(`Checking n8n at ${baseUrl}...`);
  const isHealthy = await checkN8nHealth();

  if (!isHealthy) {
    console.error(`
❌ n8n is not running or not accessible at ${baseUrl}

Please start n8n first:
  pnpm run n8n:start

Or if using Docker:
  docker-compose up -d
`);
    process.exit(1);
  }

  console.log('✅ n8n is running\n');

  // Get workflow files
  const workflowFiles = readdirSync(workflowsDir)
    .filter(f => f.endsWith('.json'))
    .map(f => join(workflowsDir, f));

  if (workflowFiles.length === 0) {
    console.log('No workflow files found in workflows/ directory');
    process.exit(0);
  }

  console.log(`Found ${workflowFiles.length} workflow(s) to import:\n`);

  let successCount = 0;
  let failCount = 0;

  for (const file of workflowFiles) {
    const filename = file.split('/').pop();
    console.log(`📄 Processing ${filename}...`);

    try {
      const content = readFileSync(file, 'utf-8');
      const workflow = JSON.parse(content);

      const success = await importWorkflow(workflow);
      if (success) {
        successCount++;
        console.log(`   ✅ Successfully imported\n`);
      } else {
        failCount++;
      }
    } catch (error) {
      console.error(`   ❌ Error reading file: ${error.message}\n`);
      failCount++;
    }
  }

  console.log('════════════════════════════════════════════════════════════');
  console.log(`\nImport Summary:`);
  console.log(`  ✅ Successful: ${successCount}`);
  console.log(`  ❌ Failed: ${failCount}`);

  if (successCount > 0) {
    console.log(`
Next Steps:
  1. Open n8n at ${baseUrl}
  2. Go to Workflows to see imported workflows
  3. Configure credentials for each workflow:
     - Gmail OAuth2
     - Google Sheets OAuth2 (optional)
     - Google Calendar OAuth2 (optional)
     - Slack API (optional)
  4. Update environment variables in workflow nodes
  5. Activate workflows when ready
`);
  }
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
