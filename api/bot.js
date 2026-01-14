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

// --- HELPER 2: CLAUDE CALL WRAPPER (Handles Rotation & Error Detection) ---
async function callClaudeWithRotation(messages) {
    // 1. Get & Shuffle Tokens
    let tokens = await fetchPuterTokens();
    for (let i = tokens.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [tokens[i], tokens[j]] = [tokens[j], tokens[i]];
    }

    let lastError = null;

    // 2. Retry Loop
    for (const token of tokens) {
        try {
            const puter = init(token);
            const result = await puter.ai.chat(messages, { model: 'claude-opus-4-5' });

            if (!result) throw new Error("Empty response");
            if (result.error) throw new Error(JSON.stringify(result));

            // Extract Text
            let text = typeof result === 'string' ? result : result?.message?.content || "";
            if (typeof text !== 'string') text = JSON.stringify(text);

            // Aggressive Error Detection
            if (text.length < 150) {
                const lower = text.toLowerCase();
                const failPhrases = ["usage limit", "quota", "insufficient credit", "out of credits", "rate limit"];
                if (failPhrases.some(p => lower.includes(p))) {
                    throw new Error(`Quota exceeded: ${text}`);
                }
            }

            return text; // Success!

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

    // Simple Key Rotation for Tavily
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

            // 1. Whitelist & Commands
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
                // 2. Load History
                let history = await kv.get(dbKey) || [];
                history.push({ role: 'user', content: userMessage });

                // ====================================================
                // STEP 1: DECISION PHASE (The Agent)
                // ====================================================
                // We ask Claude: "Do you need to search?"
                const decisionMessages = [
                    { 
                        role: "system", 
                        content: `You are a helpful assistant with access to a Google Search tool. 
                        If the user asks a question that requires real-time information (news, weather, stock prices, current events, "who is", "what is"), 
                        reply ONLY with the format: SEARCH: <query>
                        
                        Examples:
                        User: "Price of BTC" -> You: SEARCH: current price of bitcoin
                        User: "Who won the superbowl?" -> You: SEARCH: super bowl winner 2024
                        User: "Hi there" -> You: Hi! How can I help?
                        User: "Write a poem" -> You: (Writes poem)
                        
                        Do not explain yourself. Just output the SEARCH command or the normal response.` 
                    },
                    ...history.slice(-4) // Only look at recent context for decision to save tokens
                ];

                // Call Claude (using our robust rotation helper)
                let initialResponse = await callClaudeWithRotation(decisionMessages);
                let finalResponse = initialResponse;

                // ====================================================
                // STEP 2: ACTION PHASE (If Search is needed)
                // ====================================================
                if (initialResponse.trim().startsWith("SEARCH:")) {
                    const searchQuery = initialResponse.replace("SEARCH:", "").trim();
                    await bot.sendChatAction(chatId, 'typing'); // Keep typing...

                    // Perform Search
                    const searchResults = await performTavilyResearch(searchQuery);

                    if (searchResults) {
                        // Create the final prompt with the injected knowledge
                        const searchContextMsg = {
                            role: "system",
                            content: `[SYSTEM TOOL OUTPUT]\nUser requested search for: "${searchQuery}"\n\nSearch Results:\n${searchResults}\n\nInstruction: Answer the user's original question using these results.`
                        };

                        // We create a new history array for the final answer generation
                        const finalMessages = [
                            { role: "system", content: process.env.SYSTEM_PROMPT || "You are a helpful assistant." },
                            ...history.slice(0, -1), // Previous history
                            searchContextMsg,        // Inject search results BEFORE the last user msg (or as system context)
                            { role: "user", content: userMessage }
                        ];

                        // Call Claude again for the final answer
                        finalResponse = await callClaudeWithRotation(finalMessages);
                    }
                } else {
                    // If no search was needed, we just use the initial response (e.g., "Hi!", "Here is a poem...")
                    // However, if the initial response was just "Hi", we might want to ensure we didn't miss the system prompt flavor.
                    // But usually, Opus is smart enough to just answer directly if no search is needed.
                }

                // ====================================================
                // STEP 3: REPLY & SAVE
                // ====================================================
                
                // Clean markdown
                let cleanReply = finalResponse
                    .replace(/\*\*(.*?)\*\*/g, '$1')
                    .replace(/__(.*?)__/g, '$1')
                    .replace(/^\s*[-_*]{3,}\s*$/gm, '') // Remove horizontal rules
                    .trim();

                history.push({ role: 'assistant', content: cleanReply });
                if (history.length > 20) history = history.slice(-20);
                await kv.set(dbKey, history);

                const MAX_CHUNK = 4000;
                for (let i = 0; i < cleanReply.length; i += MAX_CHUNK) {
                    await bot.sendMessage(chatId, cleanReply.substring(i, i + MAX_CHUNK));
                }

            } catch (error) {
                console.error("Bot Error:", error);
                await bot.sendMessage(chatId, `⚠️ Error: ${error.message}`);
            }
        }
        res.status(200).json({ status: 'ok' });
    } else {
        res.status(200).json({ status: 'ready' });
    }
}
