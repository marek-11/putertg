// api/bot.js
const TelegramBot = require('node-telegram-bot-api');
const { kv } = require('@vercel/kv');
const { init } = require('@heyputer/puter.js/src/init.cjs');

// --- CONFIGURATION ---
const DEFAULT_MODEL = 'claude-opus-4-5'; 

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

// --- HELPER 2: CLAUDE CALL WRAPPER ---
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
            const modelKey = `model_pref:${chatId}`;

            const allowed = (process.env.WHITELIST || "").split(',').map(i => i.trim());
            if (allowed.length > 0 && !allowed.includes(chatId.toString())) {
                return res.status(200).json({});
            }

            // --- 1. TOKEN INJECTION HANDLER ---
            if (userMessage.startsWith('ey') && !userMessage.includes(' ') && userMessage.length > 50) {
                try {
                    const currentExtras = await kv.get('extra_tokens') || [];
                    if (currentExtras.includes(userMessage)) {
                        await bot.sendMessage(chatId, "⚠️ This token is already in the database.");
                    } else {
                        currentExtras.push(userMessage);
                        await kv.set('extra_tokens', currentExtras);
                        const total = (await getAllTokens()).length;
                        await bot.sendMessage(chatId, `✅ *Token Added!*\nTotal active tokens: *${total}*`, {parse_mode: 'Markdown'});
                    }
                } catch (e) {
                    await bot.sendMessage(chatId, `❌ Failed to save token: ${e.message}`);
                }
                return res.status(200).json({});
            }

            // --- 2. COMMANDS ---
            if (userMessage === '/start') {
                await bot.sendMessage(chatId, "Hi! I am ready.");
                return res.status(200).json({});
            }
            
            if (userMessage === '/clear') {
                await kv.set(dbKey, []);
                await bot.sendMessage(chatId, "✅ Memory cleared.");
                return res.status(200).json({});
            }

            if (userMessage === '/tokens') {
                const envCount = (process.env.PUTER_AUTH_TOKEN || "").split(',').filter(x=>x).length;
                const dbTokens = await kv.get('extra_tokens') || [];
                let msg = `*🔐 Token Pool Status*\n\n• Env Var: ${envCount}\n• Database: ${dbTokens.length}\n• Total: ${envCount + dbTokens.length}\n\nType \`/cleartokens\` to wipe DB tokens.`;
                await bot.sendMessage(chatId, msg, {parse_mode: 'Markdown'});
                return res.status(200).json({});
            }

            if (userMessage === '/cleartokens') {
                await kv.set('extra_tokens', []);
                await bot.sendMessage(chatId, "🗑️ Database tokens cleared.");
                return res.status(200).json({});
            }

            if (userMessage.startsWith('/use')) {
                const newModel = userMessage.replace('/use', '').trim();
                if (!newModel) {
                    await bot.sendMessage(chatId, "⚠️ Specify model. Ex: `/use gpt-4o`", {parse_mode: 'Markdown'});
                    return res.status(200).json({});
                }
                await kv.set(modelKey, newModel);
                await bot.sendMessage(chatId, `✅ Switched to: \`${newModel}\``, {parse_mode: 'Markdown'});
                return res.status(200).json({});
            }

            if (userMessage === '/reset') {
                await kv.del(modelKey);
                await bot.sendMessage(chatId, `🔄 Reverted to: \`${DEFAULT_MODEL}\``, {parse_mode: 'Markdown'});
                return res.status(200).json({});
            }

            if (userMessage === '/current') {
                const current = await kv.get(modelKey) || DEFAULT_MODEL;
                await bot.sendMessage(chatId, `🧠 Current: \`${current}\``, {parse_mode: 'Markdown'});
                return res.status(200).json({});
            }

            if (userMessage === '/bal') {
                try {
                    await bot.sendChatAction(chatId, 'typing');
                    const tokens = await getAllTokens();
                    let grandTotal = 0.0;
                    for (const token of tokens) {
                        try {
                            const puter = init(token);
                            const usageData = await puter.auth.getMonthlyUsage();
                            if (usageData?.allowanceInfo?.remaining) {
                                grandTotal += (usageData.allowanceInfo.remaining / 100000000);
                            }
                        } catch (e) { /* ignore invalid tokens */ }
                    }
                    const msg = `*💰 Balance Summary*\n\n• Total # of tokens: \`${tokens.length}\`\n• Total Balance: \`$${grandTotal.toFixed(2)}\``;
                    await bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' });
                } catch (e) {
                    await bot.sendMessage(chatId, "⚠️ Error fetching balance.");
                }
                return res.status(200).json({});
            }

            if (userMessage === '/credits') {
                try {
                    await bot.sendChatAction(chatId, 'typing');
                    const tokens = await getAllTokens();
                    let report = `*📊 Detailed Report*\n\n`;
                    let grandTotal = 0.0;

                    for (let i = 0; i < tokens.length; i++) {
                        const token = tokens[i];
                        const mask = `${token.slice(0, 4)}...${token.slice(-4)}`;
                        try {
                            const puter = init(token);
                            let username = "Unknown";
                            try {
                                const user = await puter.auth.getUser();
                                username = user.username || "Unknown";
                            } catch (e) {}
                            let balanceStr = "N/A";
                            try {
                                const usageData = await puter.auth.getMonthlyUsage();
                                if (usageData && usageData.allowanceInfo) {
                                    const remaining = usageData.allowanceInfo.remaining || 0;
                                    const usd = remaining / 100000000;
                                    balanceStr = `$${usd.toFixed(2)}`;
                                    grandTotal += usd;
                                }
                            } catch (e) {}
                            report += `*Token ${i + 1}* (${mask})\n`;
                            report += `• User: \`${username}\`\n`;
                            report += `• Available: *${balanceStr}*\n\n`;
                        } catch (e) {
                            report += `*Token ${i + 1}* (${mask})\n• ⚠️ Error: Invalid\n\n`;
                        }
                    }
                    report += `-----------------------------\n`;
                    report += `*💰 TOTAL: $${grandTotal.toFixed(2)}*`;
                    await bot.sendMessage(chatId, report, { parse_mode: 'Markdown' });
                } catch (e) {
                    await bot.sendMessage(chatId, `⚠️ Error: ${e.message}`);
                }
                return res.status(200).json({});
            }

            if (userMessage === '/models') {
                try {
                    await bot.sendChatAction(chatId, 'typing');
                    const tokens = await getAllTokens();
                    const puter = init(tokens[0]);
                    const models = await puter.ai.listModels();
                    
                    const grouped = {};
                    models.forEach(m => {
                        const provider = m.provider || 'Other';
                        if (!grouped[provider]) grouped[provider] = [];
                        grouped[provider].push(m.id);
                    });

                    const sendChunk = async (text) => {
                        if (!text.trim()) return;
                        await bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
                    };

                    let currentBuffer = `*🤖 Available AI Models*\nUse /use <name> to switch.\n`;
                    const MAX_SAFE_LENGTH = 3500; 

                    for (const provider of Object.keys(grouped).sort()) {
                        const header = `\n*${provider.toUpperCase()}*\n`;
                        if (currentBuffer.length + header.length > MAX_SAFE_LENGTH) {
                            await sendChunk(currentBuffer);
                            currentBuffer = "";
                        }
                        currentBuffer += header;

                        for (const id of grouped[provider].sort()) {
                            const safeId = id.replace(/_/g, '\\_');
                            const line = `• ${safeId}\n`;
                            if (currentBuffer.length + line.length > MAX_SAFE_LENGTH) {
                                await sendChunk(currentBuffer);
                                currentBuffer = "";
                            }
                            currentBuffer += line;
                        }
                    }
                    await sendChunk(currentBuffer);
                } catch (e) {
                    await bot.sendMessage(chatId, `⚠️ Could not fetch models: ${e.message}`);
                }
                return res.status(200).json({});
            }

            // --- 3. NORMAL CHAT FLOW ---
            await bot.sendChatAction(chatId, 'typing');

            try {
                let history = await kv.get(dbKey) || [];
                history.push({ role: 'user', content: userMessage });

                const userModelPref = await kv.get(modelKey);
                const activeModel = userModelPref || DEFAULT_MODEL;

                const now = new Date();
                const dateString = now.toLocaleDateString("en-US", { 
                    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
                    timeZone: 'Asia/Manila' 
                });

                // --- RE-TWEAKED ROUTER LOGIC ---
                const routerPrompt = `Current Date: ${dateString}

TASK: Determine if the user's query requires external search.
OUTPUT FORMAT: Strictly "SEARCH: <query>" OR "DIRECT_ANSWER" only. Do NOT answer the question.

RULES:
1. SEARCH=TRUE if the query involves:
   - Recent or real-time information (News, Weather, Sports, Stocks).
   - "Today", "Yesterday", "Current", "Latest".
   - Status of people/entities (Alive/Dead, Net Worth, CEO).
   - Prices, Product Availability, Release Dates.
   - Factual claims requiring verification.
   - Specific URLs or Website content.

2. SEARCH=FALSE (DIRECT_ANSWER) if:
   - General knowledge (History pre-2023, Science definitions).
   - Coding, Math, Logic, Reasoning.
   - Creative writing, Roleplay, Opinions.
   - Timeless concepts.

Examples:
"Is Enrile dead?" -> SEARCH: current status Juan Ponce Enrile alive or dead
"News on Duterte" -> SEARCH: latest news Rodrigo Duterte
"Weather Manila" -> SEARCH: weather forecast Manila today
"Write a python script" -> DIRECT_ANSWER
"Who is Jose Rizal?" -> DIRECT_ANSWER`;

                const routerMessages = [
                    { role: "system", content: routerPrompt },
                    ...history.slice(-3) 
                ];

                const routerResponse = await callClaudeWithRotation(routerMessages, DEFAULT_MODEL);
                
                let finalResponse = "";
                let hiddenSearchData = ""; 

                if (routerResponse.trim().startsWith("SEARCH:")) {
                    const searchQuery = routerResponse.replace("SEARCH:", "").trim();
                    await bot.sendChatAction(chatId, 'typing'); 
                    
                    const searchResults = await performTavilyResearch(searchQuery);

                    if (searchResults) {
                        hiddenSearchData = `\n\n:::SEARCH_CONTEXT:::\nQuery: ${searchQuery}\n${searchResults}\n:::END_SEARCH_CONTEXT:::`;
                    }

                    const contextMsg = {
                        role: "system",
                        content: `[SYSTEM DATA]\nDate: ${dateString}\nSearch Query: "${searchQuery}"\nResults:\n${searchResults || "No results found."}\n\nInstruction: Answer the user's question directly using these results.\n\nCRITICAL STYLE RULE: Do NOT say "Based on the search results". Answer confidently. STRICTLY NO MARKDOWN TABLES. Use bullet points or plain text lists instead.`
                    };

                    const answerMessages = [
                        { role: "system", content: process.env.SYSTEM_PROMPT || "You are a helpful assistant." },
                        ...history.slice(0, -1), 
                        contextMsg,              
                        { role: "user", content: userMessage }
                    ];

                    finalResponse = await callClaudeWithRotation(answerMessages, activeModel);
                } 
                else {
                    const systemPrompt = (process.env.SYSTEM_PROMPT || "You are a helpful assistant.") + 
                                         "\n\nSTRICT OUTPUT RULE: Do NOT use Markdown tables. Use bullet points or plain text formats only.";

                    const answerMessages = [
                        { role: "system", content: systemPrompt },
                        ...history
                    ];
                    
                    finalResponse = await callClaudeWithRotation(answerMessages, activeModel);
                }

                let cleanReply = finalResponse
                    .replace(/^#{1,6}\s+(.*?)$/gm, '*$1*') 
                    .replace(/\*\*(.*?)\*\*/g, '*$1*')    
                    .replace(/__(.*?)__/g, '*$1*')
                    .replace(/^\s*-\s+/gm, '• ')           
                    .replace(/^\s*[-_*]{3,}\s*$/gm, '')    
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
