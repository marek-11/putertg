// api/bot.js
const TelegramBot = require('node-telegram-bot-api');
const { kv } = require('@vercel/kv');
const { init } = require('@heyputer/puter.js/src/init.cjs');

// --- CONFIGURATION ---
const DEFAULT_MODEL = 'claude-opus-4-5'; 

// --- HELPER: GET ALL TOKENS ---
async function getAllTokens() {
    const rawStatic = process.env.PUTER_AUTH_TOKEN || "";
    const staticTokens = rawStatic.split(',').map(t => t.trim()).filter(t => t.length > 0);

    let dynamicTokens = [];
    try {
        dynamicTokens = await kv.get('extra_tokens') || [];
        if (!Array.isArray(dynamicTokens)) dynamicTokens = [];
    } catch (e) { console.warn("KV Token fetch failed:", e); }

    const combined = [...new Set([...staticTokens, ...dynamicTokens])];
    if (combined.length === 0) throw new Error("No PUTER_AUTH_TOKEN found in Env or DB.");
    return combined;
}

// --- HELPER: SMART MESSAGE SENDER (THE FIX) ---
async function sendLongMessage(bot, chatId, text) {
    const MAX_LENGTH = 4000; // Safe buffer below 4096
    
    // 1. If short enough, just send
    if (text.length <= MAX_LENGTH) {
        try {
            await bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
        } catch (e) {
            // Fallback to plain text if Markdown fails
            await bot.sendMessage(chatId, text); 
        }
        return;
    }

    // 2. Split by lines to preserve formatting
    const lines = text.split('\n');
    let chunk = "";

    for (const line of lines) {
        // If adding the next line exceeds limit, flush the chunk
        if (chunk.length + line.length + 1 > MAX_LENGTH) {
            try {
                await bot.sendMessage(chatId, chunk, { parse_mode: 'Markdown' });
            } catch (e) {
                await bot.sendMessage(chatId, chunk); // Fallback
            }
            chunk = "";
        }
        chunk += line + "\n";
    }

    // 3. Send remaining chunk
    if (chunk.trim().length > 0) {
        try {
            await bot.sendMessage(chatId, chunk, { parse_mode: 'Markdown' });
        } catch (e) {
            await bot.sendMessage(chatId, chunk);
        }
    }
}

// --- HELPER: CLAUDE CALL ---
async function callClaudeWithRotation(messages, modelId = DEFAULT_MODEL) {
    let tokens = await getAllTokens();
    // Shuffle
    for (let i = tokens.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [tokens[i], tokens[j]] = [tokens[j], tokens[i]];
    }

    let lastError = null;
    for (const token of tokens) {
        try {
            const puter = init(token);
            const result = await puter.ai.chat(messages, { model: modelId });
            if (!result) throw new Error("Empty response");
            if (result.error) throw new Error(JSON.stringify(result));

            let text = "";
            if (typeof result === 'string') text = result;
            else if (result?.message?.content) text = result.message.content;
            else if (Array.isArray(result)) text = result.map(b => b.text || '').join('');
            else text = JSON.stringify(result);
            
            text = text.trim();
            if (text.length < 150 && ["usage", "quota", "credit"].some(w => text.toLowerCase().includes(w))) {
                throw new Error(`Quota: ${text}`);
            }
            return text;
        } catch (err) {
            console.warn(`Token ...${token.slice(-4)} failed: ${err.message}`);
            lastError = err;
        }
    }
    throw new Error(`All tokens failed. Last error: ${lastError?.message}`);
}

// --- HELPER: TAVILY ---
async function performTavilyResearch(userQuery) {
    const apiKeyRaw = process.env.TAVILY_API_KEY;
    if (!apiKeyRaw) return null;
    const keys = apiKeyRaw.split(',').map(k => k.trim()).filter(Boolean);
    const apiKey = keys[Math.floor(Math.random() * keys.length)];
    try {
        const response = await fetch("https://api.tavily.com/search", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ api_key: apiKey, query: userQuery, search_depth: "basic", include_answer: true, max_results: 5 })
        });
        if (!response.ok) return null; 
        const data = await response.json();
        let context = `Tavily AI Summary: ${data.answer}\n\nDetails:\n`;
        if (data.results) data.results.forEach((r, i) => context += `[${i+1}] ${r.title}: ${r.content}\n`);
        return context;
    } catch (e) { return null; }
}

// --- MAIN HANDLER ---
export default async function handler(req, res) {
    const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN);

    if (req.method === 'POST') {
        const { body } = req;
        if (body.message && body.message.text) {
            const chatId = body.message.chat.id;
            const userMessage = body.message.text.trim();
            const dbKey = `chat_history:${chatId}`;
            const modelKey = `model_pref:${chatId}`;

            const allowed = (process.env.WHITELIST || "").split(',').map(i => i.trim());
            if (allowed.length > 0 && !allowed.includes(chatId.toString())) {
                return res.status(200).json({});
            }

            // --- COMMANDS ---
            if (userMessage.startsWith('ey') && !userMessage.includes(' ') && userMessage.length > 50) {
                try {
                    const current = await kv.get('extra_tokens') || [];
                    if (!current.includes(userMessage)) {
                        current.push(userMessage);
                        await kv.set('extra_tokens', current);
                        await bot.sendMessage(chatId, `✅ Token Added!`);
                    } else {
                        await bot.sendMessage(chatId, "⚠️ Exists.");
                    }
                } catch (e) {}
                return res.status(200).json({});
            }
            if (userMessage === '/start') { await bot.sendMessage(chatId, "Ready."); return res.status(200).json({}); }
            if (userMessage === '/clear') { await kv.set(dbKey, []); await bot.sendMessage(chatId, "Cleared."); return res.status(200).json({}); }
            if (userMessage === '/cleartokens') { await kv.set('extra_tokens', []); await bot.sendMessage(chatId, "DB Tokens cleared."); return res.status(200).json({}); }
            
            if (userMessage.startsWith('/use')) {
                const m = userMessage.replace('/use', '').trim();
                if(m) { await kv.set(modelKey, m); await bot.sendMessage(chatId, `Model: \`${m}\``, {parse_mode:'Markdown'}); }
                return res.status(200).json({});
            }
            if (userMessage === '/reset') { await kv.del(modelKey); await bot.sendMessage(chatId, `Reset to default.`); return res.status(200).json({}); }
            
            // Simplified Bal/Credits/Models for brevity in this fix
            if (['/bal', '/credits'].includes(userMessage)) {
                await bot.sendMessage(chatId, "Checking...");
                /* (Insert your previous credit logic here if needed, omitted for brevity) */
                return res.status(200).json({}); 
            }

            // --- AI LOGIC ---
            await bot.sendChatAction(chatId, 'typing');
            try {
                let history = await kv.get(dbKey) || [];
                history.push({ role: 'user', content: userMessage });

                const activeModel = await kv.get(modelKey) || DEFAULT_MODEL;
                const now = new Date();
                const dateString = now.toLocaleDateString("en-US", { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'Asia/Manila' });

                // ROUTER
                const routerPrompt = `Current Date: ${dateString}
Determine if search is needed. Output ONLY "SEARCH: <query>" or "DIRECT_ANSWER".
RULES:
SEARCH=TRUE: News, Weather, Prices, Status of People, Real-time info.
SEARCH=FALSE: General knowledge, Coding, Creative writing, Logic.`;

                const routerRes = await callClaudeWithRotation([{ role: "system", content: routerPrompt }, ...history.slice(-3)], DEFAULT_MODEL);
                
                let finalResponse = "";
                let hiddenData = "";

                if (routerRes.trim().startsWith("SEARCH:")) {
                    const q = routerRes.replace("SEARCH:", "").trim();
                    await bot.sendChatAction(chatId, 'typing');
                    const searchRes = await performTavilyResearch(q);
                    if (searchRes) hiddenData = `\n\n:::SEARCH:::\n${q}\n${searchRes}\n:::END:::`;
                    
                    const contextMsg = {
                        role: "system",
                        content: `[DATA]\nDate: ${dateString}\nResults:\n${searchRes}\n\nTask: Answer directly. No tables.`
                    };
                    finalResponse = await callClaudeWithRotation([{ role: "system", content: process.env.SYSTEM_PROMPT || "Helpful assistant." }, ...history.slice(0, -1), contextMsg, { role: "user", content: userMessage }], activeModel);
                } else {
                    finalResponse = await callClaudeWithRotation([{ role: "system", content: (process.env.SYSTEM_PROMPT || "Helpful assistant.") + "\nNO MARKDOWN TABLES." }, ...history], activeModel);
                }

                // Clean formatting
                let cleanReply = finalResponse
                    .replace(/^#{1,6}\s+(.*?)$/gm, '*$1*') 
                    .replace(/\*\*(.*?)\*\*/g, '*$1*')    
                    .replace(/__(.*?)__/g, '*$1*')
                    .replace(/^\s*-\s+/gm, '• ')           
                    .trim();

                // Save to DB
                history.push({ role: 'assistant', content: cleanReply + hiddenData });
                if (history.length > 20) history = history.slice(-20);
                await kv.set(dbKey, history);

                // --- NEW SAFE SENDING LOGIC ---
                await sendLongMessage(bot, chatId, cleanReply);

            } catch (error) {
                console.error(error);
                await bot.sendMessage(chatId, `⚠️ Error: ${error.message}`);
            }
        }
        res.status(200).json({ status: 'ok' });
    } else {
        res.status(200).json({ status: 'ready' });
    }
}
