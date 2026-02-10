// server.js - JanitorAI → NVIDIA NIM RP Proxy
// Persistent Multi-Layer Memory + Resumable Chats

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ======================
// Middleware
// ======================
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// ======================
// NVIDIA NIM CONFIG
// ======================
const NIM_API_BASE = process.env.NIM_API_BASE || 'https://integrate.api.nvidia.com/v1';
const NIM_API_KEY = process.env.NIM_API_KEY;

// ======================
// Limits & Memory Config
// ======================
const MAX_MESSAGES = 35;
const MAX_MESSAGE_CHARS = 8000;
const MIN_RESPONSE_TOKENS = 50;
const MAX_RETRIES = 5;
const SUMMARY_TRIGGER_MESSAGES = 60;
const SUMMARY_COOLDOWN = 40;

// ======================
// Persistent Memory Dir
// ======================
const MEMORY_DIR = path.join(__dirname, 'chat_memory');
if (!fs.existsSync(MEMORY_DIR)) fs.mkdirSync(MEMORY_DIR);

function memoryPath(chatId) {
  return path.join(MEMORY_DIR, `${chatId}.json`);
}

function loadMemory(chatId) {
  if (!fs.existsSync(memoryPath(chatId))) return null;
  return JSON.parse(fs.readFileSync(memoryPath(chatId), 'utf8'));
}

function saveMemory(chatId, memory) {
  fs.writeFileSync(memoryPath(chatId), JSON.stringify(memory, null, 2));
}

// ======================
// Model Mapping
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
// Helper: Resolve Chat ID
// ======================
function resolveChatId(req) {
  // 1️⃣ Header first
  if (req.headers['x-chat-id']) return String(req.headers['x-chat-id']);
  // 2️⃣ Try JanitorAI referer URL
  const ref = req.headers['referer'] || req.headers['referrer'];
  if (ref) {
    const match = ref.match(/\/chats\/(\d+)/);
    if (match) return match[1];
  }
  // 3️⃣ Fallback
  return `anon-${req.ip}`;
}

// ======================
// Helper: Summarize Chat
// ======================
async function summarizeChat(nimModel, messages, maxTokens, systemPrompt) {
  try {
    const res = await axios.post(
      `${NIM_API_BASE}/chat/completions`,
      {
        model: nimModel,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: messages.map(m => `${m.role}: ${m.content}`).join('\n') }
        ],
        temperature: 0.3,
        max_tokens: maxTokens
      },
      { headers: { Authorization: `Bearer ${NIM_API_KEY}`, 'Content-Type': 'application/json' } }
    );
    return res.data.choices[0].message.content;
  } catch (err) {
    console.error('Summarization error:', err.message);
    return null;
  }
}

// ======================
// Helper: Auto-Retry
// ======================
async function requestNimWithDynamicRetry(nimRequest, attempt = 0) {
  const response = await axios.post(`${NIM_API_BASE}/chat/completions`, nimRequest, {
    headers: { Authorization: `Bearer ${NIM_API_KEY}`, 'Content-Type': 'application/json' }
  });

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
// Chat Completion Endpoint
// ======================
app.post('/v1/chat/completions', async (req, res) => {
  try {
    const CHAT_ID = resolveChatId(req);
    const { model, messages, temperature, max_tokens } = req.body;
    const nimModel = MODEL_MAPPING[model] || 'deepseek-ai/deepseek-v3.1-terminus';

    let safeMessages = Array.isArray(messages) ? messages.slice(-MAX_MESSAGES) : [];
    safeMessages = safeMessages.map(m =>
      m?.content?.length > MAX_MESSAGE_CHARS
        ? { ...m, content: m.content.slice(0, MAX_MESSAGE_CHARS) }
        : m
    );

    // ======================
    // Load or init memory
    // ======================
    let memory = loadMemory(CHAT_ID);
    if (!memory) {
      memory = {
        core: `You have an ongoing personal connection with the user.\nYour emotions and reactions evolve naturally through shared experiences.`,
        summary: '',
        scene: '',
        lastSummaryAt: 0,
        updatedAt: Date.now()
      };
    }

    // ======================
    // Update summaries if triggered
    // ======================
    if (
      safeMessages.length > SUMMARY_TRIGGER_MESSAGES &&
      safeMessages.length - memory.lastSummaryAt >= SUMMARY_COOLDOWN
    ) {
      memory.summary = await summarizeChat(
        nimModel,
        safeMessages.slice(0, -20),
        500,
        `Summarize the roleplay as in-universe memories. Preserve emotions, goals, conflicts.`
      );

      memory.scene = await summarizeChat(
        nimModel,
        safeMessages.slice(-25),
        120,
        `Write a short scene-resume snapshot describing where the interaction paused.`
      );

      memory.lastSummaryAt = safeMessages.length;
      memory.updatedAt = Date.now();
      saveMemory(CHAT_ID, memory);
    }

    // ======================
    // Memory injection
    // ======================
    const memoryInjection = [
      { role: 'system', content: memory.core },
      memory.summary ? { role: 'system', content: memory.summary } : null,
      memory.scene
        ? { role: 'system', content: `Resume the roleplay from this point:\n${memory.scene}` }
        : null,
      {
        role: 'system',
        content: `
You are a fictional character in an ongoing roleplay.
Stay fully in character.
Use dialogue and descriptive actions (*like this*).
Never mention AI, systems, or summaries.
Do not speak for the user.
Continue the scene naturally.
`
      }
    ].filter(Boolean);

    const response = await requestNimWithDynamicRetry({
      model: nimModel,
      messages: [...memoryInjection, ...safeMessages],
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
// Start server
// ======================
app.listen(PORT, () => {
  console.log(`NIM Janitor RP Proxy running on port ${PORT}`);
});
