// api/bot.js
const TelegramBot = require('node-telegram-bot-api');
const { kv } = require('@vercel/kv');
const { init } = require('@heyputer/puter.js/src/init.cjs');

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

            const dbKey = `chat_history:${chatId}`;

            // --- 1. HANDLE /CLEAR COMMAND ---
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

            // --- 2. HANDLE NORMAL CONVERSATION ---
            await bot.sendChatAction(chatId, 'typing');

            try {
                let history = await kv.get(dbKey);
                if (!Array.isArray(history)) {
                    history = [];
                }

                history.push({ role: 'user', content: userMessage });

                // --- NEW: TOKEN FETCHING LOGIC ---
                let rawTokensString = '';

                // A. Try fetching from Gist URL first
                if (process.env.TOKEN_GIST_URL) {
                    try {
                        const gistResponse = await fetch(process.env.TOKEN_GIST_URL);
                        if (gistResponse.ok) {
                            rawTokensString = await gistResponse.text();
                        } else {
                            console.error("Failed to fetch Gist:", gistResponse.statusText);
                        }
                    } catch (err) {
                        console.error("Gist Fetch Error:", err);
                    }
                }

                // B. Fallback to Environment Variable if Gist failed or is missing
                if (!rawTokensString && process.env.PUTER_AUTH_TOKEN) {
                    rawTokensString = process.env.PUTER_AUTH_TOKEN;
                }

                // C. Parse Tokens
                const tokens = rawTokensString
                    .split(',')
                    .map(t => t.trim())
                    .filter(Boolean); // Remove empty strings

                if (tokens.length === 0) {
                    throw new Error("No PUTER_AUTH_TOKEN found (checked Gist and Env Vars).");
                }

                // D. Pick Random Token
                const selectedToken = tokens[Math.floor(Math.random() * tokens.length)];
                
                // Initialize Puter
                const puter = init(selectedToken);
                // ---------------------------------

                // --- SYSTEM PROMPT ---
                let messagesToSend = [...history];
                if (process.env.SYSTEM_PROMPT) {
                    messagesToSend.unshift({ 
                        role: 'system', 
                        content: process.env.SYSTEM_PROMPT 
                    });
                }

                // --- CALL AI (Claude Opus 4.5) ---
                const response = await puter.ai.chat(messagesToSend, {
                    model: 'claude-opus-4-5' 
                });

                // --- RESPONSE PARSING ---
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

                // --- MARKDOWN FIXES ---
                let telegramReply = replyText
                    .replace(/\*\*(.*?)\*\*/g, '*$1*') 
                    .replace(/__(.*?)__/g, '*$1*')     
                    .replace(/^#{1,6}\s+(.*$)/gm, '*$1*'); 

                history.push({ role: 'assistant', content: replyText });

                if (history.length > 20) {
                    history = history.slice(-20);
                }
                await kv.set(dbKey, history);

                await bot.sendMessage(chatId, telegramReply, { 
                    parse_mode: 'Markdown' 
                });

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
