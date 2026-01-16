import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@vercel/kv";
import TelegramBot from "node-telegram-bot-api";

const kv = createClient({
    url: process.env.KV_REST_API_URL,
    token: process.env.KV_REST_API_TOKEN,
});

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN);

const ANTHROPIC_API_KEYS = [
    process.env.ANTHROPIC_API_KEY_1,
    process.env.ANTHROPIC_API_KEY_2,
    process.env.ANTHROPIC_API_KEY_3,
    process.env.ANTHROPIC_API_KEY_4,
    process.env.ANTHROPIC_API_KEY_5,
].filter(Boolean);

async function callClaudeWithRotation(messages, model) {
    let lastError;

    for (let i = 0; i < ANTHROPIC_API_KEYS.length; i++) {
        const apiKey = ANTHROPIC_API_KEYS[i];
        const client = new Anthropic({ apiKey });

        try {
            const systemMessage = messages.find((m) => m.role === "system");
            const userMessages = messages.filter((m) => m.role !== "system");

            const response = await client.messages.create({
                model: model,
                max_tokens: 8096,
                system: systemMessage?.content || "You are a helpful assistant.",
                messages: userMessages,
            });

            return response.content[0].text;
        } catch (error) {
            lastError = error;
            console.error(`API key ${i + 1} failed:`, error.message);

            if (error.status === 429 || error.status === 529) {
                continue;
            }
            throw error;
        }
    }

    throw lastError || new Error("All API keys exhausted");
}

async function performWebSearch(query) {
    const apiKey = process.env.GOOGLE_API_KEY;
    const searchEngineId = process.env.GOOGLE_SEARCH_ENGINE_ID;

    if (!apiKey || !searchEngineId) {
        console.log("Google Search not configured");
        return null;
    }

    try {
        const url = `https://www.googleapis.com/customsearch/v1?key=${apiKey}&cx=${searchEngineId}&q=${encodeURIComponent(query)}&num=5`;
        const response = await fetch(url);
        const data = await response.json();

        if (data.items && data.items.length > 0) {
            return data.items
                .map((item, index) => `${index + 1}. ${item.title}\n   ${item.snippet}\n   URL: ${item.link}`)
                .join("\n\n");
        }
        return null;
    } catch (error) {
        console.error("Search error:", error);
        return null;
    }
}

export default async function handler(req, res) {
    if (req.method === "POST") {
        const { message } = req.body;

        if (message?.text) {
            const chatId = message.chat.id;
            const userMessage = message.text;
            const dbKey = `chat:${chatId}`;

            let finalResponse = "";
            let hiddenSearchData = "";

            try {
                // Send typing indicator
                await bot.sendChatAction(chatId, "typing");

                // Get conversation history
                let history = (await kv.get(dbKey)) || [];

                // Handle /clear command
                if (userMessage.toLowerCase() === "/clear") {
                    await kv.del(dbKey);
                    await bot.sendMessage(chatId, "🗑️ Conversation history cleared.");
                    return res.status(200).json({ status: "ok" });
                }

                // Handle /help command
                if (userMessage.toLowerCase() === "/help") {
                    const helpText = `🤖 *Bot Commands*

• /clear - Clear conversation history
• /help - Show this help message

*Features:*
• Web search: Ask anything that needs current information
• Conversation memory: I remember our chat history
• Smart responses: Powered by Claude AI

Just send me any message to start chatting!`;
                    await bot.sendMessage(chatId, helpText, { parse_mode: "Markdown" });
                    return res.status(200).json({ status: "ok" });
                }

                // Add user message to history
                history.push({ role: "user", content: userMessage });

                // Determine active model
                const activeModel = process.env.MODEL_ID || "claude-sonnet-4-20250514";

                // Check if search is needed
                const searchCheckMessages = [
                    {
                        role: "system",
                        content: `You are a search intent detector. Analyze if the user's message requires a web search for current/real-time information.

Respond with ONLY valid JSON (no markdown, no code blocks):
{"needsSearch": true, "searchQuery": "optimized search query"} 
OR
{"needsSearch": false, "searchQuery": ""}

Needs search: current events, news, weather, prices, real-time data, recent information, facts you're unsure about.
No search needed: general knowledge, opinions, creative tasks, coding help, math, personal advice.`,
                    },
                    { role: "user", content: userMessage },
                ];

                const searchCheckResponse = await callClaudeWithRotation(searchCheckMessages, activeModel);

                let needsSearch = false;
                let searchQuery = "";

                try {
                    const cleanedResponse = searchCheckResponse.replace(/```json\n?|\n?```/g, "").trim();
                    const searchCheck = JSON.parse(cleanedResponse);
                    needsSearch = searchCheck.needsSearch;
                    searchQuery = searchCheck.searchQuery;
                } catch (e) {
                    console.log("Search check parse error:", e.message);
                }

                // Perform search if needed
                if (needsSearch && searchQuery) {
                    await bot.sendChatAction(chatId, "typing");

                    const searchResults = await performWebSearch(searchQuery);
                    const dateString = new Date().toLocaleDateString("en-US", {
                        weekday: "long",
                        year: "numeric",
                        month: "long",
                        day: "numeric",
                    });

                    if (searchResults) {
                        hiddenSearchData = `\n\n:::SEARCH_CONTEXT:::\nQuery: ${searchQuery}\n${searchResults}\n:::END_SEARCH_CONTEXT:::`;
                    }

                    const contextMsg = {
                        role: "system",
                        content: `[SYSTEM DATA]\nDate: ${dateString}\nSearch Query: "${searchQuery}"\nResults:\n${searchResults || "No results found."}\n\nInstruction: Answer the user's question directly using these results.\n\nCRITICAL STYLE RULE: Do NOT say "Based on the search results". Answer confidently. STRICTLY NO MARKDOWN TABLES. Use bullet points or plain text lists instead.`,
                    };

                    const answerMessages = [
                        { role: "system", content: process.env.SYSTEM_PROMPT || "You are a helpful assistant." },
                        ...history.slice(0, -1),
                        contextMsg,
                        { role: "user", content: userMessage },
                    ];

                    finalResponse = await callClaudeWithRotation(answerMessages, activeModel);
                } else {
                    const systemPrompt =
                        (process.env.SYSTEM_PROMPT || "You are a helpful assistant.") +
                        "\n\nSTRICT OUTPUT RULE: Do NOT use Markdown tables. Use bullet points or plain text formats only.";

                    const answerMessages = [
                        { role: "system", content: systemPrompt },
                        ...history,
                    ];

                    finalResponse = await callClaudeWithRotation(answerMessages, activeModel);
                }

                // Clean up markdown for Telegram
                let cleanReply = finalResponse
                    .replace(/^#{1,6}\s+(.*?)$/gm, "*$1*")
                    .replace(/\*\*(.*?)\*\*/g, "*$1*")
                    .replace(/_(.*?)_/g, "*$1*")
                    .replace(/^\s*-\s+/gm, "• ")
                    .replace(/^\s*[-_*]{3,}\s*$/gm, "")
                    .trim();

                // Store response with hidden search data
                const dbContent = cleanReply + hiddenSearchData;
                history.push({ role: "assistant", content: dbContent });

                // Trim history if too long
                if (history.length > 20) history = history.slice(-20);
                await kv.set(dbKey, history);

                // Send response in chunks if needed
                const MAX_CHUNK = 4000;
                for (let i = 0; i < cleanReply.length; i += MAX_CHUNK) {
                    await bot.sendMessage(chatId, cleanReply.substring(i, i + MAX_CHUNK), { parse_mode: "Markdown" });
                }
            } catch (error) {
                console.error("Error:", error);
                try {
                    await bot.sendMessage(
                        chatId,
                        error.message.includes("Markdown") ? finalResponse : `⚠️ Error: ${error.message}`
                    );
                } catch (e) {
                    console.error("Failed to send error message:", e);
                }
            }
        }

        res.status(200).json({ status: "ok" });
    } else {
        res.status(200).json({ status: "ready" });
    }
}
