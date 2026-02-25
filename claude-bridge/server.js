const express = require('express');
const { execFile } = require('child_process');
const path = require('path');
const app = express();

const PORT = process.env.PORT || 3456;
const API_KEY = process.env.API_KEY || 'daniel-command-center-2026';
const CLAUDE_TIMEOUT = parseInt(process.env.CLAUDE_TIMEOUT || '60000', 10);

app.use(express.json());

// --- Auth middleware ---
function authenticate(req, res, next) {
  const key = req.headers['x-api-key'];
  if (key !== API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// --- Locate claude binary (Windows .cmd shim vs unix) ---
const isWindows = process.platform === 'win32';
const claudeCmd = isWindows ? 'claude.cmd' : 'claude';

// --- Run Claude Code CLI ---
function runClaudeCode(query, timeoutMs = CLAUDE_TIMEOUT) {
  return new Promise((resolve, reject) => {
    const args = ['-p', '--output-format', 'text', query];
    console.log('[CLAUDE] Spawning:', claudeCmd, args.slice(0, 3).join(' '), `"${query.substring(0, 50)}..."`);

    // execFile does NOT use a shell, so no argument escaping issues
    const proc = execFile(claudeCmd, args, {
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024, // 10 MB
      env: { ...process.env },
      windowsHide: true,
    }, (error, stdout, stderr) => {
      if (error) {
        if (error.killed) {
          reject(new Error(`claude timed out after ${timeoutMs}ms`));
        } else {
          reject(new Error(`claude exited ${error.code}: ${stderr || error.message}`));
        }
      } else {
        resolve(stdout.trim());
      }
    });
  });
}

// --- Health check ---
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// --- Direct query endpoint ---
app.post('/query', authenticate, async (req, res) => {
  const { query } = req.body;
  if (!query) return res.status(400).json({ error: 'No query provided' });
  console.log('[QUERY]', query.substring(0, 100));
  try {
    const result = await runClaudeCode(query);
    res.json({ result });
  } catch (err) {
    console.error('[QUERY] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- Extract query from any VAPI message format ---
function extractFromVapi(message) {
  let userQuery = '';
  let toolCallId = 'bridge-response';

  try {
    if (message.type === 'tool-calls' && message.toolCallList) {
      const tc = message.toolCallList[0];
      toolCallId = tc?.id || 'bridge-response';
      const args = typeof tc.function.arguments === 'string'
        ? JSON.parse(tc.function.arguments)
        : tc.function.arguments;
      userQuery = args.query || args.message || JSON.stringify(args);
    } else if (message.type === 'tool-calls' && message.toolCalls) {
      const tc = message.toolCalls[0];
      toolCallId = tc?.id || 'bridge-response';
      const args = typeof tc.function.arguments === 'string'
        ? JSON.parse(tc.function.arguments)
        : tc.function.arguments;
      userQuery = args.query || args.message || JSON.stringify(args);
    } else if (message.type === 'function-call' && message.functionCall) {
      toolCallId = message.functionCall.id || 'bridge-response';
      userQuery = message.functionCall.parameters?.query
        || JSON.stringify(message.functionCall.parameters);
    } else {
      userQuery = message.content || JSON.stringify(message);
    }
  } catch (e) {
    console.error('[VAPI] Parse error:', e.message);
    userQuery = JSON.stringify(message);
  }

  return { userQuery, toolCallId };
}

// --- Message types that contain tool/function calls we should process ---
const ACTIONABLE_TYPES = new Set(['tool-calls', 'function-call']);

// --- VAPI webhook endpoint ---
// Auth via URL token: configure your VAPI Server URL as
//   https://your-host/vapi/daniel-command-center-2026
// Falls back to header-based auth if no token in URL.
app.post('/vapi/:token?', (req, res, next) => {
  const token = req.params.token;
  const headerKey = req.headers['x-api-key'];
  if (token === API_KEY || headerKey === API_KEY) return next();
  console.warn('[VAPI] Auth failed — no valid token or x-api-key header');
  return res.status(401).json({ error: 'Unauthorized' });
}, async (req, res) => {
  const startTime = Date.now();
  console.log('[VAPI] Webhook received:', JSON.stringify(req.body).substring(0, 300));

  const { message } = req.body;
  if (!message) {
    return res.status(400).json({ error: 'No message in request body' });
  }

  const msgType = message.type || 'unknown';
  console.log(`[VAPI] Message type: ${msgType}`);

  // Only process tool-calls and function-call messages through Claude.
  // All other VAPI event types (status-update, end-of-call-report,
  // transcript, conversation-update, assistant-request, hang, speech-update)
  // just need a 200 acknowledgement.
  if (!ACTIONABLE_TYPES.has(msgType)) {
    console.log(`[VAPI] Acknowledging non-actionable message type: ${msgType}`);
    return res.json({ ok: true });
  }

  const { userQuery, toolCallId } = extractFromVapi(message);

  if (!userQuery) {
    return res.json({
      results: [{ toolCallId, result: 'Could not extract query from webhook' }],
    });
  }

  console.log('[VAPI] Query:', userQuery.substring(0, 100));

  try {
    const response = await runClaudeCode(userQuery);
    const elapsed = Date.now() - startTime;
    console.log(`[VAPI] Success in ${elapsed}ms, response length: ${response.length}`);
    res.json({
      results: [{ toolCallId, result: response }],
    });
  } catch (err) {
    const elapsed = Date.now() - startTime;
    console.error(`[VAPI] Error after ${elapsed}ms:`, err.message);
    // Always return 200 with a valid VAPI response — never let the server 502
    res.json({
      results: [{ toolCallId, result: `I encountered an error: ${err.message}` }],
    });
  }
});

// --- Start server ---
app.listen(PORT, () => {
  console.log(`Claude Bridge server running on http://localhost:${PORT}`);
  console.log(`Endpoints: GET /health | POST /query | POST /vapi/${API_KEY}`);
});
