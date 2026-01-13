// api/bot.js
const TelegramBot = require('node-telegram-bot-api');
const { kv } = require('@vercel/kv');
const { init } = require('@heyputer/puter.js/src/init.cjs');

// --- HELPER 1: CLASSIFIER (Decides IF we need to search) ---
// UPGRADE: Switched to 'llama-3.3-70b-versatile' which is smarter and follows instructions better.
async function shouldWeSearch(userMessage) {
    if (!process.env.GROQ_API_KEY) {
        console.log("🚫 No GROQ_API_KEY found. Skipping search.");
        return false;
    }

    try {
        const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${process.env.GROQ_API_KEY}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                model: "llama-3.3-70b-versatile", // Smarter model for better decisions
                messages: [
                    {
                        role: "system",
                        content: "You are a decision engine. Determine if the user's query requires real-world facts, data, news, or knowledge that might have changed recently. \n\nRULES:\n- IF asking about people, places, events, stocks, prices, or specific facts: output 'YES'.\n- IF asking for code, creative writing, translation, or simple greetings: output 'NO'.\n- Output ONLY 'YES' or 'NO'."
                    },
                    { role: "user", content: userMessage }
                ],
                temperature: 0,
                max_tokens: 5
            })
        });

        const data = await response.json();
        const rawDecision = data.choices?.[0]?.message?.content?.trim().toUpperCase() || "NO";
        
        console.log(`🔍 Classifier Decision for "${userMessage}": ${rawDecision}`); // <--- DEBUG LOG
        
        return rawDecision.includes("YES");
    } catch (error) {
        console.error("❌ Classifier Error:", error);
        return false;
    }
}

// --- HELPER 2: RESEARCHER ---
async function performGroqResearch(userMessage) {
    if (!process.env.GROQ_API_KEY) return null;

    try {
        console.log("🌐 Starting Research...");
        const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${process.env.GROQ_API_KEY}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                model: "groq/compound", 
                messages: [
                    {
                        role: "system",
                        content: "You are a research tool. Perform a web search if needed and return a concise, factual summary of the user's query. If the query is unclear, provide the most likely relevant facts."
                    },
                    { role: "user", content: userMessage }
                ]
            })
        });

        const data = await response.json();
        
        // Check if the model actually returned content or an error
        if (data.error) {
            console.error("❌ Research Model Error:", data.error);
            return null;
        }

        const content = data.choices?.[0]?.message?.content;
        console.log("✅ Research Complete. Length:", content ? content.length : 0);
        return content || null;
    } catch (error) {
        console.error("❌ Research Network Error:", error);
        return null;
    }
}

export default async function handler(req, res) {
    const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN);

    if (req.method === 'POST') {
        const { body } = req;

        if (body.message && body.message.text) {
            const chatId = body.message.chat.id;
            const userMessage = body.message.text.trim();
            
            // --- WHITELIST CHECK ---
            const whitelistEnv = process.env.WHITELIST;
            const allowedUsers = whitelistEnv 
                ? whitelistEnv.split(',').map(id => id.trim()).filter(Boolean) 
                : [];

            if (!allowedUsers.includes(chatId.toString())) {
                await bot.sendMessage(chatId, "You are unauthorized to use this bot.");
                res.status(200).json({ status: 'unauthorized' });
                return; 
            }

            if (userMessage === '/start') {
                await bot.sendMessage(chatId, "Hi");
                res.status(200).json({ status: 'ok' });
                return;
            }

            const dbKey = `chat_history:${chatId}`;

            if (userMessage === '/clear') {
                try {
                    await kv.set(dbKey, []); 
                    await bot.sendMessage(chatId, "✅ Conversation history cleared.");
                } catch (error) {
                    console.error("Clear Error:", error);
                    await bot.sendMessage(chatId, `⚠️ Failed to clear memory: ${error.message}`);
                }
                res.status(200).json({ status: 'ok' });
                return; 
            }

            await bot.sendChatAction(chatId, 'typing');

            try {
                let history = await kv.get(dbKey);
                if (!Array.isArray(history)) {
                    history = [];
                }

                history.push({ role: 'user', content: userMessage });

                // ====================================================
                // RESEARCH PHASE
                // ====================================================
                let searchContext = null;
                
                // 1. Check Classifier
                const needsSearch = await shouldWeSearch(userMessage);

                if (needsSearch) {
                    await bot.sendChatAction(chatId, 'typing');
                    
                    // 2. Perform Research
                    const researchResults = await performGroqResearch(userMessage);
                    
                    if (researchResults) {
                        searchContext = `\n\n[SYSTEM: Web Search Results for "${userMessage}":\n${researchResults}\n\nUse these facts to answer.]`;
                    } else {
                        console.log("⚠️ Research returned no data. Falling back to Claude Opus directly.");
                    }
                }
                // ====================================================

                // --- PREPARE TOKENS ---
                const rawTokensString = process.env.PUTER_AUTH_TOKEN;
                if (!rawTokensString) throw new Error("No PUTER_AUTH_TOKEN found.");
                
                let tokens = rawTokensString.split(',').map(t => t.trim()).filter(Boolean);
                if (tokens.length === 0) throw new Error("PUTER_AUTH_TOKEN is empty.");

                // Shuffle tokens
                for (let i = tokens.length - 1; i > 0; i--) {
                    const j = Math.floor(Math.random() * (i + 1));
                    [tokens[i], tokens[j]] = [tokens[j], tokens[i]];
                }

                // --- PREPARE MESSAGES ---
                let messagesToSend = [...history];

                // Inject Search Context if available
                if (searchContext) {
                    const lastMsgIndex = messagesToSend.length - 1;
                    if (lastMsgIndex >= 0) {
                        messagesToSend[lastMsgIndex] = {
                            role: 'user',
                            content: messagesToSend[lastMsgIndex].content + searchContext
                        };
                    }
                }

                if (process.env.SYSTEM_PROMPT) {
                    messagesToSend.unshift({ role: 'system', content: process.env.SYSTEM_PROMPT });
                }

                // --- WRITER PHASE (Claude Opus) ---
                let response = null;
                let lastError = null;

                for (const token of tokens) {
                    try {
                        const puter = init(token);
                        response = await puter.ai.chat(messagesToSend, {
                            model: 'claude-opus-4-5' 
                        });
                        break; 
                    } catch (err) {
                        console.warn(`Token failed: ${err.message}`);
                        lastError = err;
                    }
                }

                if (!response) {
                    throw new Error(`All tokens failed. Last error: ${lastError?.message}`);
                }

                // --- PARSE RESPONSE ---
                let replyText = '';
                if (typeof response === 'string') {
                    replyText = response;
                } else if (response?.message?.content) {
                    const content = response.message.content;
                    if (typeof content === 'string') {
                        replyText = content;
                    } else if (Array.isArray(content)) {
                        replyText = content
                            .filter(item => item.type === 'text' || item.text)
                            .map(item => item.text || '')
                            .join('');
                    } else {
                        replyText = JSON.stringify(content);
                    }
                } else {
                    replyText = JSON.stringify(response);
                }

                // --- CLEAN TEXT ---
                let cleanReply = replyText
                    .replace(/\*\*(.*?)\*\*/g, '$1')   
                    .replace(/__(.*?)__/g, '$1')       
                    .replace(/`(.*?)`/g, '$1')         
                    .replace(/^#+\s+/gm, '')           
                    .replace(/^\s*[-_*]{3,}\s*$/gm, '') 
                    .replace(/\n\s*-\s/g, '\n• ')      
                    .replace(/\*/g, '')                
                    .replace(/\n{3,}/g, '\n\n')
                    .trim();

                history.push({ role: 'assistant', content: cleanReply });
                if (history.length > 20) history = history.slice(-20);
                await kv.set(dbKey, history);

                // --- SEND PLAIN TEXT ---
                const MAX_CHUNK_SIZE = 4000;
                
                if (cleanReply.length <= MAX_CHUNK_SIZE) {
                    await bot.sendMessage(chatId, cleanReply);
                } else {
                    for (let i = 0; i < cleanReply.length; i += MAX_CHUNK_SIZE) {
                        const chunk = cleanReply.substring(i, i + MAX_CHUNK_SIZE);
                        await bot.sendMessage(chatId, chunk);
                    }
                }

            } catch (error) {
                console.error("Chat Error:", error);
                await bot.sendMessage(chatId, `⚠️ AI Error: ${error.message || error.toString()}`);
            }
        }

        res.status(200).json({ status: 'ok' });
    } else {
        res.status(200).json({ status: 'ready' });
    }
}
