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
                // Fetch history
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
                    // 1. Convert **bold** to *bold*
                    .replace(/\*\*(.*?)\*\*/g, '*$1*')
                    // 2. Convert __bold__ to *bold*
                    .replace(/__(.*?)__/g, '*$1*')
                    // 3. Convert ANY Header (# through ######) to *Bold*
                    // This fixes the ### issue you saw
                    .replace(/^#{1,6}\s+(.*$)/gm, '*$1*');

                // Save ORIGINAL text to history (so AI context stays clean)
                history.push({ role: 'assistant', content: replyText });

                if (history.length > 20) {
                    history = history.slice(-20);
                }
                await kv.set(dbKey, history);

                // Send with Markdown parsing
                await bot.sendMessage(chatId, telegramReply, { 
                    parse_mode: 'Markdown' 
                });

            } catch (error) {
                console.error("Chat Error:", error);
                
                // FALLBACK: If Markdown fails (e.g. unclosed *), send plain text
                // This ensures you still get the answer even if formatting breaks
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
