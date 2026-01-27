#!/usr/bin/env node

/**
 * n8n Setup Script
 * Initializes n8n configuration and prepares the environment for email management workflows
 */

import { writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');

// Create .n8n directory if it doesn't exist
const n8nDir = join(rootDir, '.n8n');
if (!existsSync(n8nDir)) {
  mkdirSync(n8nDir, { recursive: true });
  console.log('Created .n8n directory');
}

// Create environment configuration
const envContent = `# n8n Configuration
# Copy this to .env and fill in your values

# n8n Settings
N8N_PORT=5678
N8N_PROTOCOL=http
N8N_HOST=localhost
N8N_EDITOR_BASE_URL=http://localhost:5678

# Security
N8N_BASIC_AUTH_ACTIVE=true
N8N_BASIC_AUTH_USER=admin
N8N_BASIC_AUTH_PASSWORD=changeme

# Database (using SQLite by default)
DB_TYPE=sqlite
DB_SQLITE_DATABASE=database.sqlite

# Execution Settings
EXECUTIONS_DATA_SAVE_ON_ERROR=all
EXECUTIONS_DATA_SAVE_ON_SUCCESS=all
EXECUTIONS_DATA_SAVE_ON_PROGRESS=true
EXECUTIONS_DATA_SAVE_MANUAL_EXECUTIONS=true

# Workflow Settings
WORKFLOWS_DEFAULT_NAME=My Workflow
N8N_DISABLE_PRODUCTION_MAIN_PROCESS=false

# ============================================
# Email Workflow Environment Variables
# ============================================

# Notification email address (for forwarding important emails)
NOTIFICATION_EMAIL=your-email@example.com

# Google Sheets ID for logging (create a sheet and copy the ID from URL)
GOOGLE_SHEET_ID=your-google-sheet-id

# Slack channel for notifications (optional)
SLACK_CHANNEL=#email-alerts

# Auto-reply settings
AUTO_REPLY_ENABLED=false
AUTO_REPLY_MESSAGE=Thank you for your email. I am currently away and will respond as soon as possible.
SENDER_NAME=Your Name

# ============================================
# OAuth Credentials (configure in n8n UI)
# ============================================
# Gmail OAuth2, Google Sheets OAuth2, Google Calendar OAuth2, Slack API
# These must be configured through the n8n web interface
`;

const envExamplePath = join(rootDir, '.env.example');
writeFileSync(envExamplePath, envContent);
console.log('Created .env.example file');

// Create .env if it doesn't exist
const envPath = join(rootDir, '.env');
if (!existsSync(envPath)) {
  writeFileSync(envPath, envContent);
  console.log('Created .env file (please update with your values)');
}

// Create n8n config file
const n8nConfig = {
  database: {
    type: 'sqlite',
    sqlite: {
      database: 'database.sqlite'
    }
  },
  executions: {
    saveDataOnError: 'all',
    saveDataOnSuccess: 'all',
    saveDataManualExecutions: true
  },
  generic: {
    timezone: 'UTC'
  },
  security: {
    audit: {
      daysAbandonedWorkflow: 90
    }
  },
  workflows: {
    defaultName: 'Email Workflow'
  },
  nodes: {
    exclude: []
  }
};

const configPath = join(n8nDir, 'config.json');
writeFileSync(configPath, JSON.stringify(n8nConfig, null, 2));
console.log('Created n8n config.json');

console.log(`
╔════════════════════════════════════════════════════════════╗
║             n8n Email Workflow Setup Complete              ║
╠════════════════════════════════════════════════════════════╣
║                                                            ║
║  Next Steps:                                               ║
║                                                            ║
║  1. Update .env with your configuration                    ║
║                                                            ║
║  2. Install dependencies:                                  ║
║     pnpm install                                           ║
║                                                            ║
║  3. Start n8n:                                             ║
║     pnpm run n8n:start                                     ║
║                                                            ║
║  4. Open n8n in browser:                                   ║
║     http://localhost:5678                                  ║
║                                                            ║
║  5. Import workflows:                                      ║
║     pnpm run n8n:import                                    ║
║                                                            ║
║  6. Configure OAuth credentials in n8n UI:                 ║
║     - Gmail OAuth2                                         ║
║     - Google Sheets OAuth2 (optional)                      ║
║     - Google Calendar OAuth2 (optional)                    ║
║     - Slack API (optional)                                 ║
║                                                            ║
╚════════════════════════════════════════════════════════════╝
`);
