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

                // --- CALL AI ---
                const response = await puter.ai.chat(history, {
                    model: 'claude-opus-4-5' 
                });

                // --- SAFETY CHECKS (Fixes the crash) ---
                if (!response) {
                    throw new Error("AI Service returned an empty response.");
                }

                // Determine the text content safely
                let replyText;
                if (typeof response === 'string') {
                    replyText = response;
                } else if (response.message && response.message.content) {
                    replyText = response.message.content;
                } else {
                    // If it's an object but not the expected format, confirm it's valid JSON
                    replyText = JSON.stringify(response);
                }

                // Final check to ensure we have a string before .replace()
                if (typeof replyText !== 'string') {
                    replyText = "⚠️ Error: AI response was not text.";
                }

                // --- MARKDOWN FIXES ---
                // Only run replace if we actually have a valid string
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
