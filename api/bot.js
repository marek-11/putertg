import TelegramBot from 'node-telegram-bot-api';
import { init } from '@heyputer/puter.js';
import { Redis } from '@upstash/redis';

// --- CONFIGURATION ---

// 1. Initialize Puter AI
// Note: We use a try/catch block for initialization in case keys are missing during build
let puter;
try {
    puter = init(process.env.PUTER_AUTH_TOKEN);
} catch (e) {
    console.error("Puter Init Error:", e);
}

// 2. Initialize Upstash Redis
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// 3. Initialize Telegram Bot
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN);

// --- MAIN HANDLER ---

export default async function handler(req, res) {
    // Vercel uses Webhooks, so we only care about POST requests
    if (req.method === 'POST') {
        const { body } = req;
        
        // Check if the update is a message
        if (body.message) {
            const chatId = body.message.chat.id;
            const userMessage = body.message.text;

            // --- COMMAND: /clear ---
            if (userMessage === '/clear') {
                await redis.del(`chat:${chatId}`);
                await bot.sendMessage(chatId, "🧹 Memory cleared.");
                return res.status(200).json({ status: 'cleared' });
            }

            // Show "Typing..." status
            await bot.sendChatAction(chatId, 'typing');

            try {
                // --- STEP 1: RETRIEVE MEMORY ---
                let history = await redis.get(`chat:${chatId}`);
                if (!history || !Array.isArray(history)) {
                    history = [];
                }

                // --- STEP 2: UPDATE MEMORY ---
                history.push({ role: 'user', content: userMessage });

                // Keep only last 10 messages
                if (history.length > 10) {
                    history = history.slice(-10);
                }

                // --- STEP 3: ASK PUTER AI ---
                // Puter might throw an error if the token is invalid
                if (!puter) throw new Error("Puter AI not initialized. Check PUTER_AUTH_TOKEN.");

                const response = await puter.ai.chat(history, {
                    model: 'gpt-5-nano'
                });

                const aiText = typeof response === 'string' 
                    ? response 
                    : response.message?.content || JSON.stringify(response);

                // --- STEP 4: SAVE & REPLY ---
                history.push({ role: 'assistant', content: aiText });
                
                // Save to Redis (expire in 24h)
                await redis.set(`chat:${chatId}`, history, { ex: 86400 });
                
                await bot.sendMessage(chatId, aiText);
                
            } catch (error) {
                console.error("Bot Error:", error);
                const errText = error.message || "Unknown error";
                await bot.sendMessage(chatId, `⚠️ Error: ${errText}`);
            }
        }
        
        res.status(200).json({ status: 'ok' });
    } else {
        res.status(200).json({ status: 'ready' });
    }
}
