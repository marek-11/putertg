// api/bot.js
const TelegramBot = require('node-telegram-bot-api');
const { kv } = require('@vercel/kv');
const { init } = require('@heyputer/puter.js/src/init.cjs');

// --- CONFIGURATION ---
const DEFAULT_MODEL = 'claude-opus-4-5'; // Main "Thinking" Brain
const ROUTER_MODEL = 'gpt-4o';           // Fast "Decision" Brain

// --- IMAGE MODEL MAPPING ---
// Default set to Flux Dev (High Quality).
const IMAGE_MODELS = {
    'default': 'black-forest-labs/FLUX.1-dev'
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
    
    // FIX 1: Get Manila Time for the Router
    const nowManila = new Date().toLocaleString("en-US", { timeZone: "Asia/Manila" });

    const systemPrompt = `
    You are a Router. Decide if the user's message needs external information (Search) or if it is internal logic/conversation (Direct).
    
    Current Date (Manila): ${nowManila}

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

// --- HELPER 4: EXA.AI RESEARCHER (UPDATED) ---
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
                numResults: 7, // UPDATED: Increased to 7 results
                contents: { text: true } 
            })
        });
        
        if (!response.ok) return null;

        const data = await response.json();
        if (!data.results || data.results.length === 0) return null;

        let context = ``;
        data.results.forEach((r, i) => {
            // UPDATED: Reduced slice to 1000 to prevent context overflow
            const snippet = r.text ? r.text.slice(0, 1000).replace(/\s+/g, " ") : "No text.";
            context += `[Result ${i+1}] Title: ${r.title}\nURL: ${r.url}\nContent: ${snippet}\n\n`;
        });
        
        return context;
    } catch (e) {
        console.error("Exa Exception:", e);
        return null;
    }
}

// --- HELPER 5: MARKDOWN TO HTML CONVERTER ---
function formatToHtml(text) {
    if (!text) return "";
    return text
        // 1. Escape HTML reserved characters
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        // 2. Code Blocks (```code```) -> <pre>
        .replace(/```([\s\S]*?)```/g, '<pre>$1</pre>')
        // 3. Inline Code (`code`) -> <code>
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        // 4. Headers (# Header) -> <b>
        .replace(/^#{1,6}\s+(.*?)$/gm, '<b>$1</b>')
        // 5. Bold (**Text**) -> <b>
        .replace(/\*\*(.*?)\*\*/g, '<b>$1</b>')
        // 6. Italic (*Text*) -> <i> (Avoid matching list bullets like * Item)
        .replace(/(?<!\*)\*([^\s*][^*]*?)\*(?!\*)/g, '<i>$1</i>');
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
            const promptKey = `custom_prompt:${chatId}`;

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
                        await bot.sendMessage(chatId, `✅ <b>Token Added!</b>`, {parse_mode: 'HTML'});
                    }
                } catch (e) {
                    await bot.sendMessage(chatId, `❌ Error: ${e.message}`);
                }
                return res.status(200).json({});
            }

            // --- 2. BASIC COMMANDS & HELP ---
            if (userMessage === '/start') {
                await bot.sendMessage(chatId, "Ready. Type /help to see what I can do.");
                return res.status(200).json({});
            }

            if (userMessage === '/help') {
                const helpMsg = `<b>🤖 Bot Command List</b>\n\n` +
                    `<b>🔹 Basic</b>\n` +
                    `/start - Check if bot is alive\n` +
                    `/clear - Wipe chat memory\n` +
                    `/help - Show this menu\n\n` +

                    `<b>🧠 AI & Models</b>\n` +
                    `/use &lt;model&gt; - Switch AI model\n` +
                    `/reset - Revert to default model\n` +
                    `/models - List all available models\n` +
                    `/stat - Show current model & stats\n\n` +

                    `<b>📝 Custom Instructions</b>\n` +
                    `/prompt set &lt;text&gt; - Set custom system behavior\n` +
                    `/prompt - View current custom prompt\n` +
                    `/clearprompt - Remove custom prompt\n\n` +

                    `<b>🎨 Creative</b>\n` +
                    `/image &lt;text&gt; - Generate an image (Flux Dev)\n\n` +

                    `<b>💳 Tokens & Balance</b>\n` +
                    `/bal - Quick balance summary\n` +
                    `/credits - Detailed token usage report\n` +
                    `/prune - Auto-delete empty tokens ($0.00)\n` +
                    `/deltoken &lt;id&gt; - Delete a specific token\n` +
                    `<i>(Send a raw token string to add it)</i>`;

                await bot.sendMessage(chatId, helpMsg, { parse_mode: 'HTML' });
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
                    await bot.sendMessage(chatId, `✅ Switched to: <code>${newModel}</code>`, {parse_mode: 'HTML'});
                }
                return res.status(200).json({});
            }

            if (userMessage === '/reset') {
                await kv.del(modelKey);
                await bot.sendMessage(chatId, `🔄 Reverted to the default model: <code>${DEFAULT_MODEL}</code>`, {parse_mode: 'HTML'});
                return res.status(200).json({});
            }

            // --- 3. PROMPT MANAGEMENT ---
            if (userMessage.startsWith('/prompt')) {
                const input = userMessage.replace(/^\/prompt\s+(set\s+)?/i, '').trim();
                if (!input) {
                    const current = await kv.get(promptKey);
                    if (current) {
                        await bot.sendMessage(chatId, `<b>📜 Current Custom Prompt:</b>\n\n<code>${formatToHtml(current)}</code>`, { parse_mode: 'HTML' });
                    } else {
                        await bot.sendMessage(chatId, `ℹ️ No custom prompt set. Using default system behavior.`);
                    }
                } else {
                    await kv.set(promptKey, input);
                    await bot.sendMessage(chatId, `✅ <b>Custom Prompt Set!</b>\n\nIt will be appended to the system instructions.`, { parse_mode: 'HTML' });
                }
                return res.status(200).json({});
            }

            if (userMessage === '/clearprompt') {
                await kv.del(promptKey);
                await bot.sendMessage(chatId, "🔄 <b>Custom prompt cleared.</b> Reverted to global defaults.", { parse_mode: 'HTML' });
                return res.status(200).json({});
            }

            // --- 4. STATS & CLEANUP ---
            if (userMessage === '/stat') {
                try {
                    await bot.sendChatAction(chatId, 'typing');
                    const storedModel = await kv.get(modelKey);
                    const currentModel = storedModel || DEFAULT_MODEL;
                    const history = await kv.get(dbKey) || [];
                    const tokens = await getAllTokens();
                    const customPrompt = await kv.get(promptKey);

                    let statMsg = `<b>ℹ️ System Status</b>\n\n` +
                                    `• <b>Current Model:</b> <code>${currentModel}</code> ${storedModel ? '(User Set)' : '(Default)'}\n` +
                                    `• <b>Memory Depth:</b> <code>${history.length}</code> messages\n` +
                                    `• <b>Active Tokens:</b> <code>${tokens.length}</code>\n` +
                                    `• <b>Router Model:</b> <code>${ROUTER_MODEL}</code>`;
                    
                    if (customPrompt) statMsg += `\n• <b>Custom Prompt:</b> Active ✅`;

                    await bot.sendMessage(chatId, statMsg, {parse_mode: 'HTML'});
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

            // --- NEW: PRUNE COMMAND ---
            if (userMessage === '/prune') {
                await bot.sendChatAction(chatId, 'typing');
                const dynamicTokens = await kv.get('extra_tokens') || [];

                if (dynamicTokens.length === 0) {
                    await bot.sendMessage(chatId, "ℹ️ No database tokens to prune.");
                    return res.status(200).json({});
                }

                await bot.sendMessage(chatId, `⏳ <b>Checking ${dynamicTokens.length} tokens...</b>`, {parse_mode: 'HTML'});

                // Parallel check for speed
                const results = await Promise.all(dynamicTokens.map(async (token) => {
                    try {
                        const puter = init(token);
                        const usage = await puter.auth.getMonthlyUsage();
                        const remaining = usage?.allowanceInfo?.remaining;
                        // Return null if balance is 0 or less
                        if (typeof remaining === 'number' && remaining <= 0) return null;
                        return token;
                    } catch (e) {
                        // If check fails (network/auth), keep token to be safe
                        return token;
                    }
                }));

                const keptTokens = results.filter(t => t !== null);
                const removedCount = dynamicTokens.length - keptTokens.length;

                if (removedCount > 0) {
                    await kv.set('extra_tokens', keptTokens);
                    await bot.sendMessage(chatId, `✂️ <b>Prune Complete!</b>\n\n🗑️ Deleted: <code>${removedCount}</code> empty tokens.\n✅ Remaining: <code>${keptTokens.length}</code> valid tokens.`, {parse_mode: 'HTML'});
                } else {
                    await bot.sendMessage(chatId, "✅ <b>No empty tokens found.</b>");
                }
                return res.status(200).json({});
            }

            // --- 5. MANUAL TOKEN DELETION ---
            if (userMessage.startsWith('/deltoken') || userMessage.startsWith('/deltokens')) {
                const args = userMessage.replace(/^\/deltokens?/, '').trim();
                const indices = args.split(/[\s,]+/).map(n => parseInt(n.trim())).filter(n => !isNaN(n));

                if (indices.length === 0) {
                    await bot.sendMessage(chatId, "⚠️ Usage: <code>/deltoken 1</code> or <code>/deltokens 1, 2, 3</code>", {parse_mode: 'HTML'});
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
