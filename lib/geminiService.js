const {
    MEETING_SUMMARY_SYSTEM_PROMPT,
    formatOrgContext,
    normalizeGeminiModel,
    createGeminiClient,
} = require('./aiConfig');

function isRateLimitError(error) {
    if (!error) return false;
    if (error.status === 'RESOURCE_EXHAUSTED' || error.status === 429) return true;
    if (error.code === 429 || error.code === 'RESOURCE_EXHAUSTED') return true;
    if (error.error?.code === 429 || error.error?.status === 'RESOURCE_EXHAUSTED') return true;
    const msg = String(error.message || '');
    return msg.includes('429') || msg.includes('RESOURCE_EXHAUSTED') || msg.includes('Quota exceeded');
}

async function generateContentWithRetry(generateFunc, maxRetries = 4, initialDelay = 2000) {
    let delay = initialDelay;

    for (let i = 0; i < maxRetries; i++) {
        try {
            return await generateFunc();
        } catch (error) {
            if (isRateLimitError(error)) {
                if (i === maxRetries - 1) {
                    throw new Error(`Failed after ${maxRetries} retries: ${error.message}`, { cause: error });
                }
                console.warn(`[Gemini API] 429 Rate Limit hit. Retrying in ${delay}ms... (Attempt ${i + 1}/${maxRetries})`);
                await new Promise((resolve) => setTimeout(resolve, delay));
                delay *= 2;
            } else {
                throw error;
            }
        }
    }
}

let taskQueue = Promise.resolve();

function enqueueTask(taskFn) {
    const result = taskQueue.then(async () => {
        const res = await taskFn();
        await new Promise((resolve) => setTimeout(resolve, 1000));
        return res;
    });
    taskQueue = result.catch(() => new Promise((resolve) => setTimeout(resolve, 1000)));
    return result;
}

async function summarizeTranscript(transcriptText, customApiKey = null, customModel = null, orgContext = null) {
    return enqueueTask(async () => {
        const ai = createGeminiClient(customApiKey);
        const model = normalizeGeminiModel(customModel);

        const contextPrefix = formatOrgContext(orgContext, 16000);
        const userPrompt = contextPrefix ? `${contextPrefix}\n\nTranscript:\n${transcriptText}` : `Transcript:\n${transcriptText}`;

        const response = await generateContentWithRetry(() =>
            ai.models.generateContent({
                model,
                contents: [
                    { role: 'user', parts: [{ text: `${MEETING_SUMMARY_SYSTEM_PROMPT}\n\n${userPrompt}` }] },
                ],
            }),
        );

        const summary = response.text;
        const totalTokens = response.usageMetadata?.totalTokenCount || 0;

        return {
            summary,
            totalTokens,
            toString() {
                return summary;
            },
        };
    });
}

module.exports = { summarizeTranscript, generateContentWithRetry, isRateLimitError };
