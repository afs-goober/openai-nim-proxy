// server.js — JanitorAI → NVIDIA NIM RP Proxy
// Persistent multi-layer memory with resumable chats

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
// LIMITS
// ======================
const MAX_MESSAGES = 35;
const MAX_MESSAGE_CHARS = 8000;
const SUMMARY_TRIGGER_MESSAGES = 60;
const SUMMARY_COOLDOWN = 40;

// ======================
// MEMORY STORAGE
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
// MODEL MAP
// ======================
const MODEL_MAPPING = {
  'gpt-4': 'deepseek-ai/deepseek-v3.1-terminus',
  'gpt-4o': 'deepseek-ai/deepseek-v3.1',
};

// ======================
// SUMMARIZATION HELPERS
// ======================
async function runSummary(model, systemPrompt, messages, maxTokens) {
  const res = await axios.post(
    `${NIM_API_BASE}/chat/completions`,
    {
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: messages.map(m => `${m.role}: ${m.content}`).join('\n') }
      ],
      temperature: 0.3,
      max_tokens: maxTokens
    },
    {
      headers: {
        Authorization: `Bearer ${NIM_API_KEY}`,
        'Content-Type': 'application/json'
      }
    }
  );
  return res.data.choices[0].message.content;
}

// ======================
// CHAT COMPLETIONS
// ======================
app.post('/v1/chat/completions', async (req, res) => {
  try {
    const CHAT_ID = req.headers['x-chat-id'];
    if (!CHAT_ID) {
      return res.status(400).json({ error: 'Missing x-chat-id header' });
    }

    const { model, messages } = req.body;
    const nimModel = MODEL_MAPPING[model] || MODEL_MAPPING['gpt-4'];

    let safeMessages = messages.slice(-MAX_MESSAGES).map(m =>
      m.content.length > MAX_MESSAGE_CHARS
        ? { ...m, content: m.content.slice(0, MAX_MESSAGE_CHARS) }
        : m
    );

    // ======================
    // LOAD OR INIT MEMORY
    // ======================
    let memory = loadMemory(CHAT_ID);
    if (!memory) {
      memory = {
        core: `
You have an ongoing personal connection with the user.
Your emotions evolve naturally through shared experiences.
`,
        summary: '',
        scene: '',
        lastSummaryAt: 0,
        updatedAt: Date.now()
      };
    }

    // ======================
    // UPDATE SUMMARIES
    // ======================
    if (
      safeMessages.length > SUMMARY_TRIGGER_MESSAGES &&
      safeMessages.length - memory.lastSummaryAt >= SUMMARY_COOLDOWN
    ) {
      memory.summary = await runSummary(
        nimModel,
        `Summarize the roleplay as in-universe memories. Preserve emotions, goals, conflicts.`,
        safeMessages.slice(0, -20),
        500
      );

      memory.scene = await runSummary(
        nimModel,
        `Write a short scene-resume snapshot describing where the interaction paused.`,
        safeMessages.slice(-25),
        120
      );

      memory.lastSummaryAt = safeMessages.length;
      memory.updatedAt = Date.now();
      saveMemory(CHAT_ID, memory);
    }

    // ======================
    // MEMORY INJECTION
    // ======================
    const injected = [
      { role: 'system', content: memory.core },
      memory.summary ? { role: 'system', content: memory.summary } : null,
      memory.scene
        ? {
            role: 'system',
            content: `Resume the roleplay from this point:\n${memory.scene}`
          }
        : null,
      {
        role: 'system',
        content: `
You are a fictional character in an ongoing roleplay.
Stay fully in character.
Use dialogue and actions (*like this*).
Never mention AI, systems, or summaries.
Do not speak for the user.
Continue the scene naturally.
`
      }
    ].filter(Boolean);

    const response = await axios.post(
      `${NIM_API_BASE}/chat/completions`,
      {
        model: nimModel,
        messages: [...injected, ...safeMessages],
        temperature: 0.85,
        max_tokens: 2048
      },
      {
        headers: {
          Authorization: `Bearer ${NIM_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    res.json(response.data);

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ======================
app.listen(PORT, () => {
  console.log(`RP Proxy running on port ${PORT}`);
});

