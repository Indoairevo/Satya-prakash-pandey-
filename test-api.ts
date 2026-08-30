import { GoogleGenAI } from "@google/genai";
async function run() {
    const ai = new GoogleGenAI({ apiKey: "AIzaSyCD41es2BG9WMvS7cVtHO7yfIXbDSrqCKU" });
    try {
        const stream = await ai.models.generateContentStream({
            model: "gemini-3-flash-preview",
            contents: "Hi",
            config: { tools: [{ googleSearch: {} }] }
        });
        for await (const chunk of stream) {
            console.log(chunk.text);
        }
    } catch (e) {
        console.error("ERROR:", e);
    }
}
run();
