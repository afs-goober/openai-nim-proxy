// server.js - OpenAI to NVIDIA NIM API Proxy
// Janitor RP Safe + 413 Protected + Persistent Upstash Memory

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { Redis } = require('@upstash/redis');

const app = express();
const PORT = process.env.PORT || 3000;

// ======================
//  Middleware (413 SAFE)
// ======================
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// ======================
//  API CONFIG
// ======================
const NIM_API_BASE = process.env.NIM_API_BASE || 'https://integrate.api.nvidia.com/v1';
const NIM_API_KEY = process.env.NIM_API_KEY;

// Initialize Upstash Redis
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// ======================
//  SAFE LIMITS
// ======================
const MAX_MESSAGES = 35;
const MAX_MESSAGE_CHARS = 8000;
const MIN_RESPONSE_TOKENS = 50;
const MAX_RETRIES = 5;
const SUMMARY_TRIGGER_MESSAGES = 7;
const SUMMARY_COOLDOWN = 6;

// ======================
//  MODEL MAPPING
// ======================
const MODEL_MAPPING = {
  'gpt-3.5-turbo': 'nvidia/llama-3.1-nemotron-ultra-253b-v1',
  'gpt-4': 'deepseek-ai/deepseek-v3.1-terminus',
  'gpt-4-turbo': 'deepseek-ai/deepseek-v3.2',
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
    service: 'NIM Janitor RP Proxy with Upstash',
    max_messages: MAX_MESSAGES
  });
});

// ======================
//  HELPER: RP-SAFE SUMMARY
// ======================
async function summarizeChat(nimModel, messages) {
  try {
    const prompt = [
      {
        role: 'system',
        content: `Summarize the following roleplay strictly in-universe. 

Rules:
- Write as memories the character would personally remember.
- Preserve relationships, emotions, promises, conflicts, and goals.
- Do NOT mention AI, systems, summaries, or chats.
- Stick ONLY to facts provided in the text.
- Be concise but complete.
- If there is not enough information yet, say "Initial meeting in progress."
- Do NOT invent outside drama or items (like pocket watches).`
      },
      {
        role: 'user',
        content: messages.map(m => `${m.role}: ${m.content}`).join('\n')
      }
    ];

    const res = await axios.post(
      `${NIM_API_BASE}/chat/completions`,
      { model: nimModel, messages: prompt, temperature: 0.3, max_tokens: 500 },
      { headers: { Authorization: `Bearer ${NIM_API_KEY}`, 'Content-Type': 'application/json' } }
    );

    return res.data.choices[0].message.content;
  } catch (err) {
    console.error('Summary failed:', err.message);
    return null;
  }
}

// ======================
//  HELPER: AUTO-RETRY
// ======================
async function requestNimWithDynamicRetry(nimRequest, attempt = 0) {
  const response = await axios.post(
    `${NIM_API_BASE}/chat/completions`,
    nimRequest,
    { headers: { Authorization: `Bearer ${NIM_API_KEY}`, 'Content-Type': 'application/json' } }
  );

  const content = response.data.choices[0].message?.content || '';
  const wc = content.split(/\s+/).length;
  const hasAction = content.includes('*');

  if ((wc < MIN_RESPONSE_TOKENS || !hasAction) && attempt < MAX_RETRIES) {
    return requestNimWithDynamicRetry(
      { ...nimRequest, temperature: Math.min((nimRequest.temperature ?? 0.85) + 0.05, 1) },
      attempt + 1
    );
  }
  return response;
}

// ======================
//  CHAT COMPLETIONS
// ======================
app.post('/v1/chat/completions', async (req, res) => {
  try {
// --- SAFE CHAT ID LOGIC ---
let CHAT_ID =
  req.body.conversation_id ||
  req.body.chat_id ||
  (req.body.character_id ? `char-${req.body.character_id}` : null) ||
  null;

if (!CHAT_ID) {
  // fallback hash from messages (guaranteed stable per chat)
  const crypto = require('crypto');
  const firstMsg = JSON.stringify(req.body.messages?.[0] || {});
  CHAT_ID = crypto.createHash('md5').update(firstMsg).digest('hex');
}

console.log(`[DEBUG] Final CHAT_ID assigned: ${CHAT_ID}`);


    const { model, messages, temperature, max_tokens } = req.body;
    let nimModel = MODEL_MAPPING[model] || 'deepseek-ai/deepseek-v3.2';

    // Clamp messages
    let safeMessages = Array.isArray(messages) ? messages : [];
    safeMessages = safeMessages.map(m =>
      typeof m?.content === 'string' && m.content.length > MAX_MESSAGE_CHARS
        ? { ...m, content: m.content.slice(0, MAX_MESSAGE_CHARS) }
        : m
    );

    // ======================
    //  FETCH MEMORIES FROM UPSTASH
    // ======================
    const coreKey = `core:${CHAT_ID}`;
    const summaryKey = `summary:${CHAT_ID}`;
    const lastAtKey = `lastAt:${CHAT_ID}`;

    let [coreMemory, storySummary, lastAtStr] = await Promise.all([
        redis.get(coreKey),
        redis.get(summaryKey),
        redis.get(lastAtKey)
    ]);

    let lastAt = parseInt(lastAtStr) || 0;

    // Set Core Memory if missing
    if (!coreMemory) {
      coreMemory = `You have an ongoing personal connection with the user. Your emotions and reactions evolve naturally based on shared experiences.`;
      await redis.set(coreKey, coreMemory);
    }

    // ======================
    //  STORY SUMMARY (ROLLING)
    // ======================
    if (
      safeMessages.length > SUMMARY_TRIGGER_MESSAGES &&
      (safeMessages.length - lastAt) >= SUMMARY_COOLDOWN
    ) {
      const summary = await summarizeChat(nimModel, safeMessages.slice(0, -20));

      if (summary) {
        storySummary = summary;
        await Promise.all([
            redis.set(summaryKey, summary),
            redis.set(lastAtKey, safeMessages.length)
        ]);
      }
    }

    if (safeMessages.length > MAX_MESSAGES) {
      safeMessages = safeMessages.slice(-MAX_MESSAGES);
    }

    // ======================
    //  MEMORY INJECTION (FIXED)
    // ======================
    const memoryInjection = [
      { role: 'system', content: coreMemory },
      storySummary ? { role: 'system', content: `Previous Events Summary: ${storySummary}` } : null,
      {
        role: 'system',
        content: `You are a fictional character in an ongoing roleplay.
Stay fully in character at all times.
Use dialogue and descriptive actions (*like this*).
Never mention AI, systems, or summaries.
Avoid short replies. Continue the scene naturally.
You will never talk for {{user}}
If there are other characters present in a scene, you will talk and act for all of them.
Think carefully about emotions, motivations, continuity, and cause-and-effect.
Do not reveal thoughts. Only output dialogue and actions.`
      }
    ].filter(Boolean); // This removes any "null" values cleanly

    safeMessages = [...memoryInjection, ...safeMessages];

    // ======================
    //  SEND REQUEST
    // ======================
    const response = await requestNimWithDynamicRetry({
      model: nimModel,
      messages: safeMessages,
      temperature: temperature ?? 0.85,
      presence_penalty: 0.6,
      top_p: 0.9,
      max_tokens: Math.min(max_tokens ?? 2048, 2048)
    });

    res.json({
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: response.data.choices,
      usage: response.data.usage || {}
    });

  } catch (err) {
    console.error('Proxy error:', err.message);
    res.status(500).json({ error: { message: err.message } });
  }
});

// ======================
//  START SERVER
// ======================
app.listen(PORT, () => {
  console.log(`NIM Janitor RP Proxy running on port ${PORT}`);
});
