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

                // --- TOKEN FETCHING ---
                let rawTokensString = '';
                if (process.env.TOKEN_GIST_URL) {
                    try {
                        const gistResponse = await fetch(process.env.TOKEN_GIST_URL);
                        if (gistResponse.ok) rawTokensString = await gistResponse.text();
                    } catch (err) { console.error("Gist Error:", err); }
                }
                if (!rawTokensString && process.env.PUTER_AUTH_TOKEN) {
                    rawTokensString = process.env.PUTER_AUTH_TOKEN;
                }
                
                const tokens = rawTokensString.split(',').map(t => t.trim()).filter(Boolean);
                if (tokens.length === 0) throw new Error("No PUTER_AUTH_TOKEN found.");
                
                const puter = init(tokens[Math.floor(Math.random() * tokens.length)]);

                // --- SYSTEM PROMPT ---
                let messagesToSend = [...history];
                if (process.env.SYSTEM_PROMPT) {
                    messagesToSend.unshift({ role: 'system', content: process.env.SYSTEM_PROMPT });
                }

                // --- CALL AI ---
                const response = await puter.ai.chat(messagesToSend, {
                    model: 'claude-opus-4-5' 
                });

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

                // --- MARKDOWN FIXES ---
                let telegramReply = replyText
                    .replace(/\*\*(.*?)\*\*/g, '*$1*') 
                    .replace(/__(.*?)__/g, '*$1*')     
                    .replace(/^#{1,6}\s+(.*$)/gm, '*$1*'); 

                history.push({ role: 'assistant', content: replyText });
                if (history.length > 20) history = history.slice(-20);
                await kv.set(dbKey, history);

                // --- NEW: SPLIT LONG MESSAGES ---
                // Telegram max is 4096. We use 4000 to be safe.
                const MAX_CHUNK_SIZE = 4000;
                
                if (telegramReply.length <= MAX_CHUNK_SIZE) {
                    // Send normally if short enough
                    await bot.sendMessage(chatId, telegramReply, { parse_mode: 'Markdown' });
                } else {
                    // Split into chunks if too long
                    for (let i = 0; i < telegramReply.length; i += MAX_CHUNK_SIZE) {
                        const chunk = telegramReply.substring(i, i + MAX_CHUNK_SIZE);
                        try {
                            // Try sending with Markdown
                            await bot.sendMessage(chatId, chunk, { parse_mode: 'Markdown' });
                        } catch (err) {
                            // If Markdown fails (e.g. split in the middle of *bold*), send as plain text
                            await bot.sendMessage(chatId, chunk);
                        }
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
