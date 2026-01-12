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

                const rawTokensString = process.env.PUTER_AUTH_TOKEN;
                if (!rawTokensString) throw new Error("No PUTER_AUTH_TOKEN found.");
                
                const tokens = rawTokensString.split(',').map(t => t.trim()).filter(Boolean);
                if (tokens.length === 0) throw new Error("PUTER_AUTH_TOKEN is empty.");

                const selectedToken = tokens[Math.floor(Math.random() * tokens.length)];
                const puter = init(selectedToken);

                // --- SYSTEM PROMPT ---
                let messagesToSend = [...history];
                if (process.env.SYSTEM_PROMPT) {
                    messagesToSend.unshift({ role: 'system', content: process.env.SYSTEM_PROMPT });
                }

                const response = await puter.ai.chat(messagesToSend, {
                    model: 'claude-opus-4-5' 
                });

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

                // --- CLEAN TEXT (Remove Markdown Symbols & Gaps) ---
                let cleanReply = replyText
                    // 1. Remove Markdown Formatting
                    .replace(/\*\*(.*?)\*\*/g, '$1')   // Remove **bold**
                    .replace(/__(.*?)__/g, '$1')       // Remove __bold__
                    .replace(/`(.*?)`/g, '$1')         // Remove `code`
                    .replace(/^#+\s+/gm, '')           // Remove # Headers
                    
                    // 2. Remove Horizontal Rules (---, ___, ***)
                    // Matches a line containing only dashes/underscores/stars
                    .replace(/^\s*[-_*]{3,}\s*$/gm, '') 
                    
                    // 3. Clean up Lists and Asterisks
                    .replace(/\n\s*-\s/g, '\n• ')      // Nice bullets
                    .replace(/\*/g, '')                // Remove stray stars
                    
                    // 4. Remove Extra Vertical Gaps
                    // Replaces 3 or more newlines with just 2
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
