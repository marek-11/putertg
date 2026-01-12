// api/bot.js
const TelegramBot = require('node-telegram-bot-api');
const { kv } = require('@vercel/kv');
const { init } = require('@heyputer/puter.js/src/init.cjs');

const puter = init(process.env.PUTER_AUTH_TOKEN);

export default async function handler(req, res) {
    const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN);

    if (req.method === 'POST') {
        const { body } = req;

        if (body.message && body.message.text) {
            const chatId = body.message.chat.id;
            const userMessage = body.message.text.trim();
            
            // --- WHITELIST CHECK ---
            const whitelistEnv = process.env.WHITELIST;
            // Split by comma, trim whitespace, and ignore empty entries
            const allowedUsers = whitelistEnv 
                ? whitelistEnv.split(',').map(id => id.trim()).filter(Boolean) 
                : [];

            // If user ID is NOT in the allowed list, block them.
            // (If whitelistEnv is empty, allowedUsers is [], so everyone is blocked)
            if (!allowedUsers.includes(chatId.toString())) {
                await bot.sendMessage(chatId, "You are unauthorized to use this bot.");
                res.status(200).json({ status: 'unauthorized' });
                return; // Stop execution here
            }
            // -----------------------

            const dbKey = `chat_history:${chatId}`;

            // --- 1. HANDLE /CLEAR COMMAND ---
            if (userMessage === '/clear') {
                try {
                    await kv.set(dbKey, []); 
                    await bot.sendMessage(chatId, "✅ Conversation history cleared.");
                } catch (error) {
                    console.error("Clear Error:", error);
                    await bot.sendMessage(chatId, "⚠️ Failed to clear memory.");
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

                const response = await puter.ai.chat(history, {
                    model: 'gpt-5.2-chat-latest'
                });

                const replyText = typeof response === 'string' 
                    ? response 
                    : response.message?.content || JSON.stringify(response);

                // --- MARKDOWN FIXES ---
                let telegramReply = replyText
                    .replace(/\*\*(.*?)\*\*/g, '*$1*') // Bold
                    .replace(/__(.*?)__/g, '*$1*')     // Bold
                    .replace(/^#{1,6}\s+(.*$)/gm, '*$1*'); // Headers

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
                const fallbackText = typeof response !== 'undefined' 
                    ? (typeof response === 'string' ? response : response.message?.content)
                    : "Sorry, I encountered an error.";
                await bot.sendMessage(chatId, fallbackText);
            }
        }

        res.status(200).json({ status: 'ok' });
    } else {
        res.status(200).json({ status: 'ready' });
    }
}
