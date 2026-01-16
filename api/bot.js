// api/bot.js
const TelegramBot = require('node-telegram-bot-api');
const { kv } = require('@vercel/kv');
const { init } = require('@heyputer/puter.js/src/init.cjs');

// --- HELPER 1: CLAUDE CALL WRAPPER ---
async function callClaudeWithRotation(messages) {
    const rawTokens = process.env.PUTER_AUTH_TOKEN;
    if (!rawTokens) throw new Error("Missing PUTER_AUTH_TOKEN env var.");

    let tokens = rawTokens.split(',').map(t => t.trim()).filter(t => t.length > 0);
    
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

// --- HELPER 2: TAVILY RESEARCHER ---
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
                await bot.sendMessage(chatId, "Hi! I am ready.");
                return res.status(200).json({});
            }
            if (userMessage === '/clear') {
                await kv.set(dbKey, []);
                await bot.sendMessage(chatId, "✅ Memory cleared.");
                return res.status(200).json({});
            }

            // --- COMMAND: /credits (STABILIZED) ---
            if (userMessage === '/credits') {
                // Wrap entirely in try/catch to prevent silent bot death
                try {
                    await bot.sendChatAction(chatId, 'typing');
                    
                    const rawTokens = process.env.PUTER_AUTH_TOKEN;
                    if (!rawTokens) {
                        await bot.sendMessage(chatId, "⚠️ No PUTER_AUTH_TOKEN configured.");
                        return res.status(200).json({});
                    }

                    const tokens = rawTokens.split(',').map(t => t.trim()).filter(t => t.length > 0);
                    let report = `*📊 Puter Account Report*\n\n`;

                    for (let i = 0; i < tokens.length; i++) {
                        const token = tokens[i];
                        const mask = `${token.slice(0, 4)}...${token.slice(-4)}`;
                        
                        try {
                            const puter = init(token);
                            
                            // 1. Fetch User Profile
                            // We use Promise.allSettled to ensure one failing call doesn't stop the other
                            const [userRes, usageRes] = await Promise.allSettled([
                                puter.auth.getUser(),
                                puter.auth.getMonthlyUsage ? puter.auth.getMonthlyUsage() : Promise.resolve(null)
                            ]);

                            // Process User Data (Balance)
                            let username = "Unknown";
                            let balanceStr = "N/A";
                            
                            if (userRes.status === 'fulfilled') {
                                const u = userRes.value;
                                username = u.username || "Unknown";
                                // Check all known balance fields
                                const bal = u.balance !== undefined ? u.balance : (u.account_balance || 0);
                                balanceStr = `$${parseFloat(bal).toFixed(2)}`;
                            }

                            // Process Usage Data (Spent this month)
                            let usageStr = "$0.00";
                            if (usageRes.status === 'fulfilled' && usageRes.value) {
                                const usage = usageRes.value;
                                const cost = usage.total_cost || usage.cost || usage.amount || 0;
                                usageStr = `$${parseFloat(cost).toFixed(2)}`;
                            }

                            report += `*Token ${i + 1}* (${mask})\n`;
                            report += `• User: \`${username}\`\n`;
                            report += `• Balance: ${balanceStr}\n`;
                            report += `• Usage (Month): ${usageStr}\n\n`;

                        } catch (e) {
                            report += `*Token ${i + 1}* (${mask})\n• ⚠️ Error: Check Token\n\n`;
                        }
                    }
                    
                    await bot.sendMessage(chatId, report, { parse_mode: 'Markdown' });

                } catch (fatalError) {
                    console.error("Credits command crashed:", fatalError);
                    await bot.sendMessage(chatId, "⚠️ Error checking credits.");
                }
                
                return res.status(200).json({});
            }

            await bot.sendChatAction(chatId, 'typing');

            try {
                let history = await kv.get(dbKey) || [];
                history.push({ role: 'user', content: userMessage });

                const now = new Date();
                const dateString = now.toLocaleDateString("en-US", { 
                    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' 
                });

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

                    finalResponse = await callClaudeWithRotation(answerMessages);
                } 
                else {
                    const systemPrompt = (process.env.SYSTEM_PROMPT || "You are a helpful assistant.") + 
                                         "\n\nSTRICT OUTPUT RULE: Do NOT use Markdown tables. Use bullet points or plain text formats only.";

                    const answerMessages = [
                        { role: "system", content: systemPrompt },
                        ...history
                    ];
                    finalResponse = await callClaudeWithRotation(answerMessages);
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
