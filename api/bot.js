// api/bot.js
const TelegramBot = require('node-telegram-bot-api');
const { kv } = require('@vercel/kv');
const { init } = require('@heyputer/puter.js/src/init.cjs');

// --- CONFIGURATION ---
const DEFAULT_MODEL = 'claude-opus-4-5'; // Main "Thinking" Brain
const ROUTER_MODEL = 'gpt-4o';           // Fast "Decision" Brain (Use gpt-4o or claude-3-5-sonnet)

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

// --- HELPER 3: INTENT ANALYZER (THE "HANDLER MODEL") ---
// This function decides if we need to search and optimizes the query
async function analyzeUserIntent(history, userMessage) {
    const now = new Date().toLocaleDateString("en-US", { 
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' 
    });

    // We pass the last few messages so the Router can resolve context (e.g. "Who is he?")
    const contextSlice = history.slice(-3);

    const systemPrompt = `
    You are the "Router" for an advanced AI assistant.
    Current Date: ${now}

    YOUR GOAL:
    Determine if the user's latest message requires real-time information (Google Search) or if it can be answered by the LLM's internal knowledge.

    RULES:
    1. SEARCH if: News, weather, sports scores, stock prices, "current" events, or specific facts about people/places that might have changed recently.
    2. DIRECT if: Coding, history (pre-2023), general definitions, creative writing, greetings, or philosophical questions.
    3. CONTEXT AWARENESS: If the user asks "How old is he?", look at the previous messages to replace "he" with the actual name in your search query.

    OUTPUT:
    Return a single JSON object (no markdown, no backticks).
    format: { "action": "SEARCH" | "DIRECT", "query": "The search query (only if SEARCH)" }
    
    Examples:
    User: "Price of BTC" -> {"action": "SEARCH", "query": "current price of bitcoin"}
    User: "Who is CEO of Twitter?" -> {"action": "SEARCH", "query": "current CEO of Twitter X"}
    User: "Write a poem" -> {"action": "DIRECT"}
    User: "What is React?" -> {"action": "DIRECT"}
    `;

    const messages = [
        { role: "system", content: systemPrompt },
        ...contextSlice,
        { role: "user", content: userMessage }
    ];

    try {
        // We use a fast/smart model for routing logic
        const response = await callAIWithRotation(messages, ROUTER_MODEL);
        
        // Clean up response in case model adds ```json ... ```
        const jsonStr = response.replace(/```json/g, '').replace(/```/g, '').trim();
        return JSON.parse(jsonStr);
    } catch (e) {
        console.warn("Intent analysis failed, defaulting to DIRECT. Error:", e);
        return { action: "DIRECT" };
    }
}

// --- HELPER 4: TAVILY RESEARCHER ---
async function performTavilyResearch(userQuery) {
    const apiKeyRaw = process.env.TAVILY_API_KEY;
    if (!apiKeyRaw) return null;

    const keys = apiKeyRaw.split(',').map(k => k.trim()).filter(Boolean);
    const apiKey = keys[Math.floor(Math.random() * keys.length)];

    try {
        const response = await fetch("https://api.tavily.com/search", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ 
                api_key: apiKey, 
                query: userQuery, 
                search_depth: "basic", 
                include_answer: true, 
                max_results: 5 
            })
        });
        
        if (!response.ok) return null; 
        const data = await response.json();
        
        let context = `Tavily AI Summary: ${data.answer}\n\nDetails:\n`;
        if (data.results) {
            data.results.forEach((r, i) => context += `[${i+1}] ${r.title}: ${r.content}\n`);
        }
        return context;
    } catch (e) {
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
            // (Kept compact for brevity - same as your original code)
            if (userMessage.startsWith('ey') && !userMessage.includes(' ') && userMessage.length > 50) {
                // Token injection logic
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
            if (userMessage === '/use') { /* ... switch logic ... */ } 
            // Note: Add back your other commands (/tokens, /bal, etc) here as needed.

            // --- CHAT FLOW ---
            await bot.sendChatAction(chatId, 'typing');

            try {
                let history = await kv.get(dbKey) || [];
                
                // 1. ANALYZE INTENT
                // We do this BEFORE adding the new message to history to keep history clean, 
                // but we pass the current history + current message to the analyzer.
                const intent = await analyzeUserIntent(history, userMessage);
                
                // Now push user message to history
                history.push({ role: 'user', content: userMessage });
                
                const userModelPref = await kv.get(modelKey);
                const activeModel = userModelPref || DEFAULT_MODEL;
                
                let finalResponse = "";
                let hiddenSearchData = "";

                // 2. EXECUTE BASED ON INTENT
                if (intent.action === 'SEARCH') {
                    await bot.sendChatAction(chatId, 'typing'); // Send another typing action as search takes time
                    
                    const searchResults = await performTavilyResearch(intent.query);
                    
                    if (searchResults) {
                        hiddenSearchData = `\n\n:::SEARCH_CONTEXT:::\nQuery: ${intent.query}\n${searchResults}\n:::END_SEARCH_CONTEXT:::`;
                    }

                    const contextMsg = {
                        role: "system",
                        content: `[SYSTEM DATA]\nSearch Query: "${intent.query}"\nResults:\n${searchResults || "No results found."}\n\nInstruction: Answer the user's question directly using these results. Answer confidently. STRICTLY NO MARKDOWN TABLES.`
                    };

                    const answerMessages = [
                        { role: "system", content: process.env.SYSTEM_PROMPT || "You are a helpful assistant." },
                        ...history.slice(0, -1), // History without the latest user msg (to avoid dupe if we structure differently, but here standard array is fine)
                        contextMsg,              // Inject search data
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
