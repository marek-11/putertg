// api/bot.js
const TelegramBot = require('node-telegram-bot-api');
const { kv } = require('@vercel/kv');
const { init } = require('@heyputer/puter.js/src/init.cjs');

// --- HELPER: TAVILY RESEARCHER ---
async function performTavilyResearch(userQuery) {
    if (!process.env.TAVILY_API_KEY) return null;

    try {
        const response = await fetch("https://api.tavily.com/search", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                api_key: process.env.TAVILY_API_KEY,
                query: userQuery,
                search_depth: "basic",
                include_answer: true,
                max_results: 5
            })
        });

        if (!response.ok) throw new Error(`Tavily API Error: ${response.statusText}`);

        const data = await response.json();
        
        let context = `Tavily AI Answer: ${data.answer}\n\nSources Found:\n`;
        if (data.results && data.results.length > 0) {
            data.results.forEach((result, index) => {
                context += `[${index + 1}] Title: ${result.title}\n    URL: ${result.url}\n    Content: ${result.content}\n\n`;
            });
        }
        return context;

    } catch (error) {
        console.error("Tavily Research Error:", error);
        return `[Error fetching search results: ${error.message}]`;
    }
}

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

            if (userMessage === '/start') {
                await bot.sendMessage(chatId, "Hi");
                res.status(200).json({ status: 'ok' });
                return;
            }

            const dbKey = `chat_history:${chatId}`;

            if (userMessage === '/clear') {
                try {
                    await kv.set(dbKey, []); 
                    await bot.sendMessage(chatId, "✅ Conversation history cleared.");
                } catch (error) {
                    await bot.sendMessage(chatId, `⚠️ Failed to clear memory: ${error.message}`);
                }
                res.status(200).json({ status: 'ok' });
                return; 
            }

            await bot.sendChatAction(chatId, 'typing');

            try {
                let history = await kv.get(dbKey);
                if (!Array.isArray(history)) history = [];

                // --- SEARCH LOGIC ---
                let messageContent = userMessage;
                let searchContext = null;

                if (userMessage.startsWith('/s ')) {
                    const query = userMessage.slice(3).trim();
                    if (query.length > 0) {
                        messageContent = query;
                        await bot.sendChatAction(chatId, 'typing'); 
                        const researchResults = await performTavilyResearch(query);
                        if (researchResults) {
                            searchContext = `\n\n[SYSTEM: The user explicitly requested a web search. Here are the Tavily results for "${query}":\n${researchResults}\n\nUse these facts to answer the user.]`;
                        }
                    }
                }

                history.push({ role: 'user', content: messageContent });

                // --- TOKEN PREPARATION ---
                const rawTokensString = process.env.PUTER_AUTH_TOKEN;
                if (!rawTokensString) throw new Error("No PUTER_AUTH_TOKEN found.");
                
                let tokens = rawTokensString.split(',').map(t => t.trim()).filter(Boolean);
                if (tokens.length === 0) throw new Error("PUTER_AUTH_TOKEN is empty.");

                // Shuffle tokens
                for (let i = tokens.length - 1; i > 0; i--) {
                    const j = Math.floor(Math.random() * (i + 1));
                    [tokens[i], tokens[j]] = [tokens[j], tokens[i]];
                }

                // --- MESSAGE PREPARATION ---
                let messagesToSend = [...history];
                if (searchContext) {
                    const lastMsgIndex = messagesToSend.length - 1;
                    if (lastMsgIndex >= 0) {
                        messagesToSend[lastMsgIndex] = {
                            role: 'user',
                            content: messagesToSend[lastMsgIndex].content + searchContext
                        };
                    }
                }
                if (process.env.SYSTEM_PROMPT) {
                    messagesToSend.unshift({ role: 'system', content: process.env.SYSTEM_PROMPT });
                }

                // --- ROTATION LOOP (FIXED) ---
                let response = null;
                let lastError = null;

                for (const token of tokens) {
                    try {
                        const puter = init(token);
                        
                        // We await the response
                        const result = await puter.ai.chat(messagesToSend, {
                            model: 'claude-opus-4-5' 
                        });

                        // 1. Check for hard failure (null/undefined)
                        if (!result) throw new Error("API returned empty response");

                        // 2. Check for explicit error objects (Some APIs return {error: '...'} instead of throwing)
                        if (result.error || result.code) {
                            throw new Error(JSON.stringify(result));
                        }

                        // 3. Check text content for credit warnings
                        // Sometimes the API returns a string saying "Out of credits"
                        let tempText = "";
                        if (typeof result === 'string') tempText = result;
                        else if (result?.message?.content) tempText = result.message.content;
                        
                        // If the response is suspiciously short and mentions 'credit' or 'quota', treat as error
                        // This forces the loop to try the next token
                        if (typeof tempText === 'string' && tempText.length < 100) {
                            const lower = tempText.toLowerCase();
                            if (lower.includes('credit') || lower.includes('quota') || lower.includes('insufficient')) {
                                throw new Error(`Token returned error text: ${tempText}`);
                            }
                        }

                        // If we passed all checks, accept this response
                        response = result;
                        break; // SUCCESS! Exit the loop.

                    } catch (err) {
                        console.warn(`Token ending in ...${token.slice(-4)} failed: ${err.message}`);
                        lastError = err;
                        // LOOP CONTINUES TO NEXT TOKEN AUTOMATICALLY
                    }
                }

                if (!response) {
                    throw new Error(`All tokens failed. Last error: ${lastError?.message}`);
                }

                // --- PARSE RESPONSE ---
                let replyText = '';
                if (typeof response === 'string') {
                    replyText = response;
                } else if (response?.message?.content) {
                    const content = response.message.content;
                    if (typeof content === 'string') {
                        replyText = content;
                    } else if (Array.isArray(content)) {
                        replyText = content
                            .filter(item => item.type === 'text' || item.text)
                            .map(item => item.text || '')
                            .join('');
                    } else {
                        replyText = JSON.stringify(content);
                    }
                } else {
                    replyText = JSON.stringify(response);
                }

                // --- CLEAN TEXT ---
                let cleanReply = replyText
                    .replace(/\*\*(.*?)\*\*/g, '$1')   
                    .replace(/__(.*?)__/g, '$1')       
                    .replace(/`(.*?)`/g, '$1')         
                    .replace(/^#+\s+/gm, '')           
                    .replace(/^\s*[-_*]{3,}\s*$/gm, '') 
                    .replace(/\n\s*-\s/g, '\n• ')      
                    .replace(/\*/g, '')                
                    .replace(/\n{3,}/g, '\n\n')
                    .trim();

                history.push({ role: 'assistant', content: cleanReply });
                if (history.length > 20) history = history.slice(-20);
                await kv.set(dbKey, history);

                // --- SEND RESPONSE ---
                const MAX_CHUNK_SIZE = 4000;
                if (cleanReply.length <= MAX_CHUNK_SIZE) {
                    await bot.sendMessage(chatId, cleanReply);
                } else {
                    for (let i = 0; i < cleanReply.length; i += MAX_CHUNK_SIZE) {
                        await bot.sendMessage(chatId, cleanReply.substring(i, i + MAX_CHUNK_SIZE));
                    }
                }

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
