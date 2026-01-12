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
            const userMessage = body.message.text.trim(); // Remove extra spaces
            const dbKey = `chat_history:${chatId}`;

            // --- 1. HANDLE /CLEAR COMMAND ---
            if (userMessage === '/clear') {
                try {
                    // Overwrite history with an empty array (safer than delete)
                    await kv.set(dbKey, []); 
                    await bot.sendMessage(chatId, "✅ Conversation history cleared.");
                } catch (error) {
                    console.error("Clear Error:", error);
                    await bot.sendMessage(chatId, "⚠️ Failed to clear memory. Check Vercel logs.");
                }
                res.status(200).json({ status: 'ok' });
                return; // Stop here
            }

            // --- 2. HANDLE NORMAL CONVERSATION ---
            await bot.sendChatAction(chatId, 'typing');

            try {
                // Fetch existing history (or default to empty)
                let history = await kv.get(dbKey);
                if (!Array.isArray(history)) {
                    history = [];
                }

                // Add user message
                history.push({ role: 'user', content: userMessage });

                // Get AI response
                const response = await puter.ai.chat(history, {
                    model: 'gpt-5-nano'
                });

                const replyText = typeof response === 'string' 
                    ? response 
                    : response.message?.content || JSON.stringify(response);

                // Add AI response to history
                history.push({ role: 'assistant', content: replyText });

                // Keep only the last 20 messages to save space
                if (history.length > 20) {
                    history = history.slice(-20);
                }

                // Save back to database
                await kv.set(dbKey, history);

                await bot.sendMessage(chatId, replyText);

            } catch (error) {
                console.error("Chat Error:", error);
                await bot.sendMessage(chatId, "Sorry, I had trouble accessing my memory.");
            }
        }

        res.status(200).json({ status: 'ok' });
    } else {
        res.status(200).json({ status: 'ready' });
    }
}
