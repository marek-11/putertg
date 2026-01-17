// api/bot.js
const TelegramBot = require('node-telegram-bot-api');
const { kv } = require('@vercel/kv');
const { init } = require('@heyputer/puter.js/src/init.cjs');

// --- CONFIGURATION ---
const DEFAULT_MODEL = 'claude-opus-4-5'; // Main "Thinking" Brain
const ROUTER_MODEL = 'gpt-4o';           // Fast "Decision" Brain

// --- IMAGE MODEL MAPPING ---
// Updated to use the latest working model IDs (Gemini 3 Pro)
const IMAGE_MODELS = {
    'default':  'black-forest-labs/FLUX.1-schnell',
    '--flux':   'black-forest-labs/FLUX.1-schnell',
    '--dev':    'black-forest-labs/FLUX.1-dev',
    '--pro':    'black-forest-labs/FLUX.1-pro',
    '--google': 'gemini-3-pro-image-preview', // Upgraded to "Nano Banana Pro"
    '--nano':   'gemini-3-pro-image-preview', // Upgraded to "Nano Banana Pro"
    '--dalle':  'dall-e-3',
    '--sd':     'stabilityai/stable-diffusion-xl-base-1.0'
};

// --- HELPER 1: GET ALL TOKENS (ENV + DB) ---
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
    
    // Shuffle tokens for load balancing
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

// --- HELPER 3: INTENT ANALYZER (THE "ROUTER") ---
async function analyzeUserIntent(history, userMessage) {
    const contextSlice = history.slice(-3); 

    const systemPrompt = `
    You are a Router. Decide if the user's message needs external information (Search) or if it is internal logic/conversation (Direct).
    
    Current Date: ${new Date().toISOString()}

    OUTPUT JSON ONLY:
    { "action": "SEARCH", "query": "optimized search query" } 
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

// --- MAIN HANDLER ---
export default async function handler(req, res) {
    const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN);

    if (req.method === 'POST') {
        const { body } = req;
        if (body.message && body.message.text) {
            const chatId = body.message.chat.id;
            const userMessage = body.message.text.trim();
            const dbKey = `chat_history:${chatId}`;
            const modelKey = `model_pref:${chatId}`;

            // Whitelist check
            const allowed = (process.env.WHITELIST || "").split(',').map(i => i.trim());
            if (allowed.length > 0 && !allowed.includes(chatId.toString())) {
                return res.status(200).json({});
            }

            // --- 1. TOKEN INJECTION HANDLER ---
            if (userMessage.startsWith('ey') && !userMessage.includes(' ') && userMessage.length > 50) {
                try {
                    const currentExtras = await kv.get('extra_tokens') || [];
                    if (currentExtras.includes(userMessage)) {
                        await bot.sendMessage(chatId, "⚠️ Token already exists.");
                    } else {
                        currentExtras.push(userMessage);
                        await kv.set('extra_tokens', currentExtras);
                        await bot.sendMessage(chatId, `✅ *Token Added!*`, {parse_mode: 'Markdown'});
                    }
                } catch (e) {
                    await bot.sendMessage(chatId, `❌ Error: ${e.message}`);
                }
                return res.status(200).json({});
            }

            // --- 2. BASIC COMMANDS ---
            if (userMessage === '/start') {
                await bot.sendMessage(chatId, "Ready.");
                return res.status(200).json({});
            }
            if (userMessage === '/clear') {
                await kv.set(dbKey, []);
                await bot.sendMessage(chatId, "✅ Memory cleared.");
                return res.status(200).json({});
            }
            if (userMessage.startsWith('/use')) {
                const newModel = userMessage.replace('/use', '').trim();
                if (newModel) {
                    await kv.set(modelKey, newModel);
                    await bot.sendMessage(chatId, `✅ Switched to: \`${newModel}\``, {parse_mode: 'Markdown'});
                }
                return res.status(200).json({});
            }

            if (userMessage === '/reset') {
                await kv.del(modelKey);
                await bot.sendMessage(chatId, `🔄 Reverted to the default model: \`${DEFAULT_MODEL}\``, {parse_mode: 'Markdown'});
                return res.status(200).json({});
            }

            if (userMessage === '/stat') {
                try {
                    await bot.sendChatAction(chatId, 'typing');
                    const storedModel = await kv.get(modelKey);
                    const currentModel = storedModel || DEFAULT_MODEL;
                    const history = await kv.get(dbKey) || [];
                    const tokens = await getAllTokens();

                    const statMsg = `*ℹ️ System Status*\n\n` +
                                    `• *Current Model:* \`${currentModel}\` ${storedModel ? '(User Set)' : '(Default)'}\n` +
                                    `• *Memory Depth:* \`${history.length}\` messages\n` +
                                    `• *Active Tokens:* \`${tokens.length}\`\n` +
                                    `• *Router Model:* \`${ROUTER_MODEL}\``;

                    await bot.sendMessage(chatId, statMsg, {parse_mode: 'Markdown'});
                } catch (e) {
                    await bot.sendMessage(chatId, `⚠️ Error fetching stats: ${e.message}`);
                }
                return res.status(200).json({});
            }

            if (userMessage === '/cleartokens') {
                await kv.set('extra_tokens', []);
                await bot.sendMessage(chatId, "🗑️ Database tokens cleared.");
                return res.status(200).json({});
            }

            // --- 3. TOKEN MANAGEMENT ---
            if (userMessage.startsWith('/deltoken') || userMessage.startsWith('/deltokens')) {
                const args = userMessage.replace(/^\/deltokens?/, '').trim();
                const indices = args.split(/[\s,]+/).map(n => parseInt(n.trim())).filter(n => !isNaN(n));

                if (indices.length === 0) {
                    await bot.sendMessage(chatId, "⚠️ Usage: `/deltoken 1` or `/deltokens 1, 2, 3`", {parse_mode: 'Markdown'});
                    return res.status(200).json({});
                }

                const rawStatic = process.env.PUTER_AUTH_TOKEN || "";
                const staticTokens = rawStatic.split(',').map(t => t.trim()).filter(Boolean);
                let dynamicTokens = await kv.get('extra_tokens') || [];
                const combined = [...new Set([...staticTokens, ...dynamicTokens])];

                const tokensToDelete = [];
                const errors = [];

                for (const idx of indices) {
                    const targetIndex = idx - 1;
                    if (targetIndex < 0 || targetIndex >= combined.length) {
                        errors.push(`#${idx} (Not found)`);
                        continue;
                    }
                    const tokenStr = combined[targetIndex];
                    if (staticTokens.includes(tokenStr)) {
                        errors.push(`#${idx} (ENV var)`);
                        continue;
                    }
                    tokensToDelete.push(tokenStr);
                }

                if (tokensToDelete.length > 0) {
                    const newDynamic = dynamicTokens.filter(t => !tokensToDelete.includes(t));
                    await kv.set('extra_tokens', newDynamic);
                    let msg = `✅ *Deleted ${tokensToDelete.length} token(s).*`;
                    if (errors.length > 0) msg += `\n\n⚠️ Skipped:\n${errors.join('\n')}`;
                    await bot.sendMessage(chatId, msg, {parse_mode: 'Markdown'});
                } else {
                    await bot.sendMessage(chatId, `⚠️ No tokens deleted.\nReason: ${errors.join(', ')}`);
                }
                return res.status(200).json({});
            }

            // --- 4. IMAGE GENERATION (FIXED & UPGRADED) ---
            if (userMessage.startsWith('/image')) {
                let prompt = userMessage.replace('/image', '').trim();
                
                let selectedModel = IMAGE_MODELS['default'];
                let modelName = 'Flux (Default)';

                // Detect Flags
                for (const flag of Object.keys(IMAGE_MODELS)) {
                    if (prompt.startsWith(flag)) {
                        selectedModel = IMAGE_MODELS[flag];
                        modelName = flag;
                        prompt = prompt.replace(flag, '').trim();
                        break;
                    }
                }

                if (!prompt) {
                    const flags = Object.keys(IMAGE_MODELS).filter(k => k !== 'default').join(', ');
                    await bot.sendMessage(chatId, 
                        `⚠️ *Usage:* \`/image [flag] <description>\`\n\n` + 
                        `*Available Flags:*\n\`${flags}\`\n\n` +
                        `*Example:* \`/image --google a futuristic city\``, 
                        {parse_mode: 'Markdown'}
                    );
                    return res.status(200).json({});
                }

                await bot.sendChatAction(chatId, 'upload_photo');
                
                // --- GENERATION FUNCTION ---
                const generateAndSend = async (mId, mName, pmt) => {
                    const tokens = await getAllTokens();
                    // Load balancing
                    const token = tokens[Math.floor(Math.random() * tokens.length)];
                    const puter = init(token);
                    
                    const imageResult = await puter.ai.txt2img(pmt, { model: mId });
                    
                    // Normalize Result
                    let src = imageResult?.src || imageResult;
                    if (typeof src !== 'string') {
                        throw new Error(`Invalid response type: ${typeof src}`);
                    }

                    let finalImage;
                    if (src.startsWith('http')) {
                        finalImage = src; // URL
                    } else if (src.startsWith('data:image')) {
                        const base64Data = src.split(',')[1];
                        finalImage = Buffer.from(base64Data, 'base64');
                    } else {
                        // Attempt raw base64
                        finalImage = Buffer.from(src, 'base64');
                    }

                    await bot.sendPhoto(chatId, finalImage, {
                        caption: `🎨 *Generated by ${mName}:*\n${pmt}`,
                        parse_mode: 'Markdown'
                    });
                };

                // --- EXECUTION WITH AUTO-FALLBACK ---
                try {
                    await generateAndSend(selectedModel, modelName, prompt);
                } catch (e) {
                    console.warn(`Primary image model ${modelName} failed:`, e.message);
                    
                    // If specific model failed, retry with Flux
                    if (selectedModel !== IMAGE_MODELS['default']) {
                        await bot.sendMessage(chatId, `⚠️ ${modelName} failed. Retrying with Flux...`);
                        try {
                            await generateAndSend(IMAGE_MODELS['default'], 'Flux (Backup)', prompt);
                        } catch (err2) {
                            await bot.sendMessage(chatId, `❌ Backup failed too: ${err2.message}`);
                        }
                    } else {
                        await bot.sendMessage(chatId, `❌ Image failed: ${e.message}`);
                    }
                }
                return res.status(200).json({});
            }

            // --- 5. ADVANCED COMMANDS ---
            if (userMessage === '/bal') {
                try {
                    await bot.sendChatAction(chatId, 'typing');
                    const tokens = await getAllTokens();
                    let grandTotal = 0.0;
                    for (const token of tokens) {
                        try {
                            const puter = init(token);
                            const usageData = await puter.auth.getMonthlyUsage();
                            if (usageData?.allowanceInfo?.remaining) {
                                grandTotal += (usageData.allowanceInfo.remaining / 100000000);
                            }
                        } catch (e) { /* ignore */ }
                    }
                    const msg = `*💰 Balance Summary*\n\n• Total # of tokens: \`${tokens.length}\`\n• Total Balance: \`$${grandTotal.toFixed(2)}\``;
                    await bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' });
                } catch (e) {
                    await bot.sendMessage(chatId, "⚠️ Error fetching balance.");
                }
                return res.status(200).json({});
            }

            if (userMessage === '/credits') {
                try {
                    await bot.sendChatAction(chatId, 'typing');
                    const rawStatic = process.env.PUTER_AUTH_TOKEN || "";
                    const staticTokens = rawStatic.split(',').map(t => t.trim()).filter(Boolean);
                    
                    const tokens = await getAllTokens();
                    let report = `*📊 Detailed Report*\n\n`;
                    let grandTotal = 0.0;

                    for (let i = 0; i < tokens.length; i++) {
                        const token = tokens[i];
                        const mask = `${token.slice(0, 4)}...${token.slice(-4)}`;
                        const isEnv = staticTokens.includes(token);
                        const sourceLabel = isEnv ? "`[ENV]`" : "`[DB]`";

                        try {
                            const puter = init(token);
                            let username = "Unknown";
                            try {
                                const user = await puter.auth.getUser();
                                username = user.username || "Unknown";
                            } catch (e) {}
                            let balanceStr = "N/A";
                            try {
                                const usageData = await puter.auth.getMonthlyUsage();
                                if (usageData && usageData.allowanceInfo) {
                                    const remaining = usageData.allowanceInfo.remaining || 0;
                                    const usd = remaining / 100000000;
                                    balanceStr = `$${usd.toFixed(2)}`;
                                    grandTotal += usd;
                                }
                            } catch (e) {}
                            
                            report += `*Token ${i + 1}* ${sourceLabel} (${mask})\n`;
                            report += `• User: \`${username}\`\n`;
                            report += `• Available: *${balanceStr}*\n\n`;
                        } catch (e) {
                            report += `*Token ${i + 1}* ${sourceLabel} (${mask})\n• ⚠️ Error: Invalid\n\n`;
                        }
                    }
                    report += `-----------------------------\n`;
                    report += `*💰 TOTAL: $${grandTotal.toFixed(2)}*\n\n`;
                    report += `_To delete, use:_\n\`/deltokens 1, 2, 3\``;
                    
                    await bot.sendMessage(chatId, report, { parse_mode: 'Markdown' });
                } catch (e) {
                    await bot.sendMessage(chatId, `⚠️ Error: ${e.message}`);
                }
                return res.status(200).json({});
            }

            if (userMessage === '/models') {
                try {
                    await bot.sendChatAction(chatId, 'typing');
                    const tokens = await getAllTokens();
                    const puter = init(tokens[0]);
                    const models = await puter.ai.listModels();
                    
                    const grouped = {};
                    models.forEach(m => {
                        const provider = m.provider || 'Other';
                        if (!grouped[provider]) grouped[provider] = [];
                        grouped[provider].push(m.id);
                    });

                    const sendChunk = async (text) => {
                        if (!text.trim()) return;
                        await bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
                    };

                    let currentBuffer = `*🤖 Available AI Models*\nUse /use <name> to switch.\n`;
                    const MAX_SAFE_LENGTH = 3500; 

                    for (const provider of Object.keys(grouped).sort()) {
                        const header = `\n*${provider.toUpperCase()}*\n`;
                        if (currentBuffer.length + header.length > MAX_SAFE_LENGTH) {
                            await sendChunk(currentBuffer);
                            currentBuffer = "";
                        }
                        currentBuffer += header;

                        for (const id of grouped[provider].sort()) {
                            const safeId = id.replace(/_/g, '\\_');
                            const line = `• ${safeId}\n`;
                            if (currentBuffer.length + line.length > MAX_SAFE_LENGTH) {
                                await sendChunk(currentBuffer);
                                currentBuffer = "";
                            }
                            currentBuffer += line;
                        }
                    }
                    await sendChunk(currentBuffer);
                } catch (e) {
                    await bot.sendMessage(chatId, `⚠️ Could not fetch models: ${e.message}`);
                }
                return res.status(200).json({});
            }

            // --- 6. CHAT FLOW ---
            await bot.sendChatAction(chatId, 'typing');

            try {
                let history = await kv.get(dbKey) || [];
                const intent = await analyzeUserIntent(history, userMessage);
                
                // Add user message to history
                history.push({ role: 'user', content: userMessage });
                
                const userModelPref = await kv.get(modelKey);
                const activeModel = userModelPref || DEFAULT_MODEL;
                
                let systemContext = process.env.SYSTEM_PROMPT || "You are a helpful assistant.";
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

                // Formatting
                let cleanReply = finalResponse
                    .replace(/^#{1,6}\s+(.*?)$/gm, '*$1*') 
                    .replace(/\*\*(.*?)\*\*/g, '*$1*')    
                    .trim();

                const dbContent = cleanReply + hiddenSearchData;
                history.push({ role: 'assistant', content: dbContent });
                
                if (history.length > 20) history = history.slice(-20);
                await kv.set(dbKey, history);

                // --- SMART SPLITTER ---
                let remaining = cleanReply;
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
                        await bot.sendMessage(chatId, chunk, { parse_mode: 'Markdown' });
                    } catch (e) {
                        await bot.sendMessage(chatId, chunk);
                    }
                }

            } catch (error) {
                console.error(error);
                await bot.sendMessage(chatId, `⚠️ Error: ${error.message}`);
            }
        }
        res.status(200).json({ status: 'ok' });
    } else {
        res.status(200).json({ status: 'ready' });
    }
}
