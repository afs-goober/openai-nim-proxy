// server.js - OpenAI to NVIDIA NIM API Proxy
// Janitor RP Safe + 413 Protected + OpenRouter-like Layer
// + Multi-Layer Per-Chat Memory + Wipe Commands

const express = require('express');
const cors = require('cors');
const axios = require('axios');

const ENABLE_THINKING = true;

const app = express();
const PORT = process.env.PORT || 3000;

// ======================
// Middleware (413 SAFE)
// ======================
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// ======================
// NVIDIA NIM CONFIG
// ======================
const NIM_API_BASE = process.env.NIM_API_BASE || 'https://integrate.api.nvidia.com/v1';
const NIM_API_KEY = process.env.NIM_API_KEY;

// ======================
// SAFE LIMITS
// ======================
const MAX_MESSAGES = 30;          // <<< recent context size
const MAX_MESSAGE_CHARS = 8000;
const MIN_RESPONSE_TOKENS = 50;
const MAX_RETRIES = 5;

// ======================
// MEMORY CONFIG
// ======================
const SUMMARY_TRIGGER_MESSAGES = 60;
const SUMMARY_COOLDOWN = 40;

// ======================
// MEMORY STORAGE (PER CHAT)
// ======================
const CORE_MEMORIES = new Map();
const STORY_SUMMARIES = new Map();
const LAST_SUMMARY_AT = new Map();

// ======================
// MODEL MAPPING
// ======================
const MODEL_MAPPING = {
  'gpt-3.5-turbo': 'nvidia/llama-3.1-nemotron-ultra-253b-v1',
  'gpt-4': 'deepseek-ai/deepseek-v3.2',
  'gpt-4o': 'deepseek-ai/deepseek-v3.1'
};

// ======================
// HEALTH CHECK
// ======================
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'NIM Janitor RP Proxy',
    memory_layers: ['core', 'story_summary', 'recent_context_30']
  });
});

// ======================
// HELPER: RP-SAFE SUMMARY
// ======================
async function summarizeChat(model, messages) {
  try {
    const res = await axios.post(
      `${NIM_API_BASE}/chat/completions`,
      {
        model,
        messages: [
          {
            role: 'system',
            content: `
Summarize the roleplay strictly in-universe.
Preserve relationships, emotions, promises, conflicts, and goals.
Never mention AI, systems, summaries, or chats.
`
          },
          {
            role: 'user',
            content: messages.map(m => `${m.role}: ${m.content}`).join('\n')
          }
        ],
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
  } catch {
    return null;
  }
}

// ======================
// HELPER: AUTO-RETRY
// ======================
async function requestWithRetry(payload, attempt = 0) {
  const res = await axios.post(
    `${NIM_API_BASE}/chat/completions`,
    payload,
    {
      headers: {
        Authorization: `Bearer ${NIM_API_KEY}`,
        'Content-Type': 'application/json'
      }
    }
  );

  const text = res.data.choices[0].message?.content || '';
  const wc = text.split(/\s+/).length;

  if (wc < MIN_RESPONSE_TOKENS && attempt < MAX_RETRIES) {
    return requestWithRetry(
      { ...payload, temperature: Math.min((payload.temperature ?? 0.85) + 0.05, 1) },
      attempt + 1
    );
  }

  return res;
}

// ======================
// CHAT COMPLETIONS
// ======================
app.post('/v1/chat/completions', async (req, res) => {
  try {
    const CHAT_ID =
      req.headers['x-chat-id'] ||
      `temp-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    const { model, messages, temperature, max_tokens } = req.body;
    const lastMessage = messages?.[messages.length - 1]?.content
  ?.toLowerCase()
  ?.trim();


    // ======================
    // WIPE COMMANDS
    // ======================
   if (lastMessage === '/wipe') {
      CORE_MEMORIES.delete(CHAT_ID);
      STORY_SUMMARIES.delete(CHAT_ID);
      LAST_SUMMARY_AT.delete(CHAT_ID);

      return res.json({
        choices: [{ message: { role: 'assistant', content: '*This chat’s memories have been cleared.*' } }]
      });
    }

    if (lastMessage === '/wipe_all') {
      CORE_MEMORIES.clear();
      STORY_SUMMARIES.clear();
      LAST_SUMMARY_AT.clear();

      return res.json({
        choices: [{ message: { role: 'assistant', content: '*All stored memories have been erased.*' } }]
      });
    }

    // ======================
    // MODEL
    // ======================
    const nimModel = MODEL_MAPPING[model] || 'deepseek-ai/deepseek-v3.1';

    // ======================
    // CLAMP MESSAGES
    // ======================
    let safeMessages = Array.isArray(messages) ? messages : [];
    safeMessages = safeMessages.map(m =>
      typeof m?.content === 'string' && m.content.length > MAX_MESSAGE_CHARS
        ? { ...m, content: m.content.slice(0, MAX_MESSAGE_CHARS) }
        : m
    );

    // ======================
    // CORE MEMORY
    // ======================
    if (!CORE_MEMORIES.has(CHAT_ID)) {
      CORE_MEMORIES.set(
        CHAT_ID,
        'You have an evolving emotional relationship with the user.'
      );
    }

    // ======================
    // STORY SUMMARY
    // ======================
    const lastAt = LAST_SUMMARY_AT.get(CHAT_ID) || 0;

    if (
      safeMessages.length > SUMMARY_TRIGGER_MESSAGES &&
      safeMessages.length - lastAt >= SUMMARY_COOLDOWN
    ) {
      const summary = await summarizeChat(nimModel, safeMessages.slice(0, -15));
      if (summary) {
        STORY_SUMMARIES.set(CHAT_ID, summary);
        LAST_SUMMARY_AT.set(CHAT_ID, safeMessages.length);
      }
    }

    // ======================
    // RECENT CONTEXT (30)
    // ======================
    if (safeMessages.length > MAX_MESSAGES) {
      safeMessages = safeMessages.slice(-MAX_MESSAGES);
    }

    // ======================
    // MEMORY INJECTION
    // ======================
    const systemMessages = [
      { role: 'system', content: CORE_MEMORIES.get(CHAT_ID) },
      STORY_SUMMARIES.has(CHAT_ID)
        ? { role: 'system', content: STORY_SUMMARIES.get(CHAT_ID) }
        : null,
      {
        role: 'system',
        content: `
You are a fictional character in an ongoing roleplay.
Stay fully in character.
Use dialogue and descriptive actions (*like this*).
Never mention AI or systems.
Avoid short replies.
${ENABLE_THINKING ? 'Think carefully about continuity and emotions, but never reveal thoughts.' : ''}
`
      }
    ].filter(Boolean);

    safeMessages = [...systemMessages, ...safeMessages];

    // ======================
    // SEND
    // ======================
    const response = await requestWithRetry({
      model: nimModel,
      messages: safeMessages,
      temperature: temperature ?? 0.85,
      top_p: 0.9,
      presence_penalty: 0.6,
      max_tokens: Math.min(max_tokens ?? 2048, 2048)
    });

    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
});

// ======================
// START SERVER
// ======================
app.listen(PORT, () => {
  console.log(`NIM Janitor RP Proxy running on port ${PORT}`);
});
