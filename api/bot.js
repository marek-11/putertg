// api/bot.js
const TelegramBot = require('node-telegram-bot-api');
const { kv } = require('@vercel/kv');
const { init } = require('@heyputer/puter.js/src/init.cjs');

// --- CONFIGURATION ---
const DEFAULT_MODEL = 'claude-opus-4-5'; // Main "Thinking" Brain
const ROUTER_MODEL = 'gpt-4o';           // Fast "Decision" Brain

// --- HELPER 1: GET ALL TOKENS (ENV + DB) ---
async function getAllTokens() {
    const rawStatic = process.env.PUTER_AUTH_TOKEN || "";
    const staticTokens = rawStatic.split(',').map(t => t.trim()).filter(t => t.length > 0);

    let dynamicTokens = [];
    try {
        dynamicTokens = await kv.get('extra_tokens') || [];
        if (!Array.isArray(dynamicTokens)) dynamicTokens = [];
    } catch (e) {
        console.warn("KV Token fetch failed:", e);
    }

    const combined = [...new Set([...staticTokens, ...dynamicTokens])];
    if (combined.length === 0) throw new Error("No PUTER_AUTH_TOKEN found in Env or DB.");
    return combined;
}

// --- HELPER 2: AI CALL WRAPPER ---
async function callAIWithRotation(messages, modelId = DEFAULT_MODEL) {
    let tokens = await getAllTokens();
    
    // Shuffle tokens for load balancing
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
            if (typeof result === 'string') {
                text = result;
            } else if (result?.message?.content) {
                const content = result.message.content;
                if (typeof content === 'string') text = content;
                else if (Array.isArray(content)) {
                    text = content.filter(b => b.type === 'text' || b.text).map(b => b.text || '').join('');
                }
            } else if (Array.isArray(result)) {
                 text = result.map(b => b.text || '').join('');
            } else {
                text = JSON.stringify(result);
            }
            text = text.trim();

            if (text.length < 150) {
                const lower = text.toLowerCase();
                const failPhrases = ["usage limit", "quota", "insufficient credit", "out of credits", "rate limit"];
                if (failPhrases.some(p => lower.includes(p))) {
                    throw new Error(`Quota exceeded: ${text}`);
                }
            }
            return text;
        } catch (err) {
            console.warn(`Token ...${token.slice(-4)} failed on ${modelId}: ${err.message}`);
            lastError = err;
        }
    }
    throw new Error(`All tokens failed. Last error: ${lastError?.message}`);
}

// --- HELPER 3: INTENT ANALYZER (THE "ROUTER") ---
async function analyzeUserIntent(history, userMessage) {
    const now = new Date().toLocaleDateString("en-US", { 
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' 
    });

    const contextSlice = history.slice(-3);

    const systemPrompt = `
    You are the "Router" for an advanced AI assistant.
    Current Date: ${now}

    YOUR GOAL:
    Determine if the user's latest message requires real-time information (Search) or if it can be answered by internal knowledge.

    RULES:
    1. SEARCH if: News, weather, sports, stocks, "current" events, or facts that change over time.
    2. DIRECT if: Coding, history, definitions, creative writing, greetings.
    3. CONTEXT AWARENESS: If the user asks "How old is he?", replace "he" with the name from previous messages in the 'query'.

    OUTPUT:
    Return a single JSON object (no markdown).
    format: { "action": "SEARCH" | "DIRECT", "query": "The search query (only if SEARCH)" }
    `;

    const messages = [
        { role: "system", content: systemPrompt },
        ...contextSlice,
        { role: "user", content: userMessage }
    ];

    try {
        const response = await callAIWithRotation(messages, ROUTER_MODEL);
        const jsonStr = response.replace(/```json/g, '').replace(/```/g, '').trim();
        return JSON.parse(jsonStr);
    } catch (e) {
        console.warn("Intent analysis failed, defaulting to DIRECT. Error:", e);
        return { action: "DIRECT" };
    }
}

// --- HELPER 4: EXA.AI RESEARCHER ---
async function performExaResearch(userQuery) {
    const apiKeyRaw = process.env.EXA_API_KEY; 
    if (!apiKeyRaw) return null;

    const keys = apiKeyRaw.split(',').map(k => k.trim()).filter(Boolean);
    const apiKey = keys[Math.floor(Math.random() * keys.length)];

    try {
        const response = await fetch("https://api.exa.ai/search", {
            method: "POST",
            headers: { 
                "Content-Type": "application/json",
                "x-api-key": apiKey 
            },
            body: JSON.stringify({ 
                query: userQuery,
                useAutoprompt: true, 
                numResults: 3,       
                contents: { text: true } 
            })
        });
        
        if (!response.ok) return null;

        const data = await response.json();
        if (!data.results || data.results.length === 0) return null;

        let context = `Exa Search Summary:\n\n`;
        data.results.forEach((r, i) => {
            const snippet = r.text ? r.text.slice(0, 1000).replace(/\s+/g, " ") : "No text content.";
            context += `[${i+1}] Title: ${r.title || "Unknown"}\nURL: ${r.url}\nContent: ${snippet}...\n\n`;
        });
        
        return context;
    } catch (e) {
        console.error("Exa Exception:", e);
        return null;
    }
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

            // Whitelist check
            const allowed = (process.env.WHITELIST || "").split(',').map(i => i.trim());
            if (allowed.length > 0 && !allowed.includes(chatId.toString())) {
                return res.status(200).json({});
            }

            // --- COMMANDS ---
            if (userMessage.startsWith('ey') && !userMessage.includes(' ') && userMessage.length > 50) {
                try {
                    const currentExtras = await kv.get('extra_tokens') || [];
                    if (!currentExtras.includes(userMessage)) {
                        currentExtras.push(userMessage);
                        await kv.set('extra_tokens', currentExtras);
                        await bot.sendMessage(chatId, `✅ Token Added!`);
                    }
                } catch(e) {}
                return res.status(200).json({});
            }
            if (userMessage === '/start') { await bot.sendMessage(chatId, "Ready."); return res.status(200).json({}); }
            if (userMessage === '/clear') { await kv.set(dbKey, []); await bot.sendMessage(chatId, "✅ Memory cleared."); return res.status(200).json({}); }
            
            if (userMessage.startsWith('/use')) {
                const newModel = userMessage.replace('/use', '').trim();
                if (!newModel) {
                    await bot.sendMessage(chatId, "⚠️ Specify model.");
                } else {
                    await kv.set(modelKey, newModel);
                    await bot.sendMessage(chatId, `✅ Switched to: \`${newModel}\``, {parse_mode: 'Markdown'});
                }
                return res.status(200).json({});
            }

            // --- CHAT FLOW ---
            await bot.sendChatAction(chatId, 'typing');

            try {
                let history = await kv.get(dbKey) || [];
                
                // 1. ANALYZE INTENT
                const intent = await analyzeUserIntent(history, userMessage);
                
                // Push user message to history AFTER intent analysis
                history.push({ role: 'user', content: userMessage });
                
                const userModelPref = await kv.get(modelKey);
                const activeModel = userModelPref || DEFAULT_MODEL;
                
                let finalResponse = "";
                let hiddenSearchData = "";

                // 2. EXECUTE BASED ON INTENT
                if (intent.action === 'SEARCH') {
                    await bot.sendChatAction(chatId, 'typing');
                    
                    const searchResults = await performExaResearch(intent.query);
                    
                    if (searchResults) {
                        hiddenSearchData = `\n\n:::SEARCH_CONTEXT:::\nQuery: ${intent.query}\n${searchResults}\n:::END_SEARCH_CONTEXT:::`;
                    }

                    const contextMsg = {
                        role: "system",
                        content: `[SYSTEM DATA]\nSearch Query: "${intent.query}"\nResults:\n${searchResults || "No results found."}\n\nInstruction: Answer the user's question directly using these results. Answer confidently. STRICTLY NO MARKDOWN TABLES.`
                    };

                    const answerMessages = [
                        { role: "system", content: process.env.SYSTEM_PROMPT || "You are a helpful assistant." },
                        ...history.slice(0, -1), 
                        contextMsg,              
                        { role: "user", content: userMessage }
                    ];

                    finalResponse = await callAIWithRotation(answerMessages, activeModel);

                } else {
                    // DIRECT ANSWER
                    const systemPrompt = (process.env.SYSTEM_PROMPT || "You are a helpful assistant.") + 
                                         "\n\nSTRICT OUTPUT RULE: Do NOT use Markdown tables. Use bullet points or plain text formats only.";

                    const answerMessages = [
                        { role: "system", content: systemPrompt },
                        ...history
                    ];
                    
                    finalResponse = await callAIWithRotation(answerMessages, activeModel);
                }

                // 3. FORMATTING AND SAVING
                let cleanReply = finalResponse
                    .replace(/^#{1,6}\s+(.*?)$/gm, '*$1*') 
                    .replace(/\*\*(.*?)\*\*/g, '*$1*')    
                    .replace(/__(.*?)__/g, '*$1*')
                    .trim();

                const dbContent = cleanReply + hiddenSearchData;
                history.push({ role: 'assistant', content: dbContent });
                
                if (history.length > 20) history = history.slice(-20);
                await kv.set(dbKey, history);

                const MAX_CHUNK = 4000;
                for (let i = 0; i < cleanReply.length; i += MAX_CHUNK) {
                    await bot.sendMessage(chatId, cleanReply.substring(i, i + MAX_CHUNK), { parse_mode: 'Markdown' });
                }

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
