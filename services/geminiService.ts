
import { 
  Language, Subject, EducationLevel, ExamQuestion, Presentation, 
  CloudInsight, GeoResult, NewsItem, Fact, DeepDiveArticle, 
  Question, DocAnalysisResult, CareerRoadmap, MindMapNode, 
  StudyPlan, CodeSnippet, LMSource, LMGuide, CompetitionExam, 
  CompetitionTopic, ModelPaper, GradedPaperResult 
} from "../types";
import { dbService } from "./dbService";
// Fix: Added missing SAVED_PLANS and COMPETITION_DB imports
import { SAVED_ARTICLES, SAVED_NEWS, SAVED_QUIZ, SAVED_FACTS, SAVED_PLANS, COMPETITION_DB } from "../data/permanentDB";

export const Type = {
  TYPE_UNSPECIFIED: "TYPE_UNSPECIFIED",
  STRING: "STRING",
  NUMBER: "NUMBER",
  INTEGER: "INTEGER",
  BOOLEAN: "BOOLEAN",
  ARRAY: "ARRAY",
  OBJECT: "OBJECT",
  NULL: "NULL",
} as const;

export const Modality = {
  AUDIO: "AUDIO",
  IMAGE: "IMAGE",
  TEXT: "TEXT",
  VIDEO: "VIDEO"
} as const;

export const switchAIKey = () => {
    // Managed on server
};

export const getCurrentKey = () => {
    return "Server-Managed";
};

export const getAI = (): any => {
    return {
        models: {
            generateContent: async (params: any) => {
                const res = await fetch('/api/ai/generate', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        model: params.model || 'gemini-3-flash-preview',
                        contents: params.contents || params.prompt,
                        config: params.config,
                        tools: params.tools || params.config?.tools
                    })
                });

                if (!res.ok) {
                    const errData = await res.json().catch(() => ({}));
                    throw new Error(errData.error || `AI request failed (${res.status})`);
                }

                const data = await res.json();
                return {
                    text: data.text || "",
                    candidates: data.candidates || [{ content: { parts: [{ text: data.text || "" }] } }]
                };
            },
            generateContentStream: async function* (params: any) {
                const res = await fetch('/api/ai/stream', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        model: params.model || 'gemini-3-flash-preview',
                        contents: params.contents || params.prompt || params.message,
                        config: params.config,
                        tools: params.tools || params.config?.tools
                    })
                });

                if (!res.ok) {
                    const errData = await res.json().catch(() => ({}));
                    throw new Error(errData.error || `AI streaming failed (${res.status})`);
                }

                const reader = res.body?.getReader();
                if (!reader) throw new Error("No stream readable");

                const decoder = new TextDecoder();
                let buffer = "";

                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;

                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split('\n');
                    buffer = lines.pop() || '';

                    for (const line of lines) {
                        const trimmed = line.trim();
                        if (trimmed.startsWith('data: ')) {
                            const payload = trimmed.slice(6).trim();
                            if (payload === '[DONE]') return;
                            try {
                                const parsed = JSON.parse(payload);
                                if (parsed.error) {
                                    throw new Error(parsed.error);
                                }
                                if (parsed.text) {
                                    yield { text: parsed.text };
                                }
                            } catch (e: any) {
                                if (e.message && !e.message.includes('JSON')) throw e;
                            }
                        }
                    }
                }
            },
            generateVideos: async (params: any) => {
                const res = await fetch('/api/ai/generate', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        model: 'veo-3.1-generate-preview',
                        contents: params.prompt || params.contents,
                        config: params.config
                    })
                });
                return await res.json();
            }
        }
    };
};

export const getLangInstruction = (lang: Language) => {
  return lang === 'hi' ? "IMPORTANT: Respond EXCLUSIVELY in Hindi (Devanagari script)." : "Respond in English.";
};

const robustJSONParse = (text: string) => {
    try {
        const cleaned = text.replace(/```json/g, '').replace(/```/g, '').trim();
        return JSON.parse(cleaned);
    } catch (e) {
        // Suppress parsing errors during stream processing
        try {
            const match = text.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
            if (match) {
                return JSON.parse(match[0]);
            }
        } catch (e2) {
            // Suppress fallback JSON errors
        }
        return null;
    }
};

export const getGeminiResponse = async (prompt: string, lang: Language): Promise<string> => {
    const cached = dbService.getSavedResult('chat_resp', prompt);
    if (cached) return cached;

    const ai = getAI();
    const response = await ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: `${prompt} ${getLangInstruction(lang)}`,
    });
    const result = response.text || "";
    dbService.saveResult('chat_resp', prompt, result);
    return result;
};

export const fetchNews = async (lang: Language, refresh: boolean = false): Promise<NewsItem[]> => {
    // Priority 1: Check Refresh toggle. If false, return hard-coded library + local cache instantly.
    if (!refresh) {
        const cached = dbService.getNews();
        return cached; 
    }
    
    // Priority 2: If refresh requested, try fetching live news
    try {
        const ai = getAI();
        const response = await ai.models.generateContent({
            model: "gemini-3-flash-preview",
            contents: "List the 8 latest educational and global news items relevant for students. Include title, summary, category, and the source URL for each article. Use the google search tool to find the latest news and include the exact source URL in the 'url' field.",
            config: {
                tools: [{googleSearch: {}}],
                responseMimeType: "application/json",
                responseSchema: {
                    type: Type.ARRAY,
                    items: {
                        type: Type.OBJECT,
                        properties: {
                            title: { type: Type.STRING },
                            summary: { type: Type.STRING },
                            category: { type: Type.STRING },
                            url: { type: Type.STRING }
                        }
                    }
                }
            },
        });
        const raw = robustJSONParse(response.text || "[]");
        
        // Extract URLs from grounding chunks if possible, to verify or fallback
        const chunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
        const chunkUrls = chunks.map((c: any) => c.web?.uri).filter(Boolean);

        const processed = raw.map((item: any, idx: number) => ({
            ...item,
            id: `news-live-${Date.now()}-${idx}`,
            date: new Date().toLocaleDateString(),
            timestamp: Date.now(),
            imageUrl: `https://picsum.photos/800/400?random=${idx + 200}`,
            url: item.url && item.url.startsWith('http') ? item.url : (chunkUrls[idx] || null)
        }));
        
        // Merge with existing to maintain "hajarro news" feel
        const final = [...processed, ...SAVED_NEWS];
        dbService.save('news_cache', final);
        return final;
    } catch (e) {
        // Ultimate fallback to hardcoded database
        return SAVED_NEWS;
    }
};

export const fetchFullNewsStory = async (title: string, lang: Language): Promise<string> => {
    const ai = getAI();
    const response = await ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: `Provide a detailed 500-word educational report on: ${title}. Include background, current status, and impact. Format with HTML tags like <h3>, <p>, <ul>. ${getLangInstruction(lang)}`,
        config: { tools: [{ googleSearch: {} }] }
    });
    return response.text || "Report unavailable.";
};

export const fetchFacts = async (subject: Subject, level: EducationLevel, lang: Language, count: number = 6): Promise<Fact[]> => {
    // Check Permanent DB first to avoid API call
    const cached = dbService.getFacts(subject, level);
    if (cached.length >= count) return cached.slice(0, count);

    try {
        const ai = getAI();
        const response = await ai.models.generateContent({
            model: 'gemini-3-flash-preview',
            contents: `List ${count} interesting, high-yield academic facts about ${subject} for ${level}. ${getLangInstruction(lang)}`,
            config: {
                responseMimeType: "application/json",
                responseSchema: {
                    type: Type.ARRAY,
                    items: {
                        type: Type.OBJECT,
                        properties: {
                            content: { type: Type.STRING }
                        }
                    }
                }
            }
        });
        const raw = robustJSONParse(response.text || "[]");
        const newFacts = raw.map((f: any, i: number) => ({
            id: `fact-ai-${Date.now()}-${i}`,
            subject,
            level,
            content: f.content
        }));
        
        // Save to DB
        dbService.saveFacts(subject, level, newFacts);
        
        return newFacts;
    } catch (e) {
        return cached;
    }
};

export const fetchDeepDiveArticle = async (topic: string, subject: Subject, level: EducationLevel, lang: Language): Promise<DeepDiveArticle | null> => {
    // Check Permanent DB
    const existing = dbService.getArticle(topic, subject);
    if (existing) return existing;

    const ai = getAI();
    const response = await ai.models.generateContent({
        model: 'gemini-3-pro-preview',
        contents: `Write a detailed scholarly article on "${topic}" within the field of ${subject} for a ${level} level. Use HTML for structure (<h3>, <p>, <li>). Include an introduction, deep analysis, and future outlook. ${getLangInstruction(lang)}`,
        config: {
            responseMimeType: "application/json",
            responseSchema: {
                type: Type.OBJECT,
                properties: {
                    title: { type: Type.STRING },
                    content: { type: Type.STRING },
                    tags: { type: Type.ARRAY, items: { type: Type.STRING } }
                }
            }
        }
    });
    const data = robustJSONParse(response.text || "{}");
    if (data.title) {
        const article = {
            ...data,
            id: `dd-ai-${Date.now()}`,
            subject,
            level,
            imageUrl: `https://picsum.photos/800/400?random=${Date.now()}`
        };
        dbService.saveArticle(article);
        return article;
    }
    return null;
};

export const fetchQuizQuestions = async (level: EducationLevel, subject: Subject, lang: Language): Promise<Question[]> => {
    // Check Permanent DB
    const cached = dbService.getLastQuiz(subject, level);
    if (cached.length > 0) return cached;

    const ai = getAI();
    const response = await ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: `Generate 5 challenging multiple-choice questions for ${subject} at ${level} level. Include rationale. ${getLangInstruction(lang)}`,
        config: {
            responseMimeType: "application/json",
            responseSchema: {
                type: Type.ARRAY,
                items: {
                    type: Type.OBJECT,
                    properties: {
                        question: { type: Type.STRING },
                        options: { type: Type.ARRAY, items: { type: Type.STRING } },
                        correctAnswer: { type: Type.NUMBER, description: "0-based index of correct option" },
                        rationale: { type: Type.STRING }
                    }
                }
            }
        }
    });
    const raw = robustJSONParse(response.text || "[]");
    const questions = raw.map((q: any, i: number) => ({
        ...q,
        id: `q-ai-${Date.now()}-${i}`,
        level
    }));
    
    if (questions.length > 0) {
        dbService.saveLastQuiz(subject, level, questions);
    }
    
    return questions;
};

export const getQuizHint = async (question: string, lang: Language): Promise<string> => {
    const ai = getAI();
    const response = await ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: `Provide a small, helpful hint (not the answer) for this question: "${question}". ${getLangInstruction(lang)}`,
    });
    return response.text || "No hint available.";
};

export const generateVideo = async (prompt: string): Promise<string | null> => {
    const cached = dbService.getVideo(prompt);
    if (cached) return cached;

    try {
        const ai = getAI();
        const res = await ai.models.generateVideos({
            prompt: prompt,
            config: {
                numberOfVideos: 1,
                resolution: '720p',
                aspectRatio: '16:9'
            }
        });
        if (res && res.url) {
            dbService.saveVideo(prompt, res.url);
            return res.url;
        }
        return null;
    } catch (e) {
        console.error("Video generation failed:", e);
        return null;
    }
};

export const generateImage = async (prompt: string): Promise<string | null> => {
    const ai = getAI();
    const response = await ai.models.generateContent({
        model: 'gemini-3.1-flash-image-preview',
        contents: { parts: [{ text: prompt }] },
        config: {
            imageConfig: {
                aspectRatio: "1:1",
                imageSize: "1K"
            }
        }
    });
    for (const part of response.candidates?.[0]?.content?.parts || []) {
        if (part.inlineData) {
            return `data:image/png;base64,${part.inlineData.data}`;
        }
    }
    return null;
};

export const analyzeDocument = async (text: string, imageBase64: string | null, url: string, lang: Language): Promise<DocAnalysisResult | null> => {
    const ai = getAI();
    const parts: any[] = [{ text: `Analyze this material. Provide summary, 5 key points, and a 3-question quiz. ${getLangInstruction(lang)}` }];
    if (text) parts.push({ text: `Source Text: ${text}` });
    if (url) parts.push({ text: `Source URL: ${url}` });
    if (imageBase64) parts.push({ inlineData: { data: imageBase64.split(',')[1], mimeType: 'image/jpeg' } });

    const response = await ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: { parts },
        config: {
            responseMimeType: "application/json",
            responseSchema: {
                type: Type.OBJECT,
                properties: {
                    summary: { type: Type.STRING },
                    keyPoints: { type: Type.ARRAY, items: { type: Type.STRING } },
                    quiz: {
                        type: Type.ARRAY,
                        items: {
                            type: Type.OBJECT,
                            properties: {
                                question: { type: Type.STRING },
                                options: { type: Type.ARRAY, items: { type: Type.STRING } },
                                correctAnswer: { type: Type.NUMBER },
                                rationale: { type: Type.STRING }
                            }
                        }
                    }
                }
            }
        }
    });
    const data = robustJSONParse(response.text || "{}");
    if (data.summary) {
        const result = {
            ...data,
            id: `doc-${Date.now()}`,
            title: text?.slice(0, 30) || url?.slice(0, 30) || "Image Analysis",
            timestamp: Date.now()
        };
        dbService.saveDocAnalysis(result);
        return result;
    }
    return null;
};

export const getGroundedChatResponse = async (query: string, sources: LMSource[], lang: Language): Promise<string> => {
    const ai = getAI();
    const sourceContext = sources.map(s => `SOURCE: ${s.title}\nCONTENT: ${s.content}`).join('\n\n');
    const response = await ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: `Use ONLY the following sources to answer the query: "${query}".\n\n${sourceContext}\n\n${getLangInstruction(lang)}`,
    });
    return response.text || "I cannot find an answer based on the provided sources.";
};

export const generateNotebookGuide = async (sources: LMSource[], lang: Language): Promise<LMGuide | null> => {
    const ai = getAI();
    const sourceContext = sources.map(s => `SOURCE: ${s.title}\nCONTENT: ${s.content}`).join('\n\n');
    const response = await ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: `Synthesize a notebook guide from these sources. ${getLangInstruction(lang)}\n\n${sourceContext}`,
        config: {
            responseMimeType: "application/json",
            responseSchema: {
                type: Type.OBJECT,
                properties: {
                    summary: { type: Type.STRING },
                    suggestedQuestions: { type: Type.ARRAY, items: { type: Type.STRING } },
                    topics: { type: Type.ARRAY, items: { type: Type.STRING } }
                }
            }
        }
    });
    return robustJSONParse(response.text || "null");
};

export const translateText = async (text: string, targetLang: string): Promise<string> => {
    const ai = getAI();
    const response = await ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: `Translate the following text to ${targetLang}. Keep scholarly nuances.\n\n${text}`,
    });
    return response.text || text;
};

export const startVideoGeneration = async (prompt: string) => {
    const ai = getAI();
    return ai.models.generateVideos({
        model: 'veo-3.1-fast-generate-preview',
        prompt: prompt,
        config: {
            numberOfVideos: 1,
            resolution: '1080p',
            aspectRatio: '16:9'
        }
    });
};

export const pollVideoStatus = async (operation: any) => {
    const ai = getAI();
    return ai.operations.getVideosOperation({ operation });
};

export const analyzeScholarLens = async (imageBase64: string, query: string, lang: Language): Promise<string> => {
    const ai = getAI();
    const response = await ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: {
            parts: [
                { text: `${query}. ${getLangInstruction(lang)}` },
                { inlineData: { data: imageBase64, mimeType: 'image/jpeg' } }
            ]
        }
    });
    return response.text || "Unable to analyze image.";
};

export const generateScholarSlides = async (topic: string, lang: Language): Promise<Presentation | null> => {
    const cached = dbService.getSavedResult('slides', topic);
    if (cached) return cached;

    const ai = getAI();
    const response = await ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: `Create an educational 5-slide presentation deck for "${topic}". Include title, bullet points, and speaker notes for each slide. ${getLangInstruction(lang)}`,
        config: {
            responseMimeType: "application/json",
            responseSchema: {
                type: Type.OBJECT,
                properties: {
                    topic: { type: Type.STRING },
                    slides: {
                        type: Type.ARRAY,
                        items: {
                            type: Type.OBJECT,
                            properties: {
                                title: { type: Type.STRING },
                                content: { type: Type.ARRAY, items: { type: Type.STRING } },
                                speakerNotes: { type: Type.STRING }
                            }
                        }
                    }
                }
            }
        }
    });
    const data = robustJSONParse(response.text || "{}");
    if (data.slides) {
        const deck = { ...data, id: `deck-${Date.now()}` };
        dbService.saveResult('slides', topic, deck);
        return deck;
    }
    return null;
};

export const analyzeCloudStorage = async (context: string, lang: Language): Promise<CloudInsight[]> => {
    const ai = getAI();
    const response = await ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: `Analyze this student study metadata and provide 3 strategic insights. ${getLangInstruction(lang)}\n\n${context}`,
        config: {
            responseMimeType: "application/json",
            responseSchema: {
                type: Type.ARRAY,
                items: {
                    type: Type.OBJECT,
                    properties: {
                        category: { type: Type.STRING },
                        summary: { type: Type.STRING },
                        recommendation: { type: Type.STRING }
                    }
                }
            }
        }
    });
    return robustJSONParse(response.text || "[]");
};

export const textToTable = async (text: string, lang: Language): Promise<any[]> => {
    const ai = getAI();
    const response = await ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: `Convert this descriptive data into a structured JSON array of objects suitable for a spreadsheet. ${getLangInstruction(lang)}\n\n${text}`,
        config: { responseMimeType: "application/json" }
    });
    return robustJSONParse(response.text || "[]");
};

export const generateExamQuestions = async (subject: Subject, level: string, board: string, category: string, lang: Language): Promise<ExamQuestion[]> => {
    try {
        const prompt = `Generate 5 high-quality exam questions for ${subject} (Level: ${level}, Board: ${board}, Category: ${category}). ${getLangInstruction(lang)}
        
        You must return ONLY a JSON array of objects, with no markdown formatting. Each object must have these exactly 3 keys:
        - "type" (String, either "MCQ", "2-Mark", or "5-Mark")
        - "question" (String)
        - "answer" (String)
        
        Example:
        [
          { "type": "MCQ", "question": "What is 2+2?", "answer": "4" }
        ]`;

        const response = await fetch("https://integrate.api.nvidia.com/v1/chat/completions", {
            method: "POST",
            headers: {
                "Authorization": "Bearer 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",
                "Content-Type": "application/json",
                "Accept": "application/json"
            },
            body: JSON.stringify({
                model: "mistralai/mistral-medium-3.5-128b",
                messages: [{ role: "user", content: prompt }],
                max_tokens: 4096,
                temperature: 0.7,
                top_p: 1.0,
                stream: false
            })
        });

        if (response.ok) {
            const data = await response.json();
            const textResponse = data.choices[0]?.message?.content || "[]";
            const raw = robustJSONParse(textResponse);
            if (Array.isArray(raw)) {
                 return raw.map((q: any, i: number) => ({ ...q, id: `eq-${Date.now()}-${i}` }));
            }
        }
    } catch (error) {
        console.error("NVIDIA NIM Error:", error);
    }
    
    // Fallback to Gemini if NVIDIA fails
    const ai = getAI();
    const response = await ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: `Generate 5 exam questions for ${subject} (${level}, ${board}, ${category}). ${getLangInstruction(lang)}`,
        config: {
            responseMimeType: "application/json",
            responseSchema: {
                type: Type.ARRAY,
                items: {
                    type: Type.OBJECT,
                    properties: {
                        type: { type: Type.STRING, description: "MCQ, 2-Mark, or 5-Mark" },
                        question: { type: Type.STRING },
                        answer: { type: Type.STRING }
                    },
                    required: ["type", "question", "answer"]
                }
            }
        }
    });
    const raw = robustJSONParse(response.text || "[]");
    return raw.map((q: any, i: number) => ({ ...q, id: `eq-${Date.now()}-${i}` }));
};

export const evaluatePaper = async (paper: ModelPaper, answers: Record<string, string>, lang: Language): Promise<GradedPaperResult | null> => {
    const ai = getAI();
    const prompt = `Grade this exam paper.
    PAPER: ${JSON.stringify(paper)}
    USER ANSWERS: ${JSON.stringify(answers)}
    
    Return a GradedPaperResult JSON. ${getLangInstruction(lang)}`;

    const response = await ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: prompt,
        config: {
            responseMimeType: "application/json",
            responseSchema: {
                type: Type.OBJECT,
                properties: {
                    totalScore: { type: Type.NUMBER },
                    maxScore: { type: Type.NUMBER },
                    percentage: { type: Type.NUMBER },
                    overallFeedback: { type: Type.STRING },
                    questionResults: {
                        type: Type.ARRAY,
                        items: {
                            type: Type.OBJECT,
                            properties: {
                                questionId: { type: Type.STRING },
                                questionText: { type: Type.STRING },
                                userAnswer: { type: Type.STRING },
                                obtainedMarks: { type: Type.NUMBER },
                                maxMarks: { type: Type.NUMBER },
                                status: { type: Type.STRING },
                                feedback: { type: Type.STRING },
                                idealAnswer: { type: Type.STRING }
                            },
                            required: ["questionId", "questionText", "userAnswer", "obtainedMarks", "maxMarks", "status", "feedback", "idealAnswer"]
                        }
                    }
                },
                required: ["totalScore", "maxScore", "percentage", "overallFeedback", "questionResults"]
            }
        }
    });
    return robustJSONParse(response.text || "null");
};

export const generateExamNotes = async (topic: string, lang: Language) => {
    const cached = dbService.getSavedResult('exam_notes', topic);
    if (cached) return cached;

    const ai = getAI();
    const response = await ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: `Generate high-yield exam notes for "${topic}". ${getLangInstruction(lang)}`,
        config: {
            responseMimeType: "application/json",
            responseSchema: {
                type: Type.OBJECT,
                properties: {
                    title: { type: Type.STRING },
                    summary: { type: Type.STRING },
                    keyTerms: { 
                        type: Type.ARRAY, 
                        items: { 
                            type: Type.OBJECT, 
                            properties: { 
                                term: { type: Type.STRING }, 
                                definition: { type: Type.STRING } 
                            },
                            required: ["term", "definition"]
                        } 
                    },
                    bulletPoints: { type: Type.ARRAY, items: { type: Type.STRING } }
                },
                required: ["title", "summary", "keyTerms", "bulletPoints"]
            }
        }
    });
    const data = robustJSONParse(response.text || "null");
    if (data) dbService.saveResult('exam_notes', topic, data);
    return data;
};

export const generateModelPaperStream = async function* (subject: string, level: string, board: string, lang: Language, imageBase64?: string): AsyncGenerator<{ text: string, questionsFound: number }, ModelPaper | null, unknown> {
    const aiKey = `${subject}_${level}_${board}`;
    const cached = dbService.getSavedResult('paper', aiKey);
    if (cached) {
        yield { text: JSON.stringify(cached), questionsFound: 25 };
        return cached;
    }

    const ai = getAI();
    const response = await ai.models.generateContentStream({
        model: 'gemini-3-flash-preview',
        contents: imageBase64 ? 
            { parts: [{ text: `Generate a 100-mark ${board} exam paper for ${subject} based on this image source. ${getLangInstruction(lang)}` }, { inlineData: { data: imageBase64.split(',')[1], mimeType: 'image/jpeg' } }] } :
            `Generate a 100-mark ${board} exam paper for ${subject} (${level}). ${getLangInstruction(lang)}`,
        config: {
            responseMimeType: "application/json",
            responseSchema: {
                type: Type.OBJECT,
                properties: {
                    subject: { type: Type.STRING },
                    totalMarks: { type: Type.NUMBER },
                    sections: {
                        type: Type.ARRAY,
                        items: {
                            type: Type.OBJECT,
                            properties: {
                                title: { type: Type.STRING },
                                instruction: { type: Type.STRING },
                                questions: {
                                    type: Type.ARRAY,
                                    items: {
                                        type: Type.OBJECT,
                                        properties: {
                                            id: { type: Type.STRING },
                                            type: { type: Type.STRING },
                                            question: { type: Type.STRING },
                                            marks: { type: Type.NUMBER },
                                            options: { type: Type.ARRAY, items: { type: Type.STRING } }
                                        },
                                        required: ["id", "type", "question", "marks"]
                                    }
                                }
                            },
                            required: ["title", "instruction", "questions"]
                        }
                    }
                },
                required: ["subject", "totalMarks", "sections"]
            }
        }
    });

    let accumulatedText = '';
    for await (const chunk of response) {
        accumulatedText += chunk.text;
        const matches = accumulatedText.match(/"question"\s*:\s*"/g);
        const questionsFound = matches ? matches.length : 0;
        yield { text: accumulatedText, questionsFound };
    }

    const data = robustJSONParse(accumulatedText || '{}');
    if (data && data.sections) {
        data.board = board;
        data.level = level;
        data.createdAt = Date.now();
        dbService.saveResult('paper', aiKey, data);
        return data;
    }
    return null;
};

export const generateCompetitiveQuizStream = async function* (exam: string, subject: string, lang: Language, level: number = 1): AsyncGenerator<{ text: string, progress: number, questions: Question[] }, Question[] | null, unknown> {
    const ai = getAI();
    const prompt = `Generate a high-quality competitive exam quiz for ${exam} ${subject} at difficulty Level ${level}/4. 
    Level 1 is basic, Level 4 is extremely challenging/advanced.
    Return a JSON object containing a "questions" array with 10 challenging multiple-choice questions. 
    Each question must have: question text, 4 options, correctAnswer (0-3), and a detailed rationale/explanation.
    ${getLangInstruction(lang)}`;

    const response = await ai.models.generateContentStream({
        model: 'gemini-3-flash-preview',
        contents: prompt,
        config: {
            maxOutputTokens: 8192,
            responseMimeType: "application/json",
            responseSchema: {
                type: Type.OBJECT,
                properties: {
                    questions: {
                        type: Type.ARRAY,
                        items: {
                            type: Type.OBJECT,
                            properties: {
                                question: { type: Type.STRING },
                                options: { type: Type.ARRAY, items: { type: Type.STRING } },
                                correctAnswer: { type: Type.NUMBER },
                                rationale: { type: Type.STRING }
                            },
                            required: ["question", "options", "correctAnswer", "rationale"]
                        }
                    }
                },
                required: ["questions"]
            }
        }
    });

    let accumulatedText = '';
    let questions: Question[] = [];
    for await (const chunk of response) {
        accumulatedText += chunk.text;
        const matches = accumulatedText.match(/"question"\s*:\s*"/g);
        const count = matches ? matches.length : 0;
        const progress = Math.min(Math.round((count / 10) * 100), 99);
        
        yield { text: accumulatedText, progress, questions: [] };
    }

    const raw = robustJSONParse(accumulatedText || "{}");
    let batchRaw = [];
    if (raw && Array.isArray(raw.questions)) {
        batchRaw = raw.questions;
    } else if (raw && Array.isArray(raw)) {
        batchRaw = raw;
    } else if (raw && raw.data && Array.isArray(raw.data.questions)) {
        batchRaw = raw.data.questions;
    }

    if (batchRaw.length > 0) {
        questions = batchRaw.map((q: any, i: number) => ({
            ...q,
            id: `ai-quiz-${Date.now()}-${i}`,
            level: "Competitive"
        }));
        yield { text: accumulatedText, progress: 100, questions };
        return questions;
    }
    console.error("Failed to parse quiz questions", accumulatedText);
    return null;
};

export const generateCompetitiveMockPaperStream = async function* (exam: string, subject: string, lang: Language, level: number = 1, totalQuestions: number = 125): AsyncGenerator<{ text: string, progress: number, questions: Question[] }, Question[] | null, unknown> {
    const ai = getAI();
    let allQuestions: Question[] = [];
    let completedQuestions = 0;
    const batchSize = 25;
    const numBatches = Math.ceil(totalQuestions / batchSize);

    for (let b = 0; b < numBatches; b++) {
        const qsToGenerate = Math.min(batchSize, totalQuestions - completedQuestions);
        if (qsToGenerate <= 0) break;

        const prompt = `Generate batch ${b+1} of ${numBatches} for a full-length competitive mock paper for ${exam} ${subject} at difficulty Level ${level}/4.
        Level 1 is standard, Level 4 is extremely advanced/tough.
        Return a JSON object containing a "questions" array with exactly ${qsToGenerate} high-difficulty multiple-choice questions covering new syllabus topics (do not repeat).
        Each question must have: question text, 4 options, correctAnswer (0-3), and a detailed rationale/explanation.
        ${getLangInstruction(lang)}`;

        try {
            const response = await ai.models.generateContentStream({
                model: 'gemini-3-flash-preview',
                contents: prompt,
                config: {
                    maxOutputTokens: 8192,
                    responseMimeType: "application/json",
                    responseSchema: {
                        type: Type.OBJECT,
                        properties: {
                            questions: {
                                type: Type.ARRAY,
                                items: {
                                    type: Type.OBJECT,
                                    properties: {
                                        question: { type: Type.STRING },
                                        options: { type: Type.ARRAY, items: { type: Type.STRING } },
                                        correctAnswer: { type: Type.NUMBER },
                                        rationale: { type: Type.STRING }
                                    },
                                    required: ["question", "options", "correctAnswer", "rationale"]
                                }
                            }
                        },
                        required: ["questions"]
                    }
                }
            });

            let accumulatedText = '';
            for await (const chunk of response) {
                accumulatedText += chunk.text;
                const matches = accumulatedText.match(/"question"\s*:\s*"/g);
                const currentBatchCount = matches ? matches.length : 0;
                const progress = Math.min(Math.round(((completedQuestions + currentBatchCount) / totalQuestions) * 100), 99);
                
                yield { text: accumulatedText, progress, questions: allQuestions };
            }

            const raw = robustJSONParse(accumulatedText || "{}");
            let batchRaw = [];
            if (raw && Array.isArray(raw.questions)) {
                batchRaw = raw.questions;
            } else if (raw && Array.isArray(raw)) {
                batchRaw = raw;
            } else if (raw && raw.data && Array.isArray(raw.data.questions)) {
                batchRaw = raw.data.questions;
            }
            
            if (batchRaw.length > 0) {
                const batchQuestions = batchRaw.map((q: any, i: number) => ({
                    ...q,
                    id: `ai-mock-${Date.now()}-${b}-${i}`,
                    level: "Competitive"
                }));
                allQuestions = allQuestions.concat(batchQuestions);
                completedQuestions += batchQuestions.length;
            } else {
                 console.error("No questions found in this batch. accumulation:", accumulatedText);
            }
        } catch (error) {
            console.error("Error generating batch", b, error);
            break;
        }
    }

    if (allQuestions.length > 0) {
        yield { text: 'completed', progress: 100, questions: allQuestions };
        return allQuestions;
    }
    
    console.error("Failed to parse mock questions");
    return null;
};

export const generateModelPaper = async (subject: string, level: string, board: string, lang: Language, imageBase64?: string): Promise<ModelPaper | null> => {
    const aiKey = `${subject}_${level}_${board}`;
    const cached = dbService.getSavedResult('paper', aiKey);
    if (cached) return cached;

    const ai = getAI();
    const response = await ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: imageBase64 ? 
            { parts: [{ text: `Generate a 100-mark ${board} exam paper for ${subject} based on this image source. ${getLangInstruction(lang)}` }, { inlineData: { data: imageBase64.split(',')[1], mimeType: 'image/jpeg' } }] } :
            `Generate a 100-mark ${board} exam paper for ${subject} (${level}). ${getLangInstruction(lang)}`,
        config: {
            responseMimeType: "application/json",
            responseSchema: {
                type: Type.OBJECT,
                properties: {
                    subject: { type: Type.STRING },
                    totalMarks: { type: Type.NUMBER },
                    sections: {
                        type: Type.ARRAY,
                        items: {
                            type: Type.OBJECT,
                            properties: {
                                title: { type: Type.STRING },
                                instruction: { type: Type.STRING },
                                questions: {
                                    type: Type.ARRAY,
                                    items: {
                                        type: Type.OBJECT,
                                        properties: {
                                            id: { type: Type.STRING },
                                            type: { type: Type.STRING },
                                            question: { type: Type.STRING },
                                            marks: { type: Type.NUMBER },
                                            options: { type: Type.ARRAY, items: { type: Type.STRING } }
                                        },
                                        required: ["id", "type", "question", "marks"]
                                    }
                                }
                            },
                            required: ["title", "instruction", "questions"]
                        }
                    }
                },
                required: ["subject", "totalMarks", "sections"]
            }
        }
    });
    const data = robustJSONParse(response.text || '{}');
    if (data.sections) {
        data.board = board;
        data.level = level;
        data.createdAt = Date.now();
        dbService.saveResult('paper', aiKey, data);
    }
    return data;
};

export const searchPlaces = async (query: string, lang: Language): Promise<GeoResult> => {
    const ai = getAI();
    const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash-lite-latest',
        contents: `Provide educational facts about historical places in: ${query}. ${getLangInstruction(lang)}`,
        config: { tools: [{ googleMaps: {} }] }
    });
    const places = response.candidates?.[0]?.groundingMetadata?.groundingChunks?.map((chunk: any) => ({
        title: chunk.maps?.title || "Educational Site",
        uri: chunk.maps?.uri || "#"
    })) || [];
    return { text: response.text || "", places };
};

export const performGlobalSearch = async (query: string, lang: Language) => {
    const ai = getAI();
    const response = await ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: `${query}. ${getLangInstruction(lang)}`,
        config: { tools: [{ googleSearch: {} }] }
    });
    const citations = response.candidates?.[0]?.groundingMetadata?.groundingChunks?.map((chunk: any) => ({
        title: chunk.web?.title || "Search Result",
        uri: chunk.web?.uri || "#"
    })) || [];
    return { text: response.text || "", citations };
};

export type GeminiModel = 'gemini-3-flash-preview' | 'gemini-3-flash-preview' | 'gemini-2.5-flash' | 'gemini-2.5-flash-lite-latest';

export async function* streamGeminiResponse(prompt: string, model: GeminiModel = 'gemini-3-flash-preview', useSearch: boolean = false) {
    const ai = getAI();
    const response = await ai.models.generateContentStream({
        model: model,
        contents: prompt,
        config: {
            tools: useSearch ? [{ googleSearch: {} }] : undefined
        }
    });

    let fullText = '';
    for await (const chunk of response) {
        const text = chunk.text || "";
        fullText += text;
        
        // Extract grounding metadata if available in this chunk or final
        const chunks = chunk.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
        const sources = chunks.map((c: any) => ({
            title: c.web?.title || c.maps?.title || "Source",
            url: c.web?.uri || c.maps?.uri || "#"
        })).filter((s: any) => s.url !== "#");

        yield { text, sources };
    }
}

export const generateSpeech = async (text: string, voice: string): Promise<string | null> => {
    const key = `speech_${voice}_${text.slice(0, 50)}`; // Cache key
    const cached = dbService.getSavedResult('speech', key);
    if (cached) return cached;

    const ai = getAI();
    const response = await ai.models.generateContent({
        model: "gemini-2.5-flash-preview-tts",
        contents: [{ parts: [{ text }] }],
        config: {
            responseModalities: [Modality.AUDIO],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
        },
    });
    const audioData = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data || null;
    if (audioData) {
        dbService.saveResult('speech', key, audioData);
    }
    return audioData;
};

export const connectLiveTutor = async (lang: Language, callbacks: any) => {
    const ai = getAI();
    return ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-09-2025',
        callbacks,
        config: {
            responseModalities: [Modality.AUDIO],
            systemInstruction: `Academic tutor. ${getLangInstruction(lang)}`
        }
    });
};

export const generateStudyBuddyLesson = async (topic: string, level: string, lang: Language) => {
    const cached = dbService.getSavedResult('buddy_lesson', topic);
    if (cached) return cached;

    const ai = getAI();
    const response = await ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: `Masterclass tutor on "${topic}" for ${level}. ${getLangInstruction(lang)}`,
        config: {
            responseMimeType: "application/json",
            responseSchema: {
                type: Type.OBJECT,
                properties: {
                    title: { type: Type.STRING },
                    explanation: { type: Type.STRING },
                    parts: { type: Type.ARRAY, items: { type: Type.STRING } },
                    followUps: { type: Type.ARRAY, items: { type: Type.STRING } }
                }
            }
        }
    });
    const data = robustJSONParse(response.text || "{}");
    if (data.title) dbService.saveResult('buddy_lesson', topic, data);
    return data;
};

export const analyzeCode = async (code: string, lang: string, mode: string, targetLang?: string): Promise<CodeSnippet | null> => {
    const cacheKey = `code_${mode}_${code.slice(0, 30)}`;
    const cached = dbService.getSavedResult('code_analysis', cacheKey);
    if (cached) return cached;

    const ai = getAI();
    const response = await ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: `Code ${mode}: ${code}. ${targetLang ? 'Target: ' + targetLang : ''}`,
        config: {
            responseMimeType: "application/json",
            responseSchema: {
                type: Type.OBJECT,
                properties: {
                    title: { type: Type.STRING },
                    code: { type: Type.STRING },
                    language: { type: Type.STRING },
                    explanation: { type: Type.STRING }
                }
            }
        }
    });
    const data = robustJSONParse(response.text || "{}");
    const snippet = { ...data, id: `code-${Date.now()}`, timestamp: Date.now() };
    
    if (snippet.title) {
        dbService.saveResult('code_analysis', cacheKey, snippet);
        dbService.saveCodeSnippet(snippet); // Also save to history
    }
    
    return snippet;
};

export const generateMindMapData = async (topic: string, lang: Language): Promise<MindMapNode | null> => {
    const cached = dbService.getMindMap(topic);
    if (cached) return cached;

    const ai = getAI();
    const response = await ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: `Mind map tree for ${topic}. ${getLangInstruction(lang)}`,
        config: {
            responseMimeType: "application/json",
            responseSchema: {
                type: Type.OBJECT,
                properties: {
                    label: { type: Type.STRING },
                    children: {
                        type: Type.ARRAY,
                        items: {
                            type: Type.OBJECT,
                            properties: {
                                label: { type: Type.STRING },
                                children: { type: Type.ARRAY, items: { type: Type.OBJECT, properties: { label: { type: Type.STRING } } } }
                            }
                        }
                    }
                }
            }
        }
    });
    const data = robustJSONParse(response.text || "null");
    if (data) dbService.saveMindMap(topic, data);
    return data;
};

export const generateCareerRoadmap = async (interests: string, strengths: string, subjects: string, lang: Language): Promise<CareerRoadmap[]> => {
    const ai = getAI();
    const response = await ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: `Career roadmap for interests: ${interests}, strengths: ${strengths}. ${getLangInstruction(lang)}`,
        config: {
            responseMimeType: "application/json",
            responseSchema: {
                type: Type.ARRAY,
                items: {
                    type: Type.OBJECT,
                    properties: {
                        careerTitle: { type: Type.STRING },
                        matchScore: { type: Type.NUMBER },
                        description: { type: Type.STRING },
                        skillsRequired: { type: Type.ARRAY, items: { type: Type.STRING } },
                        educationPath: { type: Type.ARRAY, items: { type: Type.STRING } },
                        potentialRoles: { type: Type.ARRAY, items: { type: Type.STRING } }
                    }
                }
            }
        }
    });
    return robustJSONParse(response.text || "[]");
};

export const generateStudyPlan = async (exam: string, days: number, subjects: string, lang: Language): Promise<StudyPlan | null> => {
    // Check Permanent DB
    const cached = dbService.getPlan(exam);
    if (cached) return cached;

    const ai = getAI();
    const response = await ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: `Study plan for ${exam} (${days} days). ${getLangInstruction(lang)}`,
        config: {
            responseMimeType: "application/json",
            responseSchema: {
                type: Type.OBJECT,
                properties: {
                    examName: { type: Type.STRING },
                    totalDays: { type: Type.NUMBER },
                    schedule: {
                        type: Type.ARRAY,
                        items: {
                            type: Type.OBJECT,
                            properties: {
                                day: { type: Type.NUMBER },
                                topics: { type: Type.ARRAY, items: { type: Type.STRING } },
                                tasks: { type: Type.ARRAY, items: { type: Type.STRING } }
                            }
                        }
                    }
                }
            }
        }
    });
    const plan = robustJSONParse(response.text || "null");
    if (plan) dbService.savePlan(exam, plan);
    return plan;
};

export const fetchCompetitionTopics = async (exam: string, subject: string, lang: Language): Promise<CompetitionTopic[]> => {
    // Check Permanent DB
    const cached = dbService.getCompetitionTopics(exam, subject);
    if (cached.length > 0) return cached;

    const ai = getAI();
    const response = await ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: `Priority topics for ${exam} in ${subject}. ${getLangInstruction(lang)}`,
        config: {
            responseMimeType: "application/json",
            responseSchema: {
                type: Type.ARRAY,
                items: {
                    type: Type.OBJECT,
                    properties: {
                        title: { type: Type.STRING },
                        description: { type: Type.STRING },
                        importance: { type: Type.STRING }
                    }
                }
            }
        }
    });
    const raw = robustJSONParse(response.text || "[]");
    const topics = raw.map((t: any, i: number) => ({ ...t, id: `ct-ai-${Date.now()}-${i}` }));
    
    if (topics.length > 0) {
        dbService.saveCompetitionTopics(exam, subject, topics);
    }
    
    return topics;
};
