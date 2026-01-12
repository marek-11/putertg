const TelegramBot = require('node-telegram-bot-api');
const { init } = require('@heyputer/puter.js'); 
const { Redis } = require('@upstash/redis');

// --- CONFIGURATION ---

// 1. Initialize Puter AI
// This requires the PUTER_AUTH_TOKEN environment variable
const puter = init(process.env.PUTER_AUTH_TOKEN);

// 2. Initialize Upstash Redis (The Database)
// This requires UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN
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
            // Allows the user to wipe memory and start fresh
            if (userMessage === '/clear') {
                await redis.del(`chat:${chatId}`);
                await bot.sendMessage(chatId, "🧹 Memory cleared. I've forgotten our previous conversation.");
                return res.status(200).json({ status: 'cleared' });
            }

            // Show "Typing..." status while we think
            await bot.sendChatAction(chatId, 'typing');

            try {
                // --- STEP 1: RETRIEVE MEMORY ---
                // We fetch the chat history for this specific user ID
                let history = await redis.get(`chat:${chatId}`);
                
                // If no history exists, start with an empty array
                if (!history || !Array.isArray(history)) {
                    history = [];
                }

                // --- STEP 2: UPDATE MEMORY WITH USER INPUT ---
                // Add the user's new message to the history list
                history.push({ role: 'user', content: userMessage });

                // OPTIMIZATION: Keep only the last 10 messages
                // This prevents the context from getting too large (and expensive/slow)
                if (history.length > 10) {
                    history = history.slice(-10);
                }

                // --- STEP 3: ASK PUTER AI ---
                // We send the *entire* history so the AI knows the context
                const response = await puter.ai.chat(history, {
                    model: 'gpt-5-nano'
                });

                // Extract the actual text response safely
                // Some APIs return a string, others an object. We handle both.
                const aiText = typeof response === 'string' 
                    ? response 
                    : response.message?.content || JSON.stringify(response);

                // --- STEP 4: UPDATE MEMORY WITH AI RESPONSE ---
                history.push({ role: 'assistant', content: aiText });

                // --- STEP 5: SAVE TO DATABASE ---
                // Save the updated history back to Redis
                // 'ex: 86400' means the memory expires (deletes itself) after 24 hours of inactivity
                await redis.set(`chat:${chatId}`, history, { ex: 86400 });

                // --- STEP 6: REPLY TO USER ---
                await bot.sendMessage(chatId, aiText);
                
            } catch (error) {
                console.error("Bot Error:", error);
                await bot.sendMessage(chatId, "⚠️ I encountered an error connecting to my brain. Please try again.");
            }
        }
        
        // Respond to Telegram that we received the update
        res.status(200).json({ status: 'ok' });
    } else {
        // Handle basic health checks (GET requests)
        res.status(200).json({ status: 'ready', message: 'Send a POST request via Telegram Webhook' });
    }
}
