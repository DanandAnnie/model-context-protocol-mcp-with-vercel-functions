const express = require('express');
const { spawn } = require('child_process');
const app = express();

const PORT = process.env.PORT || 3456;
const API_KEY = process.env.API_KEY || 'daniel-command-center-2026';

app.use(express.json());

// --- Auth middleware ---
function authenticate(req, res, next) {
  const key = req.headers['x-api-key'];
  if (key !== API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// --- Run Claude Code CLI ---
function runClaudeCode(query, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const args = ['-p', '--output-format', 'text', query];
    const proc = spawn('claude', args, {
      timeout: timeoutMs,
      shell: true,
      env: { ...process.env },
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`claude exited ${code}: ${stderr}`));
      } else {
        resolve(stdout.trim());
      }
    });

    proc.on('error', (err) => reject(err));
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

// --- VAPI webhook endpoint ---
app.post('/vapi', authenticate, async (req, res) => {
  console.log('[VAPI] Webhook received', req.body?.message?.type);

  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'No message' });

  let userQuery = '';
  let toolCallId = 'bridge-response';

  if (message.type === 'tool-calls' && message.toolCallList) {
    const tc = message.toolCallList[0];
    toolCallId = tc?.id || 'bridge-response';
    try {
      const args = typeof tc.function.arguments === 'string'
        ? JSON.parse(tc.function.arguments)
        : tc.function.arguments;
      userQuery = args.query || args.message || JSON.stringify(args);
    } catch (e) {
      userQuery = tc.function.arguments || '';
    }
  } else if (message.type === 'tool-calls' && message.toolCalls) {
    const tc = message.toolCalls[0];
    toolCallId = tc?.id || 'bridge-response';
    try {
      const args = typeof tc.function.arguments === 'string'
        ? JSON.parse(tc.function.arguments)
        : tc.function.arguments;
      userQuery = args.query || args.message || JSON.stringify(args);
    } catch (e) {
      userQuery = tc.function.arguments || '';
    }
  } else if (message.type === 'function-call' && message.functionCall) {
    toolCallId = message.functionCall.id || 'bridge-response';
    userQuery = message.functionCall.parameters?.query
      || JSON.stringify(message.functionCall.parameters);
  } else {
    userQuery = message.content || JSON.stringify(message);
  }

  if (!userQuery) {
    return res.json({
      results: [{ toolCallId, result: 'Could not extract query' }],
    });
  }

  console.log('[VAPI] Query:', userQuery.substring(0, 100));

  try {
    const response = await runClaudeCode(userQuery);
    console.log('[VAPI] Response length:', response.length);
    res.json({
      results: [{ toolCallId, result: response }],
    });
  } catch (err) {
    console.error('[VAPI] Error:', err.message);
    res.json({
      results: [{ toolCallId, result: `Error: ${err.message}` }],
    });
  }
});

// --- Start server ---
app.listen(PORT, () => {
  console.log(`Claude Bridge server running on http://localhost:${PORT}`);
  console.log(`Endpoints: GET /health | POST /query | POST /vapi`);
});
