const { checkGroqDailyLimit, GROQ_LIMITS } = require('./database');

// In-memory sliding window bucket per API key or 'default'
const buckets = new Map();

function getBucket(key = 'default') {
    const bucketKey = key ? String(key).slice(-10) : 'default';
    if (!buckets.has(bucketKey)) {
        buckets.set(bucketKey, {
            requests: [], // timestamps: number[]
            tokens: [],   // { time: number, tokens: number }[]
            inFlight: 0,
            lock: Promise.resolve(),
        });
    }
    return buckets.get(bucketKey);
}

function parseRetryAfter(errorMessage) {
    try {
        const match = String(errorMessage || '').match(/try again in ([\d.]+)s/i);
        if (match && match[1]) {
            const sec = parseFloat(match[1]);
            if (!isNaN(sec) && sec > 0) {
                return Math.min(65000, Math.ceil(sec * 1000) + 500);
            }
        }
    } catch {
        // ignore parse errors
    }
    return 5000;
}

async function throttleGroq(apiKey, estimatedTokens = 0, guildId = null) {
    const bucket = getBucket(apiKey);

    // Serialize slot reservation per bucket so concurrent utterances cannot bypass RPM/RPD checks
    const prevLock = bucket.lock;
    let releaseLock;
    bucket.lock = new Promise((resolve) => {
        releaseLock = resolve;
    });

    await prevLock;
    try {
        // 1. Check daily limits (1,000 RPD, 200,000 TPD) including in-flight requests
        const dailyCheck = checkGroqDailyLimit(guildId);
        const effectiveRequests = (dailyCheck.usedRequests || 0) + bucket.inFlight;
        if (!dailyCheck.allowed || effectiveRequests >= GROQ_LIMITS.requestsPerDay) {
            const reason = dailyCheck.allowed
                ? `Groq daily request limit reached (${effectiveRequests}/${GROQ_LIMITS.requestsPerDay} RPD). Limit resets in rolling 24h.`
                : dailyCheck.reason;
            throw new Error(`[Groq Rate Limit] ${reason}`);
        }

        // 2. Check 1-minute window (RPM and 8,000 TPM)
        while (true) {
            const now = Date.now();
            const oneMinAgo = now - 60000;

            bucket.requests = bucket.requests.filter((t) => t > oneMinAgo);
            bucket.tokens = bucket.tokens.filter((r) => r.time > oneMinAgo);

            if (bucket.requests.length >= GROQ_LIMITS.requestsPerMinute) {
                const oldest = bucket.requests[0];
                const waitMs = Math.max(250, 60000 - (now - oldest) + 200);
                console.warn(`[Groq RateLimiter] ${GROQ_LIMITS.requestsPerMinute} RPM reached (${bucket.requests.length} requests in 1m). Throttling for ${waitMs}ms...`);
                await new Promise((resolve) => setTimeout(resolve, waitMs));
                continue;
            }

            const currentTokens = bucket.tokens.reduce((acc, r) => acc + r.tokens, 0);
            if (currentTokens + estimatedTokens > GROQ_LIMITS.tokensPerMinute && bucket.tokens.length > 0) {
                const oldestToken = bucket.tokens[0].time;
                const waitMs = Math.max(250, 60000 - (now - oldestToken) + 200);
                console.warn(`[Groq RateLimiter] 8K TPM reached (${currentTokens} tokens in 1m). Throttling for ${waitMs}ms...`);
                await new Promise((resolve) => setTimeout(resolve, waitMs));
                continue;
            }

            bucket.requests.push(Date.now());
            if (estimatedTokens > 0) {
                bucket.tokens.push({ time: Date.now(), tokens: estimatedTokens });
            }
            bucket.inFlight++;
            break;
        }
    } finally {
        releaseLock();
    }
}

function releaseInFlight(apiKey) {
    const bucket = getBucket(apiKey);
    if (bucket.inFlight > 0) {
        bucket.inFlight--;
    }
}

function recordActualTokens(apiKey, tokens) {
    if (!tokens || tokens <= 0) return;
    const bucket = getBucket(apiKey);
    bucket.tokens.push({ time: Date.now(), tokens });
}

async function executeGroqRequest(fn, { apiKey, estimatedTokens = 0, guildId = null, maxRetries = 2 }) {
    await throttleGroq(apiKey, estimatedTokens, guildId);

    try {
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                return await fn();
            } catch (error) {
                const isRateLimit = String(error?.message || '').includes('429');
                if (isRateLimit && attempt < maxRetries) {
                    const waitMs = parseRetryAfter(error?.message);
                    console.warn(`[Groq RateLimiter] 429 received from Groq. Retrying in ${waitMs}ms (attempt ${attempt + 1}/${maxRetries})...`);
                    await new Promise((resolve) => setTimeout(resolve, waitMs));
                    continue;
                }
                throw error;
            }
        }
    } finally {
        releaseInFlight(apiKey);
    }
}

module.exports = {
    GROQ_LIMITS,
    executeGroqRequest,
    recordActualTokens,
    throttleGroq,
};
