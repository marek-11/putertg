// api/bot.js
const TelegramBot = require('node-telegram-bot-api');
const { kv } = require('@vercel/kv');
// Note: Puter Node.js support imports from a specific path currently
const { init } = require('@heyputer/puter.js/src/init.cjs');

// Initialize Puter with your Auth Token
const puter = init(process.env.PUTER_AUTH_TOKEN);

export default async function handler(req, res) {
    const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN);
    
    if (req.method === 'POST') {
        const { body } = req;
        
        if (body.message) {
            const chatId = body.message.chat.id;
            const userMessage = body.message.text;

            // Show "typing..." status
            await bot.sendChatAction(chatId, 'typing');

            try {
                const dbKey = `chat_history:${chatId}`;

                // --- NEW: Handle /clear command ---
                if (userMessage === '/clear') {
                    await kv.del(dbKey);
                    await bot.sendMessage(chatId, "✅ Conversation history cleared. I've forgotten everything we talked about.");
                    res.status(200).json({ status: 'ok' });
                    return; // Stop here so we don't send '/clear' to the AI
                }
                // ----------------------------------

                // 1. Fetch existing history
                let history = await kv.get(dbKey);
                if (!Array.isArray(history)) {
                    history = [];
                }

                // 2. Add the user's new message to the history
                history.push({ role: 'user', content: userMessage });

                // 3. Send the ENTIRE history to Puter AI
                const response = await puter.ai.chat(history, {
                    model: 'gpt-5-nano'
                });

                // Extract the text content from the AI response
                const replyText = typeof response === 'string' 
                    ? response 
                    : response.message?.content || JSON.stringify(response);

                // 4. Add the AI's response to the history
                history.push({ role: 'assistant', content: replyText });

                // 5. Save the updated history back to the database
                // (Limit to last 20 messages to save space)
                if (history.length > 20) {
                    history = history.slice(-20);
                }
                await kv.set(dbKey, history);

                // 6. Send the response to the user
                await bot.sendMessage(chatId, replyText);
                
            } catch (error) {
                console.error("Error:", error);
                await bot.sendMessage(chatId, "Sorry, I had trouble accessing my memory.");
            }
        }
        
        res.status(200).json({ status: 'ok' });
    } else {
        res.status(200).json({ status: 'ready' });
    }
}
