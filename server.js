// server.js - OpenAI to NVIDIA NIM API Proxy
// Janitor RP Safe + 413 Protected + OpenRouter-like Layer
// + Dynamic Auto-Regeneration + Per-Chat Memory Summaries

const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// ======================
//  Middleware (413 SAFE)
// ======================
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// ======================
//  NVIDIA NIM CONFIG
// ======================
const NIM_API_BASE = process.env.NIM_API_BASE || 'https://integrate.api.nvidia.com/v1';
const NIM_API_KEY = process.env.NIM_API_KEY;

// ======================
//  TOGGLES
// ======================
const SHOW_REASONING = false;
const ENABLE_THINKING_MODE = false;

// ======================
//  SAFE LIMITS
// ======================
const MAX_MESSAGES = 80;
const MAX_MESSAGE_CHARS = 8000;
const MIN_RESPONSE_TOKENS = 50;
const MAX_RETRIES = 5;

// ======================
//  MEMORY / SUMMARY STORAGE (PER CHAT)
// ======================
const CHAT_SUMMARIES = new Map();

// ======================
//  MODEL MAPPING
// ======================
const MODEL_MAPPING = {
  'gpt-3.5-turbo': 'nvidia/llama-3.1-nemotron-ultra-253b-v1',
  'gpt-4': 'meta/llama-3.1-70b-instruct',
  'gpt-4-turbo': 'moonshotai/kimi-k2-instruct-0905',
  'gpt-4o': 'deepseek-ai/deepseek-v3.1',
  'claude-3-opus': 'openai/gpt-oss-120b',
  'claude-3-sonnet': 'openai/gpt-oss-20b',
  'gemini-pro': 'qwen/qwen3-next-80b-a3b-thinking'
};

// ======================
//  HEALTH CHECK
// ======================
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'NIM Janitor RP Proxy',
    max_messages: MAX_MESSAGES,
    max_message_chars: MAX_MESSAGE_CHARS
  });
});

// ======================
//  LIST MODELS
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
//  HELPER: RP SAFE SUMMARY
// ======================
async function summarizeChat(nimModel, messages) {
  try {
    const prompt = [
      {
        role: 'system',
        content: `
Summarize the following roleplay strictly in-universe.

Rules:
- Write as memories the character would personally remember
- Preserve relationships, emotions, promises, conflicts, and goals
- Do NOT mention AI, systems, summaries, or chats
- Be concise but complete
`
      },
      {
        role: 'user',
        content: messages.map(m => `${m.role}: ${m.content}`).join('\n')
      }
    ];

    const res = await axios.post(
      `${NIM_API_BASE}/chat/completions`,
      {
        model: nimModel,
        messages: prompt,
        temperature: 0.3,
        max_tokens: 500
      },
      {
        headers: {
          Authorization: `Bearer ${NIM_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    return res.data.choices[0].message.content;
  } catch (err) {
    console.error('Summary failed:', err.message);
    return null;
  }
}

// ======================
//  HELPER: Dynamic Auto-Regeneration
// ======================
async function requestNimWithDynamicRetry(nimRequest, attempt = 0) {
  const response = await axios.post(
    `${NIM_API_BASE}/chat/completions`,
    nimRequest,
    {
      headers: {
        Authorization: `Bearer ${NIM_API_KEY}`,
        'Content-Type': 'application/json'
      },
      responseType: nimRequest.stream ? 'stream' : 'json'
    }
  );

  if (!nimRequest.stream) {
    const content = response.data.choices[0].message?.content || '';
    const wc = content.split(/\s+/).length;
    const hasAction = content.includes('*');

    if ((wc < MIN_RESPONSE_TOKENS || !hasAction) && attempt < MAX_RETRIES) {
      const adjusted = {
        ...nimRequest,
        temperature: Math.min((nimRequest.temperature ?? 0.85) + 0.05, 1.0)
      };
      return requestNimWithDynamicRetry(adjusted, attempt + 1);
    }
  }

  return response;
}

// ======================
//  CHAT COMPLETIONS
// ======================
app.post('/v1/chat/completions', async (req, res) => {
  try {
    const CHAT_ID = req.headers['x-chat-id'];
    if (!CHAT_ID) {
      return res.status(400).json({
        error: { message: 'Missing x-chat-id header' }
      });
    }

    const { model, messages, temperature, max_tokens, stream } = req.body;

    // ----------------------
    //  MODEL SELECTION
    // ----------------------
    let nimModel = MODEL_MAPPING[model];
    if (!nimModel) {
      const m = model.toLowerCase();
      if (m.includes('405b')) nimModel = 'meta/llama-3.1-405b-instruct';
      else if (m.includes('70b')) nimModel = 'meta/llama-3.1-70b-instruct';
      else nimModel = 'meta/llama-3.1-8b-instruct';
    }

    // ----------------------
    //  CLAMP MESSAGES
    // ----------------------
    let safeMessages = Array.isArray(messages) ? messages : [];
    safeMessages = safeMessages.map(m =>
      typeof m?.content === 'string' && m.content.length > MAX_MESSAGE_CHARS
        ? { ...m, content: m.content.slice(0, MAX_MESSAGE_CHARS) }
        : m
    );

    // ----------------------
    //  PER-CHAT SUMMARY
    // ----------------------
    let summary = CHAT_SUMMARIES.get(CHAT_ID);

    if (!summary && safeMessages.length > 70) {
      const summaryText = await summarizeChat(
        nimModel,
        safeMessages.slice(0, -20)
      );
      if (summaryText) {
        CHAT_SUMMARIES.set(CHAT_ID, summaryText);
        summary = summaryText;
      }
    }

    if (safeMessages.length > MAX_MESSAGES) {
      safeMessages = safeMessages.slice(-MAX_MESSAGES);
    }

    if (summary) {
      safeMessages.unshift({
        role: 'system',
        content: `
You remember the following events as part of your lived experience.
These memories influence your behavior but should not be referenced directly.

${summary}
`
      });
    }

    // ----------------------
    //  HARD ROLEPLAY LOCK
    // ----------------------
    safeMessages.unshift({
      role: 'system',
      content: `
You are a fictional character in an ongoing roleplay.
Stay fully in character at all times.
Use dialogue and descriptive actions (*like this*).
Never mention AI, systems, or summaries.
Avoid short replies. Continue the scene naturally.
`
    });

    // ----------------------
    //  BUILD REQUEST
    // ----------------------
    const nimRequest = {
      model: nimModel,
      messages: safeMessages,
      temperature: temperature ?? 0.85,
      presence_penalty: 0.6,
      top_p: 0.9,
      max_tokens: Math.min(max_tokens ?? 2048, 2048),
      stream: stream || false
    };

    const response = await requestNimWithDynamicRetry(nimRequest);

    // ----------------------
    //  RESPONSE
    // ----------------------
    if (!stream) {
      res.json({
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: response.data.choices,
        usage: response.data.usage || {}
      });
    } else {
      res.setHeader('Content-Type', 'text/event-stream');
      response.data.pipe(res);
    }

  } catch (err) {
    console.error('Proxy error:', err.message);
    res.status(500).json({
      error: { message: err.message }
    });
  }
});

// ======================
//  START SERVER
// ======================
app.listen(PORT, () => {
  console.log(`NIM Janitor RP Proxy running on port ${PORT}`);
});
