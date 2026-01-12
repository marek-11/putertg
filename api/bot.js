// api/bot.js
const TelegramBot = require('node-telegram-bot-api');
const { init } = require('@heyputer/puter.js/src/init.cjs');
const { Redis } = require('@upstash/redis'); // Import Redis

// Initialize services
const puter = init(process.env.PUTER_AUTH_TOKEN);
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

export default async function handler(req, res) {
    const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN);
    
    if (req.method === 'POST') {
        const { body } = req;
        
        if (body.message) {
            const chatId = body.message.chat.id;
            const userMessage = body.message.text;

            // 1. COMMAND: /clear to reset memory
            if (userMessage === '/clear') {
                await redis.del(`chat:${chatId}`);
                await bot.sendMessage(chatId, "🧠 Memory wiped! I'm ready for a new topic.");
                return res.status(200).json({ status: 'cleared' });
            }

            await bot.sendChatAction(chatId, 'typing');

            try {
                // 2. FETCH HISTORY from Redis
                // We default to an empty array [] if nothing is found
                let history = await redis.get(`chat:${chatId}`) || [];

                // 3. ADD NEW USER MESSAGE
                history.push({ role: 'user', content: userMessage });

                // OPTIONAL: Keep only the last 10 messages to avoid token limits
                if (history.length > 10) {
                    history = history.slice(-10);
                }

                // 4. SEND FULL HISTORY TO PUTER
                // Most Chat APIs accept an array of messages
                const response = await puter.ai.chat(history, {
                    model: 'gpt-5-nano'
                });

                // Extract the text safely
                const aiText = typeof response === 'string' ? response : response.message?.content;

                // 5. ADD AI RESPONSE TO HISTORY
                history.push({ role: 'assistant', content: aiText });

                // 6. SAVE BACK TO REDIS
                // Set to expire in 24 hours (86400 seconds) so old chats don't clutter DB
                await redis.set(`chat:${chatId}`, history, { ex: 86400 });

                // 7. REPLY TO USER
                await bot.sendMessage(chatId, aiText);
                
            } catch (error) {
                console.error("Error:", error);
                await bot.sendMessage(chatId, "My brain hurt. Try /clear to reset.");
            }
        }
        res.status(200).json({ status: 'ok' });
    } else {
        res.status(200).json({ status: 'ready' });
    }
}
