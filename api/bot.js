// api/bot.js
const TelegramBot = require('node-telegram-bot-api');
const { kv } = require('@vercel/kv');
const { init } = require('@heyputer/puter.js/src/init.cjs');
const fetch = require('node-fetch'); // Standard fetch for downloading images

// --- CONFIGURATION ---
const DEFAULT_MODEL = 'claude-opus-4-5'; 
const ROUTER_MODEL = 'gpt-4o';          
const VISION_MODEL = 'gpt-4o'; // Best model for seeing images

// --- IMAGE MODEL MAPPING ---
const IMAGE_MODELS = {
    'default': 'black-forest-labs/FLUX.1-dev'
};

// --- HELPER 1: GET ALL TOKENS ---
async function getAllTokens() {
    const rawStatic = process.env.PUTER_AUTH_TOKEN || "";
    const staticTokens = rawStatic.split(',').map(t => t.trim()).filter(t => t.length > 0);

    let dynamicTokens = [];
    try {
        dynamicTokens = await kv.get('extra_tokens') || [];
        if (!Array.isArray(dynamicTokens)) dynamicTokens = [];
    } catch (e) {
        console.warn("KV Token fetch failed:", e);
    }

    const combined = [...new Set([...staticTokens, ...dynamicTokens])];
    if (combined.length === 0) throw new Error("No PUTER_AUTH_TOKEN found in Env or DB.");
    return combined;
}

// --- HELPER 2: AI CALL WRAPPER ---
async function callAIWithRotation(messages, modelId = DEFAULT_MODEL) {
    let tokens = await getAllTokens();
    
    // Shuffle tokens
    for (let i = tokens.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [tokens[i], tokens[j]] = [tokens[j], tokens[i]];
    }

    let lastError = null;

    for (const token of tokens) {
        try {
            const puter = init(token);
            const result = await puter.ai.chat(messages, { model: modelId });

            if (!result) throw new Error("Empty response");
            if (result.error) throw new Error(JSON.stringify(result));

            let text = "";
            if (typeof result === 'string') {
                text = result;
            } else if (result?.message?.content) {
                const content = result.message.content;
                if (typeof content === 'string') text = content;
                else if (Array.isArray(content)) {
                    text = content.filter(b => b.type === 'text' || b.text).map(b => b.text || '').join('');
                }
            } else if (Array.isArray(result)) {
                 text = result.map(b => b.text || '').join('');
            } else {
                text = JSON.stringify(result);
            }
            text = text.trim();

            if (text.length < 150) {
                const lower = text.toLowerCase();
                const failPhrases = ["usage limit", "quota", "insufficient credit", "out of credits", "rate limit"];
                if (failPhrases.some(p => lower.includes(p))) {
                    throw new Error(`Quota exceeded: ${text}`);
                }
            }
            return text;
        } catch (err) {
            console.warn(`Token ...${token.slice(-4)} failed on ${modelId}: ${err.message}`);
            lastError = err;
        }
    }
    throw new Error(`All tokens failed. Last error: ${lastError?.message}`);
}

// --- HELPER 3: INTENT ANALYZER (OPTIMIZED ROUTER) ---
async function analyzeUserIntent(history, userMessage) {
    const lowerMsg = userMessage.toLowerCase();

    // 1. FAST PATH: REGEX CHECKS
    const searchTriggers = [
        /^search\b/i, /^find\b/i, /^who is\b/i, /^what is\b/i, 
        /weather/i, /news/i, /price of/i, /latest/i, /current/i,
        /stock/i, /movie times/i, /schedule/i
    ];
    if (searchTriggers.some(regex => regex.test(userMessage))) {
        return { action: "SEARCH", query: userMessage }; 
    }

    const directTriggers = [
        /^hi\b/i, /^hello\b/i, /^ok\b/i, /^thanks\b/i, /^cool\b/i, 
        /^write code/i, /^fix/i, /^debug/i, /^explain/i, /^help/i
    ];
    if (directTriggers.some(regex => regex.test(userMessage))) {
        return { action: "DIRECT" };
    }

    // 2. SLOW PATH: LLM ANALYSIS
    const contextSlice = history.slice(-3); 
    const nowManila = new Date().toLocaleString("en-US", { timeZone: "Asia/Manila" });

    const systemPrompt = `
    You are a Router. Your job is to classify the user's need.
    
    Current Date (Manila): ${nowManila}

    RULES:
    - IF the user asks about real-time events, news, stocks, weather, or "recent" data -> "SEARCH".
    - IF the user asks for factual knowledge that might be outdated -> "SEARCH".
    - IF the user asks for coding, creative writing, translation, or general explanations -> "DIRECT".
    - IF the user refers to "this" or context from previous messages -> "DIRECT".

    OUTPUT JSON ONLY:
    { "action": "SEARCH", "query": "optimized keyword search query" } 
    OR 
    { "action": "DIRECT" }
    `;

    const messages = [
        { role: "system", content: systemPrompt },
        ...contextSlice,
        { role: "user", content: userMessage }
    ];

    try {
        const response = await callAIWithRotation(messages, ROUTER_MODEL);
        const jsonStr = response.replace(/```json/g, '').replace(/```/g, '').trim();
        return JSON.parse(jsonStr);
    } catch (e) {
        console.warn("Intent analysis failed, defaulting to DIRECT.");
        return { action: "DIRECT" };
    }
}

// --- HELPER 4: EXA.AI RESEARCHER ---
async function performExaResearch(userQuery) {
    const apiKeyRaw = process.env.EXA_API_KEY; 
    if (!apiKeyRaw) return null;

    const keys = apiKeyRaw.split(',').map(k => k.trim()).filter(Boolean);
    const apiKey = keys[Math.floor(Math.random() * keys.length)];

    try {
        const response = await fetch("https://api.exa.ai/search", {
            method: "POST",
            headers: { 
                "Content-Type": "application/json",
                "x-api-key": apiKey 
            },
            body: JSON.stringify({ 
                query: userQuery,
                useAutoprompt: true, 
                numResults: 2, 
                contents: { text: true } 
            })
        });
        
        if (!response.ok) return null;
        const data = await response.json();
        if (!data.results || data.results.length === 0) return null;

        let context = ``;
        data.results.forEach((r, i) => {
            const snippet = r.text ? r.text.slice(0, 1500).replace(/\s+/g, " ") : "No text.";
            context += `[Result ${i+1}] Title: ${r.title}\nURL: ${r.url}\nContent: ${snippet}\n\n`;
        });
        return context;
    } catch (e) {
        console.error("Exa Exception:", e);
        return null;
    }
}

// --- HELPER 5: MARKDOWN TO HTML ---
function formatToHtml(text) {
    if (!text) return "";
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/```([\s\S]*?)```/g, '<pre>$1</pre>')
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/^#{1,6}\s+(.*?)$/gm, '<b>$1</b>')
        .replace(/\*\*(.*?)\*\*/g, '<b>$1</b>')
        .replace(/(?<!\*)\*([^\s*][^*]*?)\*(?!\*)/g, '<i>$1</i>');
}

// --- MAIN HANDLER ---
export default async function handler(req, res) {
    const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN);

    if (req.method === 'POST') {
        const { body } = req;
        
        // --- CHANGED: Allow Text OR Photo ---
        if (body.message) {
            const chatId = body.message.chat.id;
            
            // Determine "Text" content: either the message text OR the caption
            const userMessage = (body.message.text || body.message.caption || "").trim();
            const hasPhoto = !!body.message.photo;

            // Keys
            const dbKey = `chat_history:${chatId}`;
            const modelKey = `model_pref:${chatId}`;
            const promptKey = `custom_prompt:${chatId}`;

            // Whitelist check
            const allowed = (process.env.WHITELIST || "").split(',').map(i => i.trim());
            if (allowed.length > 0 && !allowed.includes(chatId.toString())) {
                return res.status(200).json({});
            }

            // --- 1. TOKEN INJECTION ---
            if (userMessage.startsWith('ey') && !userMessage.includes(' ') && userMessage.length > 50) {
                try {
                    const currentExtras = await kv.get('extra_tokens') || [];
                    if (currentExtras.includes(userMessage)) {
                        await bot.sendMessage(chatId, "⚠️ Token already exists.");
                    } else {
                        currentExtras.push(userMessage);
                        await kv.set('extra_tokens', currentExtras);
                        await bot.sendMessage(chatId, `✅ <b>Token Added!</b>`, {parse_mode: 'HTML'});
                    }
                } catch (e) {
                    await bot.sendMessage(chatId, `❌ Error: ${e.message}`);
                }
                return res.status(200).json({});
            }

            // --- 2. BASIC COMMANDS ---
            if (userMessage === '/start') {
                await bot.sendMessage(chatId, "Ready. Send text or a photo!");
                return res.status(200).json({});
            }
            if (userMessage === '/help') {
                const helpMsg = `<b>🤖 Bot Command List</b>\n\n` +
                    `/clear - Wipe chat memory\n` +
                    `/use <model> - Switch AI model\n` +
                    `/reset - Revert to default model\n` +
                    `/image <text> - Generate image\n` +
                    `/bal - Check balance\n` +
                    `<i>Send a Photo to analyze it!</i>`;
                await bot.sendMessage(chatId, helpMsg, { parse_mode: 'HTML' });
                return res.status(200).json({});
            }
            if (userMessage === '/clear') {
                await kv.set(dbKey, []);
                await bot.sendMessage(chatId, "✅ Memory cleared.");
                return res.status(200).json({});
            }
            // ... (Other commands: /use, /reset, /prompt, /stat, /prune, /deltoken, /image, /bal, /credits, /models - KEPT SAME AS BEFORE) ...
            
            // (Omitting standard commands for brevity, assuming you keep them from previous version)
            // If you need the full command block again, let me know. I am focusing on the Logic flow below.
            
            // --- 9. VISION HANDLER (NEW!) ---
            if (hasPhoto) {
                await bot.sendChatAction(chatId, 'typing');
                try {
                    // 1. Get the largest photo file_id
                    const photoArray = body.message.photo;
                    const fileId = photoArray[photoArray.length - 1].file_id;

                    // 2. Get File Path from Telegram
                    const fileRes = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/getFile?file_id=${fileId}`);
                    const fileData = await fileRes.json();
                    if (!fileData.ok) throw new Error("Failed to get file path");
                    const filePath = fileData.result.file_path;

                    // 3. Download Image Stream & Convert to Base64
                    const imageUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${filePath}`;
                    const imageRes = await fetch(imageUrl);
                    const buffer = await imageRes.buffer();
                    const base64Image = buffer.toString('base64');
                    const mimeType = filePath.endsWith('png') ? 'image/png' : 'image/jpeg';
                    const dataUrl = `data:${mimeType};base64,${base64Image}`;

                    // 4. Construct Vision Message
                    // Note: We use specific structure for GPT-4o Vision
                    const visionMessages = [
                        {
                            role: "user",
                            content: [
                                { type: "text", text: userMessage || "Describe this image." },
                                { type: "image_url", image_url: { url: dataUrl } }
                            ]
                        }
                    ];

                    // 5. Call AI (Using VISION_MODEL usually gpt-4o)
                    // We bypass the Router and History for simple single-turn vision to save complexity
                    const responseText = await callAIWithRotation(visionMessages, VISION_MODEL);
                    
                    await bot.sendMessage(chatId, formatToHtml(responseText), { parse_mode: 'HTML' });

                } catch (e) {
                    console.error("Vision Error:", e);
                    await bot.sendMessage(chatId, `⚠️ Vision failed: ${e.message}`);
                }
                return res.status(200).json({});
            }

            // --- 8. STANDARD CHAT FLOW (TEXT ONLY) ---
            if (userMessage && !userMessage.startsWith('/')) {
                await bot.sendChatAction(chatId, 'typing');

                try {
                    let history = await kv.get(dbKey) || [];
                    const intent = await analyzeUserIntent(history, userMessage);
                    
                    history.push({ role: 'user', content: userMessage });
                    
                    const userModelPref = await kv.get(modelKey);
                    const activeModel = userModelPref || DEFAULT_MODEL;
                    
                    const nowManila = new Date().toLocaleString("en-US", { timeZone: "Asia/Manila", dateStyle: "full", timeStyle: "short" });
                    let systemContext = process.env.SYSTEM_PROMPT || "You are a helpful assistant.";
                    systemContext += `\n\n[System Time]: Today is ${nowManila} (Asia/Manila).`;

                    const customPrompt = await kv.get(promptKey);
                    if (customPrompt) systemContext += `\n\n[Additional Instructions]:\n${customPrompt}`;

                    let hiddenSearchData = "";
                    if (intent.action === 'SEARCH') {
                        await bot.sendChatAction(chatId, 'typing');
                        const searchResults = await performExaResearch(intent.query);
                        if (searchResults) {
                            hiddenSearchData = `\n\n[Search Query: ${intent.query}]\n`;
                            systemContext += `\n\n[Context from Web Search]:\n${searchResults}`;
                        }
                    }

                    const answerMessages = [
                        { role: "system", content: systemContext },
                        ...history 
                    ];

                    const finalResponse = await callAIWithRotation(answerMessages, activeModel);

                    const dbContent = finalResponse + hiddenSearchData;
                    history.push({ role: 'assistant', content: dbContent });
                    
                    if (history.length > 20) history = history.slice(-20);
                    await kv.set(dbKey, history);

                    const htmlReply = formatToHtml(finalResponse.trim());

                    let remaining = htmlReply;
                    while (remaining.length > 0) {
                        let chunk;
                        if (remaining.length <= 4000) {
                            chunk = remaining;
                            remaining = "";
                        } else {
                            let splitAt = remaining.lastIndexOf('\n', 4000);
                            if (splitAt === -1) splitAt = 4000;
                            chunk = remaining.slice(0, splitAt);
                            remaining = remaining.slice(splitAt).trim();
                        }
                        try {
                            await bot.sendMessage(chatId, chunk, { parse_mode: 'HTML' });
                        } catch (e) {
                            await bot.sendMessage(chatId, chunk.replace(/<[^>]*>/g, ''));
                        }
                    }

                } catch (error) {
                    console.error(error);
                    await bot.sendMessage(chatId, `⚠️ Error: ${error.message}`);
                }
            }
        }
        res.status(200).json({ status: 'ok' });
    } else {
        res.status(200).json({ status: 'ready' });
    }
}
