import { GoogleGenAI } from "@google/genai";

const FALLBACK_KEYS = [
    "AIzaSyCD41es2BG9WMvS7cVtHO7yfIXbDSrqCKU",
    "AIzaSyDvTe0Bj50tKwWDQCf_dB2J-ypUd6ksXec",
    "AIzaSyAJ4TUhsZIikPaxmLR9gHJYQRQfGMm6OpI",
    "AIzaSyDHcyWyLX8Uxux6DFvfYP6D1WZivWNwP2Y",
    "AIzaSyDO42pb578kIUA6pF-cVWrjmiLV4DnZTgY",
    "AIzaSyD-72tGmFnI_7yhU1r8om1lpXSAXGvHm_g",
    "AIzaSyB41BbsaCo-OOnggFv3-Li74cH3DWSF_tA",
    "AIzaSyCkbm5TpNFK1M53yPBUsDd4jfQUjOVUMao",
    "AIzaSyD7EtmgrNEHucYdqNpoYOoYvfNyHFX4XYU",
    "AIzaSyBk2w9CnlgC2CTSkDeFm2r9AFqqyOvoBE0",
    "AIzaSyAH4zKIBwtoFAVWoUr6AAa5n8KL17ddfjY",
    "AIzaSyB2sF3ySVbZU2xRKKX5FgQ4pE5Rb_ZONdg"
];
let currentKeyIndex = 0;
export const switchAIKey = () => {
    currentKeyIndex = (currentKeyIndex + 1) % FALLBACK_KEYS.length;
    console.warn("Switched to next Gemini API Key. Index:", currentKeyIndex);
};

export const getAI = (): any => {
    return {
        models: {
            generateContentStream: async function* (params: any) {
                let attempts = 0;
                while (attempts < FALLBACK_KEYS.length + 1) {
                    let hasYielded = false;
                    try {
                        const ai = new GoogleGenAI({ apiKey: FALLBACK_KEYS[currentKeyIndex] });
                        const stream = await ai.models.generateContentStream(params);
                        for await (const chunk of stream) {
                            hasYielded = true;
                            yield chunk;
                        }
                        return;
                    } catch (e: any) {
                        if (hasYielded) throw e;
                        const errStr = e.toString() + JSON.stringify(e);
                        if (errStr.includes("429") || errStr.includes("quota") || errStr.includes("ResourceExhausted") || errStr.includes("API_KEY_INVALID") || errStr.includes("completed with error")) {
                            switchAIKey();
                            attempts++;
                        } else {
                            throw e;
                        }
                    }
                }
                throw new Error("All Gemini API keys exhausted.");
            }
        }
    };
};

async function run() {
    try {
        const ai = getAI();
        const stream = ai.models.generateContentStream({
            model: "gemini-3-flash-preview",
            contents: "Hi",
            config: { tools: [{ googleSearch: {} }] }
        });
        for await (const chunk of stream) {
            console.log(chunk.text);
        }
    } catch (e) {
        console.error("ERROR FINAL:", e);
    }
}
run();
