#!/bin/bash
# Automated Supabase setup for cross-device sync
# This script creates a Supabase project, runs the schema, and configures the app.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MIGRATION_FILE="$SCRIPT_DIR/supabase/migrations/001_initial_schema.sql"

echo ""
echo "==================================="
echo "  Stage Manager - Sync Setup"
echo "==================================="
echo ""
echo "This will create a free Supabase database so your"
echo "iOS and Android devices stay in sync."
echo ""

# Step 1: Check for supabase CLI
if ! npx supabase --version > /dev/null 2>&1; then
  echo "ERROR: Supabase CLI not found."
  echo "Install it: npm install -g supabase"
  exit 1
fi

# Step 2: Login to Supabase
echo "Step 1: Log in to Supabase"
echo "  A browser window will open. Sign up or log in (it's free)."
echo ""
read -p "Press Enter to open the login page..."

npx supabase login --no-browser 2>&1 && true

# Verify login
if ! npx supabase projects list > /dev/null 2>&1; then
  echo ""
  echo "Login didn't complete. You can also set SUPABASE_ACCESS_TOKEN:"
  echo "  1. Go to https://supabase.com/dashboard/account/tokens"
  echo "  2. Generate a new token"
  echo "  3. Run: export SUPABASE_ACCESS_TOKEN=your-token-here"
  echo "  4. Then re-run this script"
  exit 1
fi

echo ""
echo "Logged in successfully!"
echo ""

# Step 3: Create a new project
echo "Step 2: Creating Supabase project..."
echo ""

# Generate a random database password
DB_PASS=$(openssl rand -base64 24 | tr -d '/+=' | head -c 24)

# Pick a region (default to us-east-1)
REGION="us-east-1"

PROJECT_NAME="staging-inventory"

echo "  Project: $PROJECT_NAME"
echo "  Region:  $REGION"
echo ""

CREATE_OUTPUT=$(npx supabase projects create "$PROJECT_NAME" \
  --db-password "$DB_PASS" \
  --region "$REGION" \
  --org-id "" \
  -o json 2>&1) || true

# Try to extract project ref
PROJECT_REF=$(echo "$CREATE_OUTPUT" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)

if [ -z "$PROJECT_REF" ]; then
  echo "Could not auto-create project. Let's try listing your org..."
  echo ""

  ORGS=$(npx supabase orgs list -o json 2>&1) || true
  ORG_ID=$(echo "$ORGS" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)

  if [ -z "$ORG_ID" ]; then
    echo "No organization found. Please create a project manually:"
    echo "  1. Go to https://supabase.com/dashboard"
    echo "  2. Click 'New Project'"
    echo "  3. Then go to Settings > API and paste credentials in the app Settings page"
    exit 1
  fi

  CREATE_OUTPUT=$(npx supabase projects create "$PROJECT_NAME" \
    --db-password "$DB_PASS" \
    --region "$REGION" \
    --org-id "$ORG_ID" \
    -o json 2>&1) || true

  PROJECT_REF=$(echo "$CREATE_OUTPUT" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
fi

if [ -z "$PROJECT_REF" ]; then
  echo "Failed to create project. Output:"
  echo "$CREATE_OUTPUT"
  echo ""
  echo "Please create a project manually at https://supabase.com/dashboard"
  echo "Then paste the URL and key into Settings in the app."
  exit 1
fi

echo "  Project created: $PROJECT_REF"
echo ""

# Step 4: Wait for project to be ready
echo "Step 3: Waiting for project to be ready (this takes ~60 seconds)..."
for i in $(seq 1 30); do
  STATUS=$(npx supabase projects list -o json 2>&1 | grep -A5 "\"id\":\"$PROJECT_REF\"" | grep -o '"status":"[^"]*"' | cut -d'"' -f4)
  if [ "$STATUS" = "ACTIVE_HEALTHY" ]; then
    echo "  Project is ready!"
    break
  fi
  sleep 5
  echo -n "."
done
echo ""

# Step 5: Get API keys
echo "Step 4: Getting API credentials..."

API_KEYS=$(npx supabase projects api-keys --project-ref "$PROJECT_REF" -o json 2>&1) || true
ANON_KEY=$(echo "$API_KEYS" | grep -B2 '"anon"' | grep -o '"api_key":"[^"]*"' | cut -d'"' -f4)

if [ -z "$ANON_KEY" ]; then
  # Try alternate parsing
  ANON_KEY=$(echo "$API_KEYS" | python3 -c "import sys,json; keys=json.load(sys.stdin); print([k['api_key'] for k in keys if k['name']=='anon'][0])" 2>/dev/null) || true
fi

SUPABASE_URL="https://$PROJECT_REF.supabase.co"

echo "  URL: $SUPABASE_URL"
echo "  Key: ${ANON_KEY:0:20}..."
echo ""

# Step 6: Run migration
echo "Step 5: Setting up database tables..."

if [ -f "$MIGRATION_FILE" ]; then
  npx supabase db execute --project-ref "$PROJECT_REF" -f "$MIGRATION_FILE" 2>&1 || true
  echo "  Tables created!"
else
  echo "  WARNING: Migration file not found at $MIGRATION_FILE"
  echo "  You'll need to run it manually in the Supabase SQL Editor."
fi
echo ""

# Step 7: Write .env file
echo "Step 6: Writing configuration..."
cat > "$SCRIPT_DIR/.env" << EOF
VITE_SUPABASE_URL=$SUPABASE_URL
VITE_SUPABASE_ANON_KEY=$ANON_KEY
EOF
echo "  .env file written!"
echo ""

# Done!
echo "==================================="
echo "  Setup Complete!"
echo "==================================="
echo ""
echo "Your Supabase URL:  $SUPABASE_URL"
echo "Your Anon Key:      ${ANON_KEY:0:30}..."
echo ""
echo "WHAT TO DO NOW:"
echo "  1. On BOTH your iOS and Android devices, open the app"
echo "  2. Go to Settings (in the sidebar)"
echo "  3. Paste these credentials:"
echo ""
echo "     URL: $SUPABASE_URL"
echo "     Key: $ANON_KEY"
echo ""
echo "  4. Tap 'Connect' on each device"
echo "  5. Done! Changes will sync in real-time."
echo ""
echo "NOTE: Go to supabase.com > Your Project > Database > Replication"
echo "and enable Realtime for: properties, items, storage_units"
echo ""
