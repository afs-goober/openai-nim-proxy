// ========================================================
//  server.js – OpenAI → NVIDIA NIM API Proxy
// ========================================================
const express   = require('express');
const cors      = require('cors');
const axios     = require('axios');

// ---------------------------------------------------
//  App setup
// ---------------------------------------------------
const app = express();
app.use(cors());

// ---------------------------------------------------
//  Configuration & constants
// ---------------------------------------------------
const NIM_API_BASE = process.env.NIM_API_BASE || 'https://integrate.api.nvidia.com/v1';
const NIM_API_KEY   = process.env.NIM_API_KEY;

const SHOW_REASONING = false;          // toggle reasoning display
const ENABLE_THINKING_MODE = false;    // enable thinking mode

const MODEL_MAPPING = {
  'gpt-3.5-turbo'      : 'nvidia/llama-3.1-nemotron-ultra-253b-v1',
  'gpt-4'              : 'qwen/qwen3-coder-480b-a35b-instruct',
  'gpt-4-turbo'        : 'moonshotai/kimi-k2-instruct-0905',
  'gpt-4o'             : 'deepseek-ai/deepseek-v3.1',
  'claude-3-opus'      : 'openai/gpt-oss-120b',
  'claude-3-sonnet'    : 'openai/gpt-oss-20b',
  'gemini-pro'         : 'qwen/qwen3-next-80b-a3b-thinking'
};

// ---------------------------------------------------
//  Health check
// ---------------------------------------------------
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok',
    service: 'OpenAI → NVIDIA NIM Proxy',
    reasoning_display: SHOW_REASONING,
    thinking_mode: ENABLE_THINKING_MODE
  });

// ---------------------------------------------------
//  Model list (OpenAI‑compatible)
// ---------------------------------------------------
app.get('/v1/models', (req, res) => {
  const models = Object.keys(MODEL_MAPPING).map(m => ({
    id: m,
    object: 'model',
    created: Date.now(),
    owned_by: 'nvidia-nim-proxy'
  });
  res.json({ object: 'list', data: models });

// ---------------------------------------------------
//  1️⃣  Non‑stream route (has the JSON parser)
// ---------------------------------------------------
const jsonParser = express.json({ limit: '5mb' });   // increase limit if you need it

app.post('/v1/chat/completions', jsonParser, async (req, res) => {
  // --------------------------- YOUR ORIGINAL LOGIC ---------------------------
  try {
    const { model, messages, temperature, max_tokens, stream } = req.body;

    // ----- Model selection & fallback -------------------------------
    let nimModel = MODEL_MAPPING[model];
    if (!nimModel) {
      try {
        await axios.post(`${NIM_API_BASE}/chat/completions`, {
          model: model,
          messages: [{ role: 'user', content: 'test' }],
          max_tokens: 1
        }, {
          headers: { Authorization: `Bearer ${process.env.NIM_API_KEY}`,
                     'Content-Type': 'application/json' },
          validateStatus: s => s < 500
        }).then(r => { if (r.status >= 200 && r.status < 300) nimModel = model; });
      } catch (_) {}
      if (!nimModel) {
        const lc = model.toLowerCase();
        if (lc.includes('gpt-4') || lc.includes('claude-opus') || lc.includes('405b')) {
          nimModel = 'meta/llama-3.1-405b-instruct';
        } else if (lc.includes('claude') || lc.includes('gemini') || lc.includes('70b')) {
          nimModel = 'meta/llama-3.1-70b-instruct';
        } else {
          nimModel = 'meta/llama-3.1-8b-instruct';
        }
      }
    }

    // ----- Build the request for NIM -------------------------------
    const nimRequest = {
      model: nimModel,
      messages: messages,
      temperature: temperature || 0.6,
      max_tokens: max_tokens || 9024,
      ...(ENABLE_THINKING_MODE ? { extra_body: { chat_template_kwargs: { thinking: true } } } : {}),
      stream: stream || false
    };

    // ----- Call NVIDIA NIM -----------------------------------------
    const response = await axios.post(
      `${NIM_API_BASE}/chat/completions`,
      nimRequest,
      {
        headers: { Authorization: `Bearer ${process.env.NIM_API_KEY}`,
                   'Content-Type': 'application/json' },
        responseType: stream ? 'stream' : 'json'
      }
    );

    // ---------- Pure JSON (non‑stream) response --------------------
    if (!stream) {
      const openaiResponse = {
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: model,
        choices: response.data.choices.map(c => {
          let fullContent = c.message?.content || '';
          if (SHOW_REASONING && c.message?.reasoning_content) {
            fullContent = ` Trace\\n${c.message.reasoning_content}\\n\\n\\n${fullContent}`;
          }
          return {
            index: c.index,
            message: { role: c.message.role, content: fullContent, finish_reason: c.finish_reason },
            finish_reason: c.finish_reason
          };
        }),
        usage: response.data.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
      };
      res.json(openaiResponse);
      return;
    }

    // If we reach here the request asked for a stream but we already handled it.
    // Just call the streaming helper (or copy your streaming logic here).
    await streamToClient(req, res);
  } catch (error) {
    console.error('Proxy error:', error.message);
    res.status(error.response?.status || 500).json({
      error: {
        message: error.message || 'Internal server error',
        type: 'invalid_request_error',
        code: error.response?.status || 500
      }
    });
  }   // <-- closes the try / catch block

// ---------------------------------------------------
//  2️⃣  Streaming‑only route (bypasses any parser)
// ---------------------------------------------------
app.post('/v1/chat/completions', async (req, res) => {
  if (req.query.stream === 'true') {
    await streamToClient(req, res);   // helper defined below
    return;
  }
  // If there is no `stream` flag we simply ignore the request.
  // It will be handled by the non‑stream handler above.
});   // ← closes the streaming‑only route handler

// ---------------------------------------------------
//  3️⃣  Helper that streams data from NIM → client
// ---------------------------------------------------
async function streamToClient(req, res) {
  try {
    // Raw request body (no JSON parsing has happened yet)
    const { messages, temperature, max_tokens } = req.body;

    // Call NVIDIA NIM with streaming enabled
    const upstream = await axios.post(
      `${process.env.NIM_API_BASE}/chat/completions`,
      { messages, temperature, max_tokens, stream: true },
      {
        headers: { Authorization: `Bearer ${process.env.NIM_API_KEY}`,
                   'Content-Type': 'application/json' },
        responseType: 'stream',
        timeout: 0
      }
    );

    // ---- SSE‑compatible headers (Render/Nginx friendly) ----
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Transfer-Encoding', 'chunked');

    // ----- Pipe chunks, merge reasoning if desired -----
    let buffer = '';
    let reasoningStarted = false;

    upstream.data.on('data', chunk => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      lines.forEach(line => {
        if (!line.startsWith('data: ')) return;

        if (line.includes('[DONE]')) {
          res.write(line + '\n\n');
          return;
        }

        try {
          const data = JSON.parse(line.slice(6)); // strip "data: "

          // OPTIONAL: merge reasoning into the delta.content field
          if (SHOW_REASONING && data.choices?.[0]?.delta) {
            const reasoning = data.choices[0].delta.reasoning_content;
            const content   = data.choices[0].delta.content;
            if (reasoning) {
              if (!reasoningStarted) {
                data.choices[0].delta.content = ` Trace\\n${reasoning}\\n\\n\\n`;
                reasoningStarted = true;
              } else {
                data.choices[0].delta.content = `${reasoning}\\n\\n\\n`;
              }
              delete data.choices[0].delta.reasoning_content;
            } else if (content) {
              data.choices[0].delta.content = content;
              delete data.choices[0].delta.reasoning_content;
            }
          }

          res.write(`data: ${JSON.stringify(data)}\n\n`);
        } catch (_) {
          // malformed line – just forward it unchanged
          res.write(line + '\n');
        }
      });

    upstream.data.on('end', () => res.end());
    upstream.data.on('error', err => {
      console.error('Upstream stream error:', err);
      res.end();
    });
  } catch (err) {
    console.error('Streaming proxy error:', err);
    res.status(err.response?.status || 500).json({
      error: { message: err.message || 'Streaming proxy failed',
               type: 'internal_error',
               code: err.response?.status || 500 }
      }
    );
  }
}

// ---------------------------------------------------
//  Model list (used by both routes)
// ---------------------------------------------------
app.get('/v1/models', (req, res) => {
  const models = Object.keys(MODEL_MAPPING).map(m => ({
    id: m,
    object: 'model',
    created: Date.now(),
    owned_by: 'nvidia-nim-proxy'
  });
  res.json({ object: 'list', data: models });

// ---------------------------------------------------
//  Catch‑all for unknown endpoints
// ---------------------------------------------------
app.all('*', (req, res) => {
  res.status(404).json({
    error: { message: `Endpoint ${req.path} not found`,
             type: 'invalid_request_error',
             code: 404 }
          };

// ---------------------------------------------------
//  Start the server
// ---------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`OpenAI → NVIDIA NIM Proxy running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`Reasoning display: ${SHOW_REASONING ? 'ENABLED' : 'DISABLED'}`);
  console.log(`Thinking mode: ${ENABLE_THINKING_MODE ? 'ENABLED' : 'DISABLED'}`);
});
