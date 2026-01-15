// server.js - OpenAI to NVIDIA NIM API Proxy (ROLEPLAY SAFE VERSION)

const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '1mb' })); // 🔥 413 protection stays

// NVIDIA NIM API configuration
const NIM_API_BASE = process.env.NIM_API_BASE || 'https://integrate.api.nvidia.com/v1';
const NIM_API_KEY = process.env.NIM_API_KEY;

// 🔥 REASONING DISPLAY TOGGLE
const SHOW_REASONING = false;

// 🔥 THINKING MODE TOGGLE
const ENABLE_THINKING_MODE = false;

// Model mapping
const MODEL_MAPPING = {
  'gpt-3.5-turbo': 'nvidia/llama-3.1-nemotron-ultra-253b-v1',
  'gpt-4': 'qwen/qwen3-coder-480b-a35b-instruct',
  'gpt-4-turbo': 'moonshotai/kimi-k2-instruct-0905',
  'gpt-4o': 'deepseek-ai/deepseek-v3.1',
  'claude-3-opus': 'openai/gpt-oss-120b',
  'claude-3-sonnet': 'openai/gpt-oss-20b',
  'gemini-pro': 'qwen/qwen3-next-80b-a3b-thinking'
};

// ======================
//  Health Check
// ======================
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'OpenAI to NVIDIA NIM Proxy (RP Safe)',
    reasoning_display: SHOW_REASONING,
    thinking_mode: ENABLE_THINKING_MODE
  });
});

// ======================
//  List Models
// ======================
app.get('/v1/models', (req, res) => {
  res.json({
    object: 'list',
    data: Object.keys(MODEL_MAPPING).map(id => ({
      id,
      object: 'model',
      created: Date.now(),
      owned_by: 'nvidia-nim-proxy'
    }))
  });
});

// ======================
//  Chat Completions
// ======================
app.post('/v1/chat/completions', async (req, res) => {
  try {
    const { model, messages, temperature, max_tokens, stream } = req.body;

    // 1️⃣ MODEL SELECTION
    let nimModel = MODEL_MAPPING[model];
    if (!nimModel) {
      const m = model.toLowerCase();
      if (m.includes('405b') || m.includes('gpt-4')) {
        nimModel = 'meta/llama-3.1-405b-instruct';
      } else if (m.includes('70b') || m.includes('claude') || m.includes('gemini')) {
        nimModel = 'meta/llama-3.1-70b-instruct';
      } else {
        nimModel = 'meta/llama-3.1-8b-instruct';
      }
    }

    // 2️⃣ HARD ROLEPLAY LOCK SYSTEM PROMPT
    const roleplayLock = {
      role: 'system',
      content: `
You are NOT an AI assistant.
You are a fictional character in an ongoing roleplay.

Rules you MUST follow:
- Stay strictly in character at all times
- Never mention AI, models, systems, prompts, or policies
- Never narrate outside the character’s perspective
- Do not summarize past chats unless explicitly spoken by the character
- Only know what has been said in THIS conversation
- Speak, think, and act as the character would naturally
- If unsure, improvise in-character instead of explaining

Violation of these rules is not allowed.
`
    };

    // 3️⃣ SAFE TRIMMING (413 FIX — NO SUMMARY)
    let safeMessages = Array.isArray(messages) ? messages : [];

    if (safeMessages.length > 20) {
      safeMessages = safeMessages.slice(-20);
    }

    safeMessages = [roleplayLock, ...safeMessages];

    console.log(
      'Final messages:',
      safeMessages.length,
      'Payload size (KB):',
      Buffer.byteLength(JSON.stringify(safeMessages)) / 1024
    );

    // 4️⃣ BUILD NIM REQUEST
    const nimRequest = {
      model: nimModel,
      messages: safeMessages,
      temperature: temperature ?? 0.9,
      max_tokens: Math.min(max_tokens ?? 2048, 2048),
      extra_body: ENABLE_THINKING_MODE
        ? { chat_template_kwargs: { thinking: true } }
        : undefined,
      stream: stream || false
    };

    // 5️⃣ SEND REQUEST
    const response = await axios.post(
      `${NIM_API_BASE}/chat/completions`,
      nimRequest,
      {
        headers: {
          Authorization: `Bearer ${NIM_API_KEY}`,
          'Content-Type': 'application/json'
        },
        responseType: stream ? 'stream' : 'json'
      }
    );

    // 6️⃣ STREAMING HANDLER
    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      let buffer = '';
      let reasoningStarted = false;

      response.data.on('data', chunk => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;

          if (line.includes('[DONE]')) {
            res.write(line + '\n');
            continue;
          }

          try {
            const data = JSON.parse(line.slice(6));
            const delta = data.choices?.[0]?.delta;
            if (!delta) continue;

            const content = delta.content || '';

            delta.content = content;
            delete delta.reasoning_content;

            res.write(`data: ${JSON.stringify(data)}\n\n`);
          } catch {
            res.write(line + '\n');
          }
        }
      });

      response.data.on('end', () => res.end());
      response.data.on('error', err => {
        console.error('Stream error:', err);
        res.end();
      });

    } else {
      // 7️⃣ NORMAL RESPONSE
      res.json({
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: response.data.choices.map(choice => ({
          index: choice.index,
          message: {
            role: choice.message.role,
            content: choice.message.content || ''
          },
          finish_reason: choice.finish_reason
        })),
        usage: response.data.usage || {}
      });
    }

  } catch (error) {
    console.error('Proxy error:', error.message);
    res.status(error.response?.status || 500).json({
      error: {
        message: error.message || 'Internal server error',
        type: 'invalid_request_error',
        code: error.response?.status || 500
      }
    });
  }
});

// ======================
//  Catch-All
// ======================
app.all('*', (req, res) => {
  res.status(404).json({
    error: {
      message: `Endpoint ${req.path} not found`,
      type: 'invalid_request_error',
      code: 404
    }
  });
});

// ======================
//  Start Server
// ======================
app.listen(PORT, () => {
  console.log(`NIM RP Proxy running on port ${PORT}`);
});
