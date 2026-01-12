// api/bot.js
const TelegramBot = require('node-telegram-bot-api');
const { Redis } = require('@upstash/redis');

// Initialize Telegram and Redis (These work fine with require)
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN);
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

export default async function handler(req, res) {
    // 1. Dynamic Import for Puter (Fixes the ERR_REQUIRE_ESM error)
    // We load this INSIDE the function so it doesn't crash the server start
    const { init } = await import('@heyputer/puter.js');
    
    // Initialize Puter with the token
    const puter = init(process.env.PUTER_AUTH_TOKEN);

    if (req.method === 'POST') {
        const { body } = req;
        
        if (body.message) {
            const chatId = body.message.chat.id;
            const userMessage = body.message.text;

            // --- COMMAND: /clear ---
            if (userMessage === '/clear') {
                await redis.del(`chat:${chatId}`);
                await bot.sendMessage(chatId, "🧹 Memory cleared.");
                return res.status(200).json({ status: 'cleared' });
            }

            await bot.sendChatAction(chatId, 'typing');

            try {
                // --- FETCH MEMORY ---
                let history = await redis.get(`chat:${chatId}`);
                if (!history || !Array.isArray(history)) history = [];

                // Add User Message
                history.push({ role: 'user', content: userMessage });
                if (history.length > 10) history = history.slice(-10);

                // --- ASK PUTER ---
                const response = await puter.ai.chat(history, {
                    model: 'gpt-5-nano'
                });

                const aiText = typeof response === 'string' 
                    ? response 
                    : response.message?.content || JSON.stringify(response);

                // --- SAVE & REPLY ---
                history.push({ role: 'assistant', content: aiText });
                await redis.set(`chat:${chatId}`, history, { ex: 86400 });
                await bot.sendMessage(chatId, aiText);

            } catch (error) {
                console.error("Bot Error:", error);
                await bot.sendMessage(chatId, "⚠️ Error: " + error.message);
            }
        }
        return res.status(200).json({ status: 'ok' });
    }
    
    res.status(200).json({ status: 'ready' });
}
