/* ---------------------------------------------------------------
   0️⃣  Imports & basic app setup
   --------------------------------------------------------------- */
const express = require('express');
const cors = require('cors');
const axios = require('axios');
require('dotenv').config();               // optional - loads .env locally

const app = express();
const PORT = process.env.PORT || 3000;

/* ---------------------------------------------------------------
   1️⃣  Configuration & constants
   --------------------------------------------------------------- */
const NIM_API_BASE = process.env.NIM_API_BASE || 'https://integrate.api.nvidia.com/v1';
const NIM_API_KEY = process.env.NIM_API_KEY;
const SHOW_REASONING = false;          // toggle reasoning display
const ENABLE_THINKING_MODE = false;    // enable thinking for supported models

// Example model map (keep or edit as you like)
const MODEL_MAPPING = {
  'gpt-3.5-turbo': 'nvidia/llama-3.1-nemotron-ultra-253b-v1',
  'gpt-4': 'qwen/qwen3-coder-480b-a35b-instruct',
  'gpt-4-turbo': 'moonshotai/kimi-k2-instruct-0905',
  'gpt-4o': 'deepseek-ai/deepseek-v3.1',
  'claude-3-opus': 'openai/gpt-oss-120b',
  'claude-3-sonnet': 'openai/gpt-oss-20b',
  'gemini-pro': 'qwen/qwen3-next-80b-a3b-thinking' 
};

const MAX_BODY_BYTES = process.env.MAX_BODY_BYTES || '5mb'; // limit for normal JSON bodies

/* ---------------------------------------------------------------
   2️⃣  Middleware
   --------------------------------------------------------------- */
// CORS (allow whatever origin your front‑end uses)
app.use(cors());

// JSON parser – **only** applied *after* the streaming guard
app.use(express.json({ limit: MAX_BODY_BYTES }));
app.use(express.urlencoded({ extended: true, limit: MAX_BODY_BYTES }));

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'OpenAI → NVIDIA NIM Proxy',
    reasoning_display: SHOW_REASONING,
    thinking_mode: ENABLE_THINKING_MODE
  });
});

/* ---------------------------------------------------------------
   3️⃣  Helper: pipeStreamToClient (the one that merges reasoning)
   --------------------------------------------------------------- */
async function pipeStreamToClient(srcStream, res, { showReasoning = false } = {}) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  let rawBuffer = '';
  let reasoningStarted = false;

  const onData = (chunk) => {
    rawBuffer += chunk.toString();
    const lines = rawBuffer.split('\n');
    rawBuffer = lines.pop() || '';

    lines.forEach((line) => {
      if (!line.startsWith('data:')) return;
      try {
        const payload = JSON.parse(line.slice(6)); // strip "data: "
        const delta = payload.choices?.[0]?.delta;
        if (!delta) return;

        // ----- Reasoning merge -------------------------------------------------
        if (showReasoning && delta.reasoning_content && !reasoningStarted) {
          const prefixed = '  Reasoning▌\n' + delta.reasoning_content + '\n\n';
          delta.content = prefixed;
          delete delta.reasoning_content;
          reasoningStarted = true;
        } else if (delta.reasoning_content) {
          delete delta.reasoning_content;
        }

        // ----- Clean up the content for SSE ------------------------------------
        const cleaned = delta.content?.replace(/\n/g, '\\n') || '';
        const finalDelta = { ...delta, content: cleaned };
        delete finalDelta.reasoning_content;

        const sseLine = `data: ${JSON.stringify({ ...payload, choices: [{ ...finalDelta }] })}\n\n`;
        res.write(sseLine);
      } catch (e) {
        // If parsing fails we just forward the raw line – helps debugging
        res.write(line + '\n');
      }
    });
  };

  const onError = (err) => {
    console.error('Stream error (pipeStreamToClient):', err);
    res.destroy(err);
  };

  srcStream.on('data', onData);
  srcStream.on('error', onError);
  srcStream.on('end', () => {
    // Send a final empty delta so the client knows we are done
    if (!res.headersSent) {
      res.write('data: {\"choices\":[{\"delta\":{}}],"usage":{}}\n\n');
    }
    res.end();
  });
}

/* ---------------------------------------------------------------
   4️⃣  MAIN endpoint – streaming vs non‑streaming
   --------------------------------------------------------------- */
app.post('/v1/chat/completions', async (req, res) => {
  // ---- Streaming request? -------------------------------------------------
  if (req.query.stream === 'true' || req.get('x-stream') === 'true') {
    // NOTE: No body parser runs before this call, so we never hit 413.
    await streamToClient(req, res);
    return;   // we are done – response is already streaming
  }

  // ---- Normal (non‑stream) request -----------------------------------------
  // From here the code continues exactly as your original version –
  // you can keep the rest of your implementation (model selection,
  // building `nimRequest`, calling NIM, building OpenAI‑compatible JSON,
  // sending the response, etc.).
  // -------------------------------------------------------------------------
  // ... (your original non‑stream code stays unchanged) ...
});

/* ---------------------------------------------------------------
   5️⃣  Catch‑all 404 handler (optional)
   --------------------------------------------------------------- */
app.all('*', (req, res) => {
  res.status(404).json({
    error: {
      message: `Endpoint ${req.path} not found`,
      type: 'invalid_request_error',
      code: 404
    }
  });
});

/* ---------------------------------------------------------------
   6️⃣  Start the server
   --------------------------------------------------------------- */
app.listen(PORT, () => {
  console.log(`🚀 Proxy listening on ${PORT}`);
  console.log('Health: http://localhost:' + PORT + '/health');
});

