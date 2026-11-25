const { executeGroqRequest, recordActualTokens } = require('./groqRateLimiter');
const {
    DEFAULT_MODELS,
    MEETING_SUMMARY_SYSTEM_PROMPT,
    formatOrgContext,
    normalizeNvidiaModel,
} = require('./aiConfig');

// Keep each Groq summarization request comfortably under the 8,000 TPM on_demand cap
const GROQ_MAX_CHARS_PER_CALL = 14000;

function createWavBuffer(pcmBuffer, sampleRate = 16000, numChannels = 1) {
    const header = Buffer.alloc(44);
    const dataSize = pcmBuffer.length;

    header.write('RIFF', 0);
    header.writeUInt32LE(36 + dataSize, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(numChannels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(sampleRate * numChannels * 2, 28);
    header.writeUInt16LE(numChannels * 2, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36);
    header.writeUInt32LE(dataSize, 40);

    return Buffer.concat([header, pcmBuffer]);
}

// pcmBuffer must be 16kHz mono PCM16LE.
async function transcribePcm16kMono(pcmBuffer, customApiKey = null, guildId = null) {
    const apiKey = customApiKey || process.env.GROQ_API_KEY;
    if (!apiKey) {
        throw new Error('Groq API key is not configured for this server.');
    }

    return executeGroqRequest(async () => {
        const wavBuffer = createWavBuffer(pcmBuffer);
        const blob = new Blob([wavBuffer], { type: 'audio/wav' });
        const formData = new FormData();
        formData.append('file', blob, 'audio.wav');
        formData.append('model', process.env.GROQ_MODEL || DEFAULT_MODELS.groqStt);
        formData.append('temperature', '0');
        formData.append('response_format', 'verbose_json');

        const prompt = process.env.GROQ_WHISPER_PROMPT ||
            'This is a Hinglish speech conversation written in Roman script (Latin alphabet), e.g. Haan bhai main code push kar raha hoon.';
        formData.append('prompt', prompt);

        const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${apiKey}`,
            },
            body: formData,
            signal: AbortSignal.timeout(45000),
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Groq API error (${response.status}): ${errorText}`);
        }

        const data = await response.json();
        return (data.text || '').trim();
    }, { apiKey, estimatedTokens: 0, guildId });
}

function splitTextIntoChunks(text, maxChars = GROQ_MAX_CHARS_PER_CALL) {
    if (!text || text.length <= maxChars) return [text || ''];
    const lines = text.split('\n');
    const chunks = [];
    let current = '';

    for (const line of lines) {
        if (line.length > maxChars) {
            if (current) {
                chunks.push(current);
                current = '';
            }
            for (let i = 0; i < line.length; i += maxChars) {
                chunks.push(line.slice(i, i + maxChars));
            }
            continue;
        }
        const candidate = current ? `${current}\n${line}` : line;
        if (candidate.length > maxChars) {
            chunks.push(current);
            current = line;
        } else {
            current = candidate;
        }
    }
    if (current) chunks.push(current);
    return chunks;
}

async function callGroqChat({ apiKey, model, systemPrompt, userPrompt, guildId }) {
    const estimatedTokens = Math.ceil((systemPrompt.length + userPrompt.length) / 4) + 600;

    return executeGroqRequest(async () => {
        const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                model,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt },
                ],
                temperature: 0.2,
            }),
            signal: AbortSignal.timeout(60000),
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Groq API error (${response.status}): ${errorText}`);
        }

        const data = await response.json();
        const summary = data.choices?.[0]?.message?.content;
        if (!summary) {
            throw new Error('Groq API returned an empty summary.');
        }

        const totalTokens = data.usage?.total_tokens || 0;
        recordActualTokens(apiKey, totalTokens);
        return { summary, totalTokens };
    }, { apiKey, estimatedTokens, guildId });
}

async function summarizeTranscriptWithGroq(transcriptText, customApiKey = null, customModel = null, guildId = null, orgContext = null) {
    const apiKey = customApiKey || process.env.GROQ_API_KEY;
    if (!apiKey) {
        throw new Error('Groq API key is not configured for this server.');
    }

    const model = customModel || process.env.GROQ_SUMMARY_MODEL || DEFAULT_MODELS.groq;
    // Cap orgContext for Groq's 8,000 TPM budget so wiki tables don't crowd out the transcript
    const contextPrefix = formatOrgContext(orgContext, 2500);
    const fullUserPrompt = contextPrefix ? `${contextPrefix}\n\nTranscript:\n${transcriptText}` : `Transcript:\n${transcriptText}`;

    let totalTokens = 0;
    let summary;

    if (fullUserPrompt.length <= GROQ_MAX_CHARS_PER_CALL) {
        const res = await callGroqChat({
            apiKey,
            model,
            systemPrompt: MEETING_SUMMARY_SYSTEM_PROMPT,
            userPrompt: fullUserPrompt,
            guildId,
        });
        summary = res.summary;
        totalTokens = res.totalTokens;
    } else {
        // Map-reduce chunked summarization to stay safely within Groq's 8K TPM tier
        const chunkBudget = GROQ_MAX_CHARS_PER_CALL - contextPrefix.length - 400;
        const chunks = splitTextIntoChunks(transcriptText, Math.max(4000, chunkBudget));
        const chunkNotes = [];

        const chunkSystemPrompt = 'You are summarizing one segment of a longer meeting transcript. Extract concise bullet points of key discussion points (attributed to exact speaker names), decisions made, and any action items with owner and due date. Do not invent facts.';
        for (let i = 0; i < chunks.length; i++) {
            const segmentPrompt = `${contextPrefix ? `${contextPrefix}\n\n` : ''}Transcript Segment ${i + 1}/${chunks.length}:\n${chunks[i]}`;
            const res = await callGroqChat({
                apiKey,
                model,
                systemPrompt: chunkSystemPrompt,
                userPrompt: segmentPrompt,
                guildId,
            });
            chunkNotes.push(`### Segment ${i + 1}\n${res.summary}`);
            totalTokens += res.totalTokens;
        }

        const mergedNotes = chunkNotes.join('\n\n').slice(0, GROQ_MAX_CHARS_PER_CALL - contextPrefix.length - 300);
        const reducePrompt = `${contextPrefix ? `${contextPrefix}\n\n` : ''}Combined Meeting Segment Notes:\n${mergedNotes}`;
        const finalRes = await callGroqChat({
            apiKey,
            model,
            systemPrompt: MEETING_SUMMARY_SYSTEM_PROMPT,
            userPrompt: reducePrompt,
            guildId,
        });
        summary = finalRes.summary;
        totalTokens += finalRes.totalTokens;
    }

    return {
        summary,
        totalTokens,
        toString() {
            return summary;
        },
    };
}

async function callNvidiaChat({ apiKey, model, systemPrompt, userPrompt }) {
    const response = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            model,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt },
            ],
            temperature: 0.2,
        }),
        signal: AbortSignal.timeout(90000),
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`NVIDIA API error (${response.status}): ${errorText}`);
    }

    const data = await response.json();
    const message = data.choices?.[0]?.message;
    const summary = (message?.content || message?.reasoning_content || '').trim();
    if (!summary) {
        throw new Error('NVIDIA API returned an empty summary.');
    }

    return { summary, totalTokens: data.usage?.total_tokens || 0 };
}

async function summarizeTranscriptWithNvidia(transcriptText, customApiKey = null, customModel = null, _guildId = null, orgContext = null) {
    const apiKey = customApiKey || process.env.NVIDIA_API_KEY;
    if (!apiKey) {
        throw new Error('NVIDIA API key is not configured for this server or environment.');
    }

    const model = normalizeNvidiaModel(customModel);
    const contextPrefix = formatOrgContext(orgContext, 12000);
    const userPrompt = contextPrefix ? `${contextPrefix}\n\nTranscript:\n${transcriptText}` : `Transcript:\n${transcriptText}`;

    const NVIDIA_MAX_CHARS = 48000;
    let totalTokens = 0;
    let summary;

    if (userPrompt.length <= NVIDIA_MAX_CHARS) {
        const res = await callNvidiaChat({
            apiKey,
            model,
            systemPrompt: MEETING_SUMMARY_SYSTEM_PROMPT,
            userPrompt,
        });
        summary = res.summary;
        totalTokens = res.totalTokens;
    } else {
        const chunkBudget = Math.max(12000, NVIDIA_MAX_CHARS - contextPrefix.length - 500);
        const chunks = splitTextIntoChunks(transcriptText, chunkBudget);
        const chunkNotes = [];
        const chunkSystemPrompt = 'You are summarizing one segment of a longer meeting transcript. Extract concise bullet points of key discussion points (attributed to exact speaker names), decisions made, and any action items with owner and due date. Do not invent facts.';

        for (let i = 0; i < chunks.length; i++) {
            const segmentPrompt = `${contextPrefix ? `${contextPrefix}\n\n` : ''}Transcript Segment ${i + 1}/${chunks.length}:\n${chunks[i]}`;
            const res = await callNvidiaChat({
                apiKey,
                model,
                systemPrompt: chunkSystemPrompt,
                userPrompt: segmentPrompt,
            });
            chunkNotes.push(`### Segment ${i + 1}\n${res.summary}`);
            totalTokens += res.totalTokens;
        }

        const mergedNotes = chunkNotes.join('\n\n').slice(0, NVIDIA_MAX_CHARS - contextPrefix.length - 500);
        const reducePrompt = `${contextPrefix ? `${contextPrefix}\n\n` : ''}Combined Meeting Segment Notes:\n${mergedNotes}`;
        const finalRes = await callNvidiaChat({
            apiKey,
            model,
            systemPrompt: MEETING_SUMMARY_SYSTEM_PROMPT,
            userPrompt: reducePrompt,
        });
        summary = finalRes.summary;
        totalTokens += finalRes.totalTokens;
    }

    return {
        summary,
        totalTokens,
        toString() {
            return summary;
        },
    };
}

module.exports = {
    transcribePcm16kMono,
    summarizeTranscriptWithGroq,
    summarizeTranscriptWithNvidia,
    splitTextIntoChunks,
};
