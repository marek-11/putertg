// api/bot.js
const TelegramBot = require('node-telegram-bot-api');
const { kv } = require('@vercel/kv');
const { init } = require('@heyputer/puter.js/src/init.cjs');

// --- HELPER 1: FETCH TOKENS FROM GIST ---
async function fetchPuterTokens() {
    if (!process.env.GIST_TOKEN_URL) throw new Error("Missing GIST_TOKEN_URL env var.");
    try {
        const res = await fetch(`${process.env.GIST_TOKEN_URL}?t=${Date.now()}`);
        if (!res.ok) throw new Error(`Gist fetch failed: ${res.status}`);
        const text = await res.text();
        if (text.includes("<!DOCTYPE")) throw new Error("Invalid Gist URL. Use 'Raw' URL.");
        
        const tokens = text.split(/[\n,]+/).map(t => t.trim()).filter(t => t.length > 10);
        if (tokens.length === 0) throw new Error("No valid tokens found in Gist.");
        return tokens;
    } catch (e) {
        throw new Error(`Token Load Error: ${e.message}`);
    }
}

// --- HELPER 2: CLAUDE CALL WRAPPER ---
async function callClaudeWithRotation(messages) {
    let tokens = await fetchPuterTokens();
    
    // Shuffle
    for (let i = tokens.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [tokens[i], tokens[j]] = [tokens[j], tokens[i]];
    }

    let lastError = null;

    for (const token of tokens) {
        try {
            const puter = init(token);
            const result = await puter.ai.chat(messages, { model: 'claude-opus-4-5' });

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
            console.warn(`Token ...${token.slice(-4)} failed: ${err.message}`);
            lastError = err;
        }
    }
    throw new Error(`All tokens failed. Last error: ${lastError?.message}`);
}

// --- HELPER 3: TAVILY RESEARCHER ---
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

            const allowed = (process.env.WHITELIST || "").split(',').map(i => i.trim());
            if (allowed.length > 0 && !allowed.includes(chatId.toString())) {
                return res.status(200).json({});
            }
            if (userMessage === '/start') {
                await bot.sendMessage(chatId, "Hi");
                return res.status(200).json({});
            }
            if (userMessage === '/clear') {
                await kv.set(dbKey, []);
                await bot.sendMessage(chatId, "✅ Memory cleared.");
                return res.status(200).json({});
            }

            await bot.sendChatAction(chatId, 'typing');

            try {
                let history = await kv.get(dbKey) || [];
                history.push({ role: 'user', content: userMessage });

                // 1. GET DATE
                const now = new Date();
                const dateString = now.toLocaleDateString("en-US", { 
                    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' 
                });

                // 2. ROUTER PHASE (Now sees Hidden Context from previous turns!)
                const routerPrompt = `Current Date: ${dateString}

You are a classification tool. Look at the CONVERSATION HISTORY.

1. Does the latest user message require external information?
2. Is the user asking a FOLLOW-UP, CHALLENGE, or CLARIFICATION about a previous topic?

- YES -> Output: SEARCH: <query with date>
- NO  -> Output: DIRECT_ANSWER

Examples:
User: "News on Duterte" -> SEARCH: latest news Rodrigo Duterte ${dateString}
User: "That doesn't make sense" (Context: Stranger Things) -> SEARCH: Stranger Things plot explanation logic
User: "Why?" (Context: Stocks) -> SEARCH: reasons for stock market drop ${dateString}
User: "Write a poem" -> DIRECT_ANSWER`;

                const routerMessages = [
                    { role: "system", content: routerPrompt },
                    ...history.slice(-3) 
                ];

                const routerResponse = await callClaudeWithRotation(routerMessages);
                
                let finalResponse = "";
                let hiddenSearchData = ""; // We will store search results here to hide them later

                // 3. EXECUTION PHASE
                if (routerResponse.trim().startsWith("SEARCH:")) {
                    const searchQuery = routerResponse.replace("SEARCH:", "").trim();
                    await bot.sendChatAction(chatId, 'typing'); 
                    
                    const searchResults = await performTavilyResearch(searchQuery);

                    // Store results for the DB, so next turn remembers them
                    if (searchResults) {
                        hiddenSearchData = `\n\n:::SEARCH_CONTEXT:::\nQuery: ${searchQuery}\n${searchResults}\n:::END_SEARCH_CONTEXT:::`;
                    }

                    const contextMsg = {
                        role: "system",
                        content: `[SYSTEM DATA]\nDate: ${dateString}\nSearch Query: "${searchQuery}"\nResults:\n${searchResults || "No results found."}\n\nInstruction: Answer the user's question directly using these results.\n\nCRITICAL STYLE RULE: Do NOT say "Based on the search results" or "According to...". Answer confidently and professionally as if you already knew it.`
                    };

                    const answerMessages = [
                        { role: "system", content: process.env.SYSTEM_PROMPT || "You are a helpful assistant." },
                        ...history.slice(0, -1), 
                        contextMsg,              
                        { role: "user", content: userMessage }
                    ];

                    finalResponse = await callClaudeWithRotation(answerMessages);
                } 
                else {
                    // Direct Answer
                    const answerMessages = [
                        { role: "system", content: process.env.SYSTEM_PROMPT || "You are a helpful assistant." },
                        ...history
                    ];
                    finalResponse = await callClaudeWithRotation(answerMessages);
                }

                // 4. CLEANUP & REPLY
                let cleanReply = finalResponse
                    .replace(/^#{1,6}\s+(.*?)$/gm, '*$1*') 
                    .replace(/\*\*(.*?)\*\*/g, '*$1*')    
                    .replace(/__(.*?)__/g, '*$1*')
                    .replace(/^\s*-\s+/gm, '• ')           
                    .replace(/^\s*[-_*]{3,}\s*$/gm, '')    
                    .trim();

                // 5. SAVE TO DB WITH HIDDEN CONTEXT
                // We append the hidden search data to the message in the database ONLY.
                // The user never sees it, but the AI sees it in the history next time.
                const dbContent = cleanReply + hiddenSearchData;

                history.push({ role: 'assistant', content: dbContent });
                
                // Keep history manageable (last 20 turns)
                if (history.length > 20) history = history.slice(-20);
                await kv.set(dbKey, history);

                // 6. SEND TO USER (WITHOUT HIDDEN CONTEXT)
                const MAX_CHUNK = 4000;
                for (let i = 0; i < cleanReply.length; i += MAX_CHUNK) {
                    await bot.sendMessage(chatId, cleanReply.substring(i, i + MAX_CHUNK), { parse_mode: 'Markdown' });
                }

            } catch (error) {
                try {
                    await bot.sendMessage(chatId, error.message.includes('Markdown') ? finalResponse : `⚠️ Error: ${error.message}`);
                } catch (e) { console.error(e); }
            }
        }
        res.status(200).json({ status: 'ok' });
    } else {
        res.status(200).json({ status: 'ready' });
    }
}
