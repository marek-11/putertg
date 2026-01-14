// api/bot.js
const TelegramBot = require('node-telegram-bot-api');
const { kv } = require('@vercel/kv');
const { init } = require('@heyputer/puter.js/src/init.cjs');

// --- HELPER: TAVILY RESEARCHER (Accepts specific API Key) ---
async function performTavilyResearch(userQuery, apiKey) {
    // We strictly require an API Key to be passed in
    if (!apiKey) return null;

    try {
        const response = await fetch("https://api.tavily.com/search", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                api_key: apiKey,            // Use the specific key from the loop
                query: userQuery,
                search_depth: "basic",
                include_answer: true,
                max_results: 5
            })
        });

        if (!response.ok) {
            // Throw error so the loop knows to try the next key
            throw new Error(`Tavily API Error: ${response.statusText}`);
        }

        const data = await response.json();
        
        let context = `Tavily AI Answer: ${data.answer}\n\nSources Found:\n`;
        if (data.results && data.results.length > 0) {
            data.results.forEach((result, index) => {
                context += `[${index + 1}] Title: ${result.title}\n    URL: ${result.url}\n    Content: ${result.content}\n\n`;
            });
        }
        return context;

    } catch (error) {
        // Rethrow error so the loop can catch it
        throw error;
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

                // ====================================================
                // 1. TAVILY ROTATION LOGIC (Search Phase)
                // ====================================================
                let messageContent = userMessage;
                let searchContext = null;

                if (userMessage.startsWith('/s ')) {
                    const query = userMessage.slice(3).trim();
                    
                    if (query.length > 0) {
                        messageContent = query;
                        await bot.sendChatAction(chatId, 'typing'); 

                        // A. Get Keys & Shuffle
                        const rawTavilyKeys = process.env.TAVILY_API_KEY || "";
                        let tavilyKeys = rawTavilyKeys.split(',').map(k => k.trim()).filter(Boolean);
                        
                        if (tavilyKeys.length === 0) {
                             await bot.sendMessage(chatId, "⚠️ Error: No TAVILY_API_KEY found.");
                        } else {
                            // Shuffle Tavily Keys
                            for (let i = tavilyKeys.length - 1; i > 0; i--) {
                                const j = Math.floor(Math.random() * (i + 1));
                                [tavilyKeys[i], tavilyKeys[j]] = [tavilyKeys[j], tavilyKeys[i]];
                            }

                            // B. Try Keys Loop
                            let searchSuccess = false;
                            for (const key of tavilyKeys) {
                                try {
                                    const researchResults = await performTavilyResearch(query, key);
                                    if (researchResults) {
                                        searchContext = `\n\n[SYSTEM: The user explicitly requested a web search. Here are the Tavily results for "${query}":\n${researchResults}\n\nUse these facts to answer the user.]`;
                                        searchSuccess = true;
                                        break; // Success! Stop checking keys.
                                    }
                                } catch (err) {
                                    console.warn(`Tavily Key ending in ...${key.slice(-4)} failed: ${err.message}`);
                                    // Loop continues to next key automatically
                                }
                            }

                            if (!searchSuccess) {
                                // If ALL keys failed
                                await bot.sendMessage(chatId, "⚠️ Search failed. All Tavily keys are invalid or out of credits.");
                            }
                        }
                    }
                }
                
                history.push({ role: 'user', content: messageContent });

                // ====================================================
                // 2. PUTER ROTATION LOGIC (Answer Phase)
                // ====================================================
                const rawTokensString = process.env.PUTER_AUTH_TOKEN;
                if (!rawTokensString) throw new Error("No PUTER_AUTH_TOKEN found.");
                
                let tokens = rawTokensString.split(',').map(t => t.trim()).filter(Boolean);
                if (tokens.length === 0) throw new Error("PUTER_AUTH_TOKEN is empty.");

                // Shuffle Puter Tokens
                for (let i = tokens.length - 1; i > 0; i--) {
                    const j = Math.floor(Math.random() * (i + 1));
                    [tokens[i], tokens[j]] = [tokens[j], tokens[i]];
                }

                // Prepare Context
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

                // Retry Loop for Puter
                let response = null;
                let lastError = null;

                for (const token of tokens) {
                    try {
                        const puter = init(token);
                        
                        const result = await puter.ai.chat(messagesToSend, {
                            model: 'claude-opus-4-5' 
                        });

                        // Validate Result
                        if (!result) throw new Error("Empty response");
                        if (result.error) throw new Error(JSON.stringify(result));
                        
                        // Check for credit warnings in text
                        let tempText = "";
                        if (typeof result === 'string') tempText = result;
                        else if (result?.message?.content) tempText = result.message.content;

                        if (typeof tempText === 'string' && tempText.length < 100) {
                             const lower = tempText.toLowerCase();
                             if (lower.includes('credit') || lower.includes('quota') || lower.includes('insufficient')) {
                                 throw new Error("Credit limit reached");
                             }
                        }

                        response = result;
                        break; // Success

                    } catch (err) {
                        console.warn(`Puter Token ending in ...${token.slice(-4)} failed: ${err.message}`);
                        lastError = err;
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
