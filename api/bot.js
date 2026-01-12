// api/bot.js
const TelegramBot = require('node-telegram-bot-api');
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
                // --- YOUR PUTER LOGIC HERE ---
                // This replaces the client-side `puter.ai.chat`
                // We use the same model 'gpt-5-nano' you asked for
                const response = await puter.ai.chat(userMessage, {
                    model: 'gpt-5-nano'
                });

                // Send the AI response back to Telegram
                // Note: puter.ai.chat returns a string or object depending on response
                // We assume it returns the text string directly or .message.content
                const replyText = typeof response === 'string' ? response : response.message?.content || JSON.stringify(response);
                
                await bot.sendMessage(chatId, replyText);
                
            } catch (error) {
                console.error("Puter Error:", error);
                await bot.sendMessage(chatId, "Sorry, I couldn't reach the AI brain.");
            }
        }
        
        res.status(200).json({ status: 'ok' });
    } else {
        res.status(200).json({ status: 'ready' });
    }
}
