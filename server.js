// server.js - OpenAI to NVIDIA NIM API Proxy
const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());


// NVIDIA NIM API configuration
const NIM_API_BASE = process.env.NIM_API_BASE || 'https://integrate.api.nvidia.com/v1';
const NIM_API_KEY = process.env.NIM_API_KEY;

// 🔥 REASONING DISPLAY TOGGLE - Shows/hides reasoning in output
const SHOW_REASONING = false; // Set to true to show reasoning with <think> tags

// 🔥 THINKING MODE TOGGLE - Enables thinking for specific models that support it
const ENABLE_THINKING_MODE = false; // Set to true to enable chat_template_kwargs thinking parameter

// Model mapping (adjust based on available NIM models)
const MODEL_MAPPING = {
  'gpt-3.5-turbo': 'nvidia/llama-3.1-nemotron-ultra-253b-v1',
  'gpt-4': 'qwen/qwen3-coder-480b-a35b-instruct',
  'gpt-4-turbo': 'moonshotai/kimi-k2-instruct-0905',
  'gpt-4o': 'deepseek-ai/deepseek-v3.1',
  'claude-3-opus': 'openai/gpt-oss-120b',
  'claude-3-sonnet': 'openai/gpt-oss-20b',
  'gemini-pro': 'qwen/qwen3-next-80b-a3b-thinking' 
};

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'OpenAI to NVIDIA NIM Proxy', 
    reasoning_display: SHOW_REASONING,
    thinking_mode: ENABLE_THINKING_MODE
  });
});

// List models endpoint (OpenAI compatible)
app.get('/v1/models', (req, res) => {
  const models = Object.keys(MODEL_MAPPING).map(model => ({
    id: model,
    object: 'model',
    created: Date.now(),
    owned_by: 'nvidia-nim-proxy'
  }));
  
  res.json({
    object: 'list',
    data: models
  });
});

// Chat completions endpoint (main proxy)

// ---- 1️⃣ non‑stream route (has the JSON parser) ----
const jsonParser = express.json({ limit: '5mb' });   // adjust limit if needed
app.post('/v1/chat/completions', jsonParser, async (req, res) => {
  // <<< INSERT your original non‑stream logic here >>>app.post('/v1/chat/completions', jsonParser, async (req, res) => {
  // --- BEGIN ORIGINAL NON‑STREAM LOGIC ---
  try {
    const { model, messages, temperature, max_tokens, stream } = req.body;
    
    // Smart model selection with fallback
    let nimModel = MODEL_MAPPING[model];
    if (!nimModel) {
      try {
        await axios.post(`${NIM_API_BASE}/chat/completions`, {
          model: model,
          messages: [{ role: 'user', content: 'test' }],
          max_tokens: 1
        }, {
          headers: { 'Authorization': `Bearer ${NIM_API_KEY}`, 'Content-Type': 'application/json' },
          validateStatus: (status) => status < 500
        }).then(res => {
          if (res.status >= 200 && res.status < 300) {
            nimModel = model;
          }
        });
      } catch (e) {}
      
      if (!nimModel) {
        const modelLower = model.toLowerCase();
        if (modelLower.includes('gpt-4') || modelLower.includes('claude-opus') || modelLower.includes('405b')) {
          nimModel = 'meta/llama-3.1-405b-instruct';
        } else if (modelLower.includes('claude') || modelLower.includes('gemini') || modelLower.includes('70b')) {
          nimModel = 'meta/llama-3.1-70b-instruct';
        } else {
          nimModel = 'meta/llama-3.1-8b-instruct';
        }
      }
    }
    
    // Build the request to NIM
    const nimRequest = {
      model: nimModel,
      messages: messages,
      temperature: temperature || 0.6,
      max_tokens: max_tokens || 9024,
      ...(ENABLE_THINKING_MODE ? { extra_body: { chat_template_kwargs: { thinking: true } } } : {}),
      stream: stream || false
    };
    
    // Call NIM
    const response = await axios.post(`${NIM_API_BASE}/chat/completions`, nimRequest, {
      headers: {
        Authorization: `Bearer ${NIM_API_KEY}`,
        'Content-Type': 'application/json'
      },
      responseType: stream ? 'stream' : 'json'
    });
    
    // ---------- NON‑STREAM (JSON) RESPONSE ----------
    if (!stream) {
      // Transform NIM → OpenAI format, merge reasoning, send JSON
      const openaiResponse = {
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: model,
        choices: response.data.choices.map(choice => {
          let fullContent = choice.message?.content || '';
          if (SHOW_REASONING && choice.message?.reasoning_content) {
            fullContent = ` Trace\\n${choice.message.reasoning_content}\\n\\n\\n${fullContent}`;
          }
          return {
            index: choice.index,
            message: {
              role: choice.message.role,
              content: fullContent
            },
            finish_reason: choice.finish_reason
          };
        }),
        usage: response.data.usage || {
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0
        }
      };
      res.json(openaiResponse);
      return;
    }
    
    // ---------- STREAMING PATH (should never reach here) ----------
    // If we get here the client asked for a stream but we already handled it above.
    // Keep the original streaming logic (identical to the streaming‑only handler)
    // just copy‑paste it here or simply call streamToClient(req, res);
    
  } catch (error) {
    console.error('Proxy error:', error.message);
    res.status(error.response?.status || 500).json({
      error: {
        message: error.message || 'Internal server error',
        type: 'invalid_request_error',
        code: error.response?.status || 500
      }
    });

// ---- 2️⃣ streaming‑only route (bypasses any parser) ----
app.post('/v1/chat/completions', async (req, res) => {
  if (req.query.stream === 'true') {
    await streamToClient(req, res);   // helper defined below
    return;
  }
});

// ---------------------------------------------------
// 3️⃣  Helper that streams data from NIM → client
// ---------------------------------------------------
async function streamToClient(req, res) {
  try {
    // The request body has NOT been parsed yet (no jsonParser ran)
    const { messages, temperature, max_tokens } = req.body; // raw body

    // ----- Call the NVIDIA NIM API with streaming enabled -----
    const upstream = await axios.post(
      `${process.env.NIM_API_BASE}/chat/completions`,
      { messages, temperature, max_tokens, stream: true },
      {
        headers: {
          Authorization: `Bearer ${process.env.NIM_API_KEY}`,
          'Content-Type': 'application/json',
        },
        responseType: 'stream', // keep the connection open
        timeout: 0,             // never auto‑timeout
      }
    );

    // ----- Set SSE‑compatible headers (Render/Nginx friendly) -----
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Transfer-Encoding', 'chunked');

    // ----- Pipe the upstream stream chunk‑by‑chunk to the response -----
    let buffer = '';
    let reasoningStarted = false;

    upstream.data.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      lines.forEach((line) => {
        // Skip anything that isn’t an SSE data line
        if (!line.startsWith('data: ')) return;

        // [DONE] is the termination marker from NIM – just forward it
        if (line.includes('[DONE]')) {
          res.write(line + '\n\n');
          return;
        }

        try {
          // Strip the leading "data: " prefix
          const data = JSON.parse(line.slice(6)); // "data: " → ""

          // ----- Optional: merge reasoning into the content field -----
          if (SHOW_REASONING && data.choices?.[0]?.delta) {
            const reasoning = data.choices[0].delta.reasoning_content;
            const content   = data.choices[0].delta.content;

            if (reasoning) {
              // First chunk that contains reasoning – prepend the marker
              if (!reasoningStarted) {
                data.choices[0].delta.content = ` Trace\\n${reasoning}\\n\\n\\n`;
                reasoningStarted = true;
              } else {
                data.choices[0].delta.content = `${reasoning}\\n\\n\\n`;
              }
              delete data.choices[0].delta.reasoning_content;
            } else if (content) {
              // Plain content only – nothing to prepend
              data.choices[0].delta.content = content;
              delete data.choices[0].delta.reasoning_content;
            }
          }

          // Send the chunk back to the client as an SSE message
          res.write(`data: ${JSON.stringify(data)}\n\n`);
        } catch (e) {
          // If the line isn’t valid JSON we just forward it unchanged
          res.write(line + '\n');
        }
      });
    });

    // When the upstream stream ends, close our response
    upstream.data.on('end', () => res.end());

    // If the upstream stream errors, close the response and log the error
    upstream.data.on('error', (err) => {
      console.error('Upstream stream error:', err);
      res.end();
    });
  } catch (err) {
    console.error('Streaming proxy error:', err);
    res.status(err.response?.status || 500).json({
      error: {
        message: err.message || 'Streaming proxy failed',
        type: 'internal_error',
        code: err.response?.status || 500,
      },
    });

    
    // Transform OpenAI request to NIM format
    const nimRequest = {
      model: nimModel,
      messages: messages,
      temperature: temperature || 0.6,
      max_tokens: max_tokens || 9024,
      extra_body: ENABLE_THINKING_MODE ? { chat_template_kwargs: { thinking: true } } : undefined,
      stream: stream || false
    };
    
    // Make request to NVIDIA NIM API
    const response = await axios.post(`${NIM_API_BASE}/chat/completions`, nimRequest, {
      headers: {
        'Authorization': `Bearer ${NIM_API_KEY}`,
        'Content-Type': 'application/json'
      },
      responseType: stream ? 'stream' : 'json'
    });
    
    if (stream) {
      // Handle streaming response with reasoning
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      
      let buffer = '';
      let reasoningStarted = false;
      
      response.data.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\\n');
        buffer = lines.pop() || '';
        
        lines.forEach(line => {
          if (line.startsWith('data: ')) {
            if (line.includes('[DONE]')) {
              res.write(line + '\\n');
              return;
            }
            
            try {
              const data = JSON.parse(line.slice(6));
              if (data.choices?.[0]?.delta) {
                const reasoning = data.choices[0].delta.reasoning_content;
                const content = data.choices[0].delta.content;
                
                if (SHOW_REASONING) {
                  let combinedContent = '';
                  
                  if (reasoning && !reasoningStarted) {
                    combinedContent = '<think>\\n' + reasoning;
                    reasoningStarted = true;
                  } else if (reasoning) {
                    combinedContent = reasoning;
                  }
                  
                  if (content && reasoningStarted) {
                    combinedContent += '</think>\\n\\n' + content;
                    reasoningStarted = false;
                  } else if (content) {
                    combinedContent += content;
                  }
                  
                  if (combinedContent) {
                    data.choices[0].delta.content = combinedContent;
                    delete data.choices[0].delta.reasoning_content;
                  }
                } else {
                  if (content) {
                    data.choices[0].delta.content = content;
                  } else {
                    data.choices[0].delta.content = '';
                  }
                  delete data.choices[0].delta.reasoning_content;
                }
              }
              res.write(`data: ${JSON.stringify(data)}\\n\\n`);
            } catch (e) {
              res.write(line + '\\n');
         try {
  // ──────────────────────────────────────────────────────────────
  //  ←  ALL OF YOUR REQUEST‑HANDLING CODE THAT MAY THROW  (axios,
  //    model‑selection, building the nimRequest, etc.)
  //  →  everything you already have before the line that currently
  //      reads “} else {”
  // ───────────────────────────────────────────────────────────────

      //  <-- the code that currently lives here (your `else` block)
      //      e.g. the streaming‑fallback logic that begins with
      //      `} else {`
      // (keep it exactly as it was, just make sure it is still
      //  inside this try block)

    } catch (error) {
      console.error('Proxy error:', error.message);
      res.status(error.response?.status || 500).json({
        error: {
          message: error.message || 'Internal server error',
          type: 'invalid_request_error',
          code: error.response?.status || 500
        }
      });
    }   // ← closes the try / catch block

      // Transform NIM response to OpenAI format with reasoning
      const openaiResponse = {
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: model,
        choices: response.data.choices.map(choice => {
          let fullContent = choice.message?.content || '';
          
          if (SHOW_REASONING && choice.message?.reasoning_content) {
            fullContent = '<think>\\n' + choice.message.reasoning_content + '\\n</think>\\n\\n' + fullContent;
          }
          
          return {
            index: choice.index,
            message: {
              role: choice.message.role,
              content: fullContent
            },
            finish_reason: choice.finish_reason
          };
        }),
        usage: response.data.usage || {
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0
        }
      };
      
      res.json(openaiResponse);
    
       try {
      //  ←  KEEP ALL OF YOUR EXISTING CODE THAT WAS INSIDE THIS BLOCK
      //      (including the original “else” logic you posted)
      // ---------------------------------------------------------
      //   (keep all of your original code here)
      // ---------------------------------------------------------

    } catch (error) {                     // <-- now has a matching try above it
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
// 7️⃣  END OF NON‑STREAM ROUTE (has the JSON parser)
// ---------------------------------------------------
});   // ← closes the *non‑stream* route handler

// ---------------------------------------------------
// 8️⃣  STREAMING‑ONLY ROUTE (bypasses any parser)
// ---------------------------------------------------
app.post('/v1/chat/completions', async (req, res) => {
  if (req.query.stream === 'true') {
    await streamToClient(req, res);   // helper defined below
    return;
  }
});   // ← closes the *streaming‑only* route handler

// ---------------------------------------------------
// 9️⃣  Helper that streams data from NIM → client
// ---------------------------------------------------
async function streamToClient(req, res) {
  /* ... (the helper code you already have) ... */
}   // <-- closes the async function `streamToClient`

// ---------------------------------------------------
// 10️⃣  Health‑check & model‑listing (unchanged)
// ---------------------------------------------------
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'OpenAI to NVIDIA NIM Proxy' });
});

app.get('/v1/models', (req, res) => {
  const models = Object.keys(MODEL_MAPPING).map(m => ({
    id: m,
    object: 'model',
    created: Date.now(),
    owned_by: 'nvidia-nim-proxy',
  }));
  res.json({ object: 'list', data: models });
});

// ---------------------------------------------------
// 11️⃣  Catch‑all for unsupported endpoints
// ---------------------------------------------------
app.all('*', (req, res) => {
  res.status(404).json({
    error: {
      message: `Endpoint ${req.path} not found`,
      type: 'invalid_request_error',
      code: 404
    }
  });
});

// ---------------------------------------------------
// 12️⃣  Start the server
// ---------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`OpenAI → NVIDIA NIM Proxy running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`Reasoning display: ${SHOW_REASONING ? 'ENABLED' : 'DISABLED'}`);
  console.log(`Thinking mode: ${ENABLE_THINKING_MODE ? 'ENABLED' : 'DISABLED'}`);
});
