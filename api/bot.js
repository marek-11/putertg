// api/bot.js
const TelegramBot = require('node-telegram-bot-api');
const { kv } = require('@vercel/kv'); // Import Vercel KV
// Note: Puter Node.js support imports from a specific path currently
const { init } = require('@heyputer/puter.js/src/init.cjs');

// 1. Initialize Puter with your Auth Token (Required for server-side)
const puter = init(process.env.PUTER_AUTH_TOKEN);

export default async function handler(req, res) {
    // Basic webhook setup
    const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN);
    
    // Vercel serverless function boilerplate
    if (req.method === 'POST') {
        const { body } = req;
        
        if (body.message) {
            const chatId = body.message.chat.id;
            const userMessage = body.message.text;

            // Show a "typing..." status to the user
            await bot.sendChatAction(chatId, 'typing');

            try {
                // --- UPSTASH KV LOGIC ---
                // Example: Increment a global message counter in your Redis/KV database
                // This uses the environment variables you provided automatically
                const count = await kv.incr('message_count');
                
                // You could also store the user's last message:
                // await kv.set(`user:${chatId}:last_message`, userMessage);
                
                // --- YOUR PUTER LOGIC HERE ---
                // This replaces the client-side `puter.ai.chat`
                // We use the same model 'gpt-5-nano' you asked for
                const response = await puter.ai.chat(userMessage, {
                    model: 'gpt-5-nano'
                });

                // Send the AI response back to Telegram
                // Note: puter.ai.chat returns a string or object depending on response
                // We assume it returns the text string directly or .message.content
                let replyText = typeof response === 'string' ? response : response.message?.content || JSON.stringify(response);
                
                // Optional: Append the message count for debugging
                // replyText += `\n\n(Processed message #${count})`;

                await bot.sendMessage(chatId, replyText);
                
            } catch (error) {
                console.error("Error:", error);
                await bot.sendMessage(chatId, "Sorry, I encountered an error.");
            }
        }
        
        res.status(200).json({ status: 'ok' });
    } else {
        res.status(200).json({ status: 'ready' });
    }
}
