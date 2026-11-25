const {
    joinVoiceChannel,
    entersState,
    VoiceConnectionStatus,
    EndBehaviorType,
} = require('@discordjs/voice');
const {
    MessageFlags,
    AttachmentBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
} = require('discord.js');
const { pipeline } = require('node:stream/promises');

const { Pcm48kStereoTo16kMono } = require('../../../lib/pcmResampler');
const { ResilientOpusDecoder } = require('../../../lib/opusDecoder');
const { createSession, getSession, endSession } = require('../../../lib/notesSessions');
const { transcribePcm16kMono: transcribeWithGroq, summarizeTranscriptWithGroq, summarizeTranscriptWithNvidia } = require('../../../lib/groqService');
const { summarizeTranscript } = require('../../../lib/geminiService');
const { DEFAULT_MODELS, resolveSummarySettings } = require('../../../lib/aiConfig');
const { fetchOrgInfoContext, syncOrgInfoForGuild } = require('../../../lib/orgInfoSync');
const { syncMeetingTasksAndPersonalNotes } = require('../../../lib/memberAssistant');
const {
    getGuildConfig,
    getNotesChannelId,
    recordSession,
    getSessionById,
    logApiRequest,
    checkGroqDailyLimit,
} = require('../../../lib/guildConfig');
const { publishMeetingNotes, getNotionClient } = require('../../../lib/notion');
const { sanitizeErrorMessage } = require('../../../lib/safeError');
const { truncateDiscordText } = require('../../../lib/discordUtils');

// ~1.0s of 16kHz mono 16-bit audio; filters short noise blips and cuts Groq STT RPD burn & hallucinations
const MIN_UTTERANCE_BYTES = 32000;
const retryCache = new Map();
const RETRY_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

function formatTimestamp(date) {
    return date.toTimeString().slice(0, 8);
}

function sanitizeForFilename(text) {
    return text.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function buildFilename(session) {
    const names = [...session.participants.values()].map(sanitizeForFilename).filter(Boolean);
    const namesPart = names.length ? names.join('-') : 'no-speakers';
    const date = session.startedAt.toISOString().slice(0, 10);
    const time = session.startedAt.toTimeString().slice(0, 5).replace(':', '');
    const filename = `notes_${namesPart}_${date}_${time}.md`;
    return filename.length > 200 ? `notes_${names.length}-people_${date}_${time}.md` : filename;
}

function buildNotesMarkdown(session, summary) {
    const date = session.startedAt.toLocaleDateString('en-CA');
    const startTime = session.startedAt.toTimeString().slice(0, 8);
    const endTime = new Date().toTimeString().slice(0, 8);
    const participants = [...session.participants.values()];

    return [
        `# Voice Notes — ${session.voiceChannelName}`,
        '',
        `- **Date:** ${date}`,
        `- **Time:** ${startTime} – ${endTime}`,
        `- **Participants:** ${participants.length ? participants.join(', ') : '_none captured_'}`,
        '',
        '---',
        '',
        summary,
        '',
    ].join('\n');
}

function buildDiscordSummaryPreview(session, summary, suffix = '') {
    const header = `📝 **Soren's Meeting Notes — ${session.voiceChannelName || 'Voice Meeting'}**`;
    const body = String(summary || '').trim();
    const maxBodyLen = Math.max(400, 1850 - header.length - suffix.length - 12);
    const previewBody = body.length > maxBodyLen ? `${body.slice(0, maxBodyLen - 3)}...` : body;
    return `${header}\n\n${previewBody}${suffix ? `\n${suffix}` : ''}`;
}

function getActiveSummaryModel(provider, { nvidiaModel, geminiModel, groqModel }) {
    if (provider === 'nvidia') return nvidiaModel;
    if (provider === 'gemini') return geminiModel;
    return groqModel;
}

async function deliverOutput(interaction, guildId, payload) {
    const channelId = getNotesChannelId(guildId);
    if (!channelId || channelId === interaction.channelId) {
        await interaction.editReply(payload);
        return;
    }

    try {
        const channel = await interaction.guild.channels.fetch(channelId);
        await channel.send(payload);
        await interaction.editReply(`Posted in <#${channelId}>.`);
    } catch (error) {
        console.error(`[notes:${guildId}] failed to post to configured notes channel ${channelId}:`, error);
        const prefix = `Couldn't post to the configured notes channel (<#${channelId}>), posting here instead:\n`;
        const safeContent = truncateDiscordText(payload.content ?? '', 1900 - prefix.length);
        await interaction.editReply({
            content: `${prefix}${safeContent}`,
            files: payload.files,
            components: payload.components,
        });
    }
}

function cleanRetryCache() {
    const now = Date.now();
    for (const [id, item] of retryCache.entries()) {
        if (now - item.createdAt > RETRY_TTL_MS) {
            retryCache.delete(id);
        }
    }
}

function captureUserUtterance(receiver, userId, session, guild) {
    if (session.activeStreams.has(userId)) return;
    session.activeStreams.add(userId);
    const timestamp = new Date();

    const opusStream = receiver.subscribe(userId, {
        end: { behavior: EndBehaviorType.AfterSilence, duration: 1000 },
    });
    const decoder = new ResilientOpusDecoder({ rate: 48000, channels: 2, frameSize: 960 });
    const resampler = new Pcm48kStereoTo16kMono();
    const chunks = [];
    resampler.on('data', (chunk) => chunks.push(chunk));

    const finish = async () => {
        session.activeStreams.delete(userId);
        const pcm = Buffer.concat(chunks);
        if (pcm.length < MIN_UTTERANCE_BYTES) return;

        const model = process.env.GROQ_MODEL || DEFAULT_MODELS.groqStt;
        let text;
        try {
            text = await transcribeWithGroq(pcm, session.groqApiKey, guild.id);
            logApiRequest({
                guildId: guild.id,
                service: 'groq_stt',
                model,
                status: 'success',
            });
        } catch (error) {
            console.error(`[notes:${guild.id}] Groq STT transcription failed:`, error.message || error);
            const msg = error?.message || String(error);
            const isRateLimit = msg.includes('429') || msg.includes('Rate Limit');
            logApiRequest({
                guildId: guild.id,
                service: 'groq_stt',
                model,
                status: isRateLimit ? 'rate_limited' : 'error',
                errorMessage: msg,
            });
            if (!session.sttErrors) session.sttErrors = [];
            if (!session.sttErrors.includes(msg)) {
                session.sttErrors.push(msg);
            }
            return;
        }
        if (!text) return;

        const member = await guild.members.fetch(userId).catch(() => null);
        const speaker = member?.displayName ?? `<@${userId}>`;
        session.participants.set(userId, speaker);
        const entry = { speaker, text, timestamp };
        session.transcript.push(entry);
        console.log(`[notes:${guild.id}] ${formatTimestamp(entry.timestamp)} ${speaker}: ${text}`);
    };

    const settle = (runner) => {
        const promise = runner().catch((error) => {
            console.error(`[notes:${guild.id}] unexpected error finishing utterance for ${userId}:`, error);
        });
        session.pendingTranscriptions.add(promise);
        promise.finally(() => session.pendingTranscriptions.delete(promise));
    };

    settle(async () => {
        try {
            await pipeline(opusStream, decoder, resampler);
        } catch (error) {
            const msg = String(error?.message || '');
            if (msg.includes('DecryptionFailed')) {
                console.warn(`[notes:${guild.id}] Transient voice packet decryption failure for ${userId}: ${msg}`);
            } else if (error.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
                console.error(`[notes:${guild.id}] Audio pipeline error for ${userId}:`, error);
            }
        }
        await finish();
    });
}

async function startNotes(interaction) {
    const guildId = interaction.guildId;
    if (getSession(guildId)) {
        await interaction.reply({
            content: 'Already taking notes in this server. Use `/notes stop` first.',
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    const guildConfig = getGuildConfig(guildId);
    const groqKey = guildConfig.groqApiKey || process.env.GROQ_API_KEY;

    if (!groqKey) {
        await interaction.reply({
            content: '**No Groq API Key set for this server.**\nA server admin must configure an API key first using `/notes setkey groq_key:<your_groq_api_key>`.',
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    const dailyCheck = checkGroqDailyLimit(guildId);
    if (!dailyCheck.allowed) {
        await interaction.reply({
            content: `❌ **Cannot start notes:** ${dailyCheck.reason}\n\nServer admins can configure a custom Groq API key using \`/notes setkey groq_key:<your_key>\` to bypass shared limits.`,
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    const voiceChannel = interaction.member.voice.channel;
    if (!voiceChannel) {
        await interaction.reply({
            content: 'You need to be in a voice channel first!',
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    await interaction.deferReply();

    const connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: voiceChannel.guild.id,
        adapterCreator: voiceChannel.guild.voiceAdapterCreator,
        selfDeaf: false,
    });

    connection.on('stateChange', (oldState, newState) => {
        if (newState.status === VoiceConnectionStatus.Disconnected) {
            console.warn(`[notes:${guildId}] voice connection unexpectedly disconnected (was ${oldState.status})`);
        } else if (newState.status === VoiceConnectionStatus.Destroyed) {
            console.info(`[notes:${guildId}] voice connection destroyed, cleaning up session`);
            endSession(guildId);
        }
    });

    try {
        await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
    } catch (error) {
        console.error(`[notes:${guildId}] voice connection never became Ready:`, error);
        connection.destroy();
        await interaction.editReply(
            `**Failed to connect to voice channel:** ${error.message || 'Connection timeout'}`,
        );
        return;
    }

    const settings = resolveSummarySettings(guildConfig, {
        provider: interaction.options.getString('provider'),
        model: interaction.options.getString('model'),
    });

    const session = createSession(guildId, {
        connection,
        textChannelId: interaction.channelId,
        voiceChannelName: voiceChannel.name,
        startedAt: new Date(),
        participants: new Map(),
        groqApiKey: groqKey,
        geminiApiKey: settings.geminiKey,
        nvidiaApiKey: settings.nvidiaKey,
        summaryProvider: settings.provider,
        groqModel: settings.groqModel,
        geminiModel: settings.geminiModel,
        nvidiaModel: settings.nvidiaModel,
        sttErrors: [],
    });

    const receiver = connection.receiver;
    const onSpeakingStart = (userId) => captureUserUtterance(receiver, userId, session, voiceChannel.guild);
    receiver.speaking.on('start', onSpeakingStart);
    session.onSpeakingStart = onSpeakingStart;

    const modelName = process.env.GROQ_MODEL || DEFAULT_MODELS.groqStt;
    const activeSummaryModel = getActiveSummaryModel(settings.provider, settings);
    await interaction.editReply(
        `🎙️ Tuned in to **${voiceChannel.name}** and taking notes (${modelName} STT | ${settings.provider.toUpperCase()} \`${activeSummaryModel}\`). Try not to talk over each other too much — run \`/notes stop\` when done!`,
    );
}

async function summarizeTranscriptContent(transcriptText, { guildId, groqKey, geminiKey, nvidiaKey, provider, groqModel, geminiModel, nvidiaModel, orgContext = null }) {
    let effectiveOrgContext = orgContext;
    if (effectiveOrgContext === null && guildId) {
        try {
            const guildConfig = getGuildConfig(guildId);
            if (guildConfig.notionToken && (guildConfig.orgInfoPageId || guildConfig.wikiPageId)) {
                effectiveOrgContext = await fetchOrgInfoContext(guildConfig.notionToken, guildConfig.orgInfoPageId, guildConfig.wikiPageId);
                if (effectiveOrgContext) {
                    console.log(`[notes:${guildId}] Injected fresh Org Info & Central Wiki context into summarization (${effectiveOrgContext.length} chars).`);
                }
            }
        } catch (err) {
            console.warn(`[notes:${guildId}] Non-fatal: Failed to fetch Org Info context for summarization:`, err.message);
            effectiveOrgContext = '';
        }
    }

    let summary;
    let totalTokens = 0;
    let lastError = null;

    const preferredProvider = (provider || 'nvidia').toLowerCase();
    const candidateProviders = [preferredProvider];
    ['nvidia', 'gemini', 'groq'].forEach((p) => {
        if (!candidateProviders.includes(p)) candidateProviders.push(p);
    });

    for (const p of candidateProviders) {
        if (p === 'nvidia' && (nvidiaKey || process.env.NVIDIA_API_KEY)) {
            const effectiveNvidiaKey = nvidiaKey || process.env.NVIDIA_API_KEY;
            const effectiveNvidiaModel = nvidiaModel || process.env.NVIDIA_MODEL || DEFAULT_MODELS.nvidia;
            try {
                const res = await summarizeTranscriptWithNvidia(transcriptText, effectiveNvidiaKey, effectiveNvidiaModel, guildId, effectiveOrgContext);
                summary = res.summary || res;
                totalTokens = res.totalTokens || 0;
                if (guildId) {
                    logApiRequest({
                        guildId,
                        service: 'nvidia_summary',
                        model: effectiveNvidiaModel,
                        status: 'success',
                        tokensUsed: totalTokens,
                    });
                }
                break;
            } catch (error) {
                lastError = error;
                console.warn('[notes] NVIDIA summarization failed:', error.message || error);
                if (guildId) {
                    logApiRequest({
                        guildId,
                        service: 'nvidia_summary',
                        model: effectiveNvidiaModel,
                        status: 'error',
                        errorMessage: error?.message || String(error),
                    });
                }
            }
        } else if (p === 'gemini' && (geminiKey || process.env.GEMINI_API_KEY)) {
            const effectiveGeminiKey = geminiKey || process.env.GEMINI_API_KEY;
            const effectiveGeminiModel = geminiModel || process.env.GEMINI_MODEL || DEFAULT_MODELS.gemini;
            try {
                const res = await summarizeTranscript(transcriptText, effectiveGeminiKey, effectiveGeminiModel, effectiveOrgContext);
                summary = res.summary || res;
                totalTokens = res.totalTokens || 0;
                if (guildId) {
                    logApiRequest({
                        guildId,
                        service: 'gemini_summary',
                        model: effectiveGeminiModel,
                        status: 'success',
                        tokensUsed: totalTokens,
                    });
                }
                break;
            } catch (error) {
                lastError = error;
                console.warn('[notes] Gemini summarization failed:', error.message || error);
                if (guildId) {
                    const isRateLimit = String(error?.message || '').includes('429');
                    logApiRequest({
                        guildId,
                        service: 'gemini_summary',
                        model: effectiveGeminiModel,
                        status: isRateLimit ? 'rate_limited' : 'error',
                        errorMessage: error?.message || String(error),
                    });
                }
            }
        } else if (p === 'groq' && (groqKey || process.env.GROQ_API_KEY)) {
            const effectiveGroqKey = groqKey || process.env.GROQ_API_KEY;
            const effectiveGroqModel = groqModel || process.env.GROQ_SUMMARY_MODEL || DEFAULT_MODELS.groq;
            try {
                const res = await summarizeTranscriptWithGroq(transcriptText, effectiveGroqKey, effectiveGroqModel, guildId, effectiveOrgContext);
                summary = res.summary || res;
                totalTokens = res.totalTokens || 0;
                if (guildId) {
                    logApiRequest({
                        guildId,
                        service: 'groq_summary',
                        model: effectiveGroqModel,
                        status: 'success',
                        tokensUsed: totalTokens,
                    });
                }
                break;
            } catch (error) {
                lastError = error;
                console.warn('[notes] Groq summarization failed:', error.message || error);
                if (guildId) {
                    const isRateLimit = String(error?.message || '').includes('429');
                    logApiRequest({
                        guildId,
                        service: 'groq_summary',
                        model: effectiveGroqModel,
                        status: isRateLimit ? 'rate_limited' : 'error',
                        errorMessage: error?.message || String(error),
                    });
                }
            }
        }
    }

    if (!summary && !lastError) {
        lastError = new Error('No API key configured for summarization.');
    }

    return { summary, totalTokens, lastError };
}

async function publishAndSyncNotes({ guildId, session, summary, includeOrgSync = true }) {
    const notesMarkdown = buildNotesMarkdown(session, summary);
    const notesFile = new AttachmentBuilder(Buffer.from(notesMarkdown, 'utf-8'), { name: buildFilename(session) });
    const guildConfig = getGuildConfig(guildId);

    let notionOutput = '';
    if (guildConfig.notionToken && guildConfig.meetingsDbId) {
        try {
            const notionRes = await publishMeetingNotes({
                token: guildConfig.notionToken,
                meetingsDbId: guildConfig.meetingsDbId,
                session,
                markdownContent: notesMarkdown,
            });
            if (notionRes.published && notionRes.url) {
                notionOutput = `\n- **Notion Wiki:** [Open Meeting Page in Notion](${notionRes.url})`;
            }
        } catch (err) {
            console.error(`[notes:${guildId}] Non-fatal failure publishing to Notion:`, err.message);
        }
    }

    let orgInfoOutput = '';
    if (includeOrgSync && guildConfig.notionToken && guildConfig.orgInfoPageId) {
        if (guildConfig.syncMode === 'automatic') {
            try {
                const syncRes = await syncOrgInfoForGuild({
                    guildId,
                    meetingNotes: notesMarkdown,
                    force: true,
                });
                if (syncRes.success && syncRes.applied > 0) {
                    const nbNotice = syncRes.noticeBoardUpdated ? ' & Central Notice Board' : '';
                    orgInfoOutput = `\n- **Org Info:** 🔄 Auto-synced ${syncRes.applied} facts/decisions to Org Info${nbNotice}.`;
                }
            } catch (err) {
                console.error(`[notes:${guildId}] Org Info auto-sync failed non-fatally:`, err.message);
            }
        } else {
            orgInfoOutput = '\n- **Org Info:** ⏸️ Sync mode is manual. Use `/notes sync` to sync facts into Org Info.';
        }
    }

    let taskSyncOutput = '';
    if (guildConfig.notionToken && (guildConfig.actionItemsDbId || guildConfig.membersDbId)) {
        try {
            const client = getNotionClient(guildConfig.notionToken);
            const taskSyncRes = await syncMeetingTasksAndPersonalNotes({
                client,
                actionItemsDbId: guildConfig.actionItemsDbId,
                membersDbId: guildConfig.membersDbId,
                meetingNotes: notesMarkdown,
                participants: session.participants,
                session,
            });
            if (taskSyncRes.tasksCreated > 0 || taskSyncRes.membersUpdated > 0) {
                taskSyncOutput = `\n- **Tasks & Personal Notes:** 📋 Synced ${taskSyncRes.tasksCreated} action item(s) to Action Items DB and updated ${taskSyncRes.membersUpdated} member page(s).`;
            }
        } catch (err) {
            console.error(`[notes:${guildId}] Non-fatal error syncing meeting tasks to personal notes:`, err.message);
        }
    }

    return {
        notesFile,
        suffix: `${notionOutput}${orgInfoOutput}${taskSyncOutput}`,
    };
}

async function stopNotes(interaction) {
    const guildId = interaction.guildId;
    const session = getSession(guildId);
    if (!session) {
        await interaction.reply({
            content: 'No notes session is running in this server.',
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    await interaction.deferReply();

    session.connection.receiver.speaking.removeListener('start', session.onSpeakingStart);
    session.connection.destroy();
    endSession(guildId);

    if (session.pendingTranscriptions.size > 0) {
        const count = session.pendingTranscriptions.size;
        await interaction.editReply(
            `Stopping... waiting for ${count} in-flight transcription${count > 1 ? 's' : ''} to complete...`,
        );
        await Promise.allSettled([...session.pendingTranscriptions]);
    }

    if (session.transcript.length === 0) {
        recordSession({
            guildId,
            channelId: session.textChannelId,
            channelName: session.voiceChannelName,
            startedAt: session.startedAt,
            endedAt: new Date(),
            durationSeconds: (Date.now() - session.startedAt.getTime()) / 1000,
            participantCount: session.participants.size,
            participants: [...session.participants.values()],
            summaryProvider: session.summaryProvider,
            summaryModel: getActiveSummaryModel(session.summaryProvider, session),
            transcriptEntriesCount: 0,
            status: 'empty',
            errorMessage: session.sttErrors?.join('; ') || null,
        });
        let msg = 'Stopped. Either everyone practiced telepathy or nobody spoke long enough to catch — no notes to summarize.';
        if (session.sttErrors && session.sttErrors.length > 0) {
            const errorList = session.sttErrors.slice(0, 5).map((e) => `- ${truncateDiscordText(e, 120)}`).join('\n');
            const extra = session.sttErrors.length > 5 ? `\n- _...and ${session.sttErrors.length - 5} more STT error(s)._` : '';
            msg += `\n\n**Speech-to-Text Errors Encountered:**\n${errorList}${extra}`;
        }
        await interaction.editReply(truncateDiscordText(msg, 1950));
        return;
    }

    session.transcript.sort((a, b) => a.timestamp - b.timestamp);
    const transcriptText = session.transcript
        .map((entry) => `[${formatTimestamp(entry.timestamp)}] ${entry.speaker}: ${entry.text}`)
        .join('\n');

    const provider = session.summaryProvider || 'nvidia';
    const summaryModel = getActiveSummaryModel(provider, session);

    const { summary, lastError } = await summarizeTranscriptContent(transcriptText, {
        guildId,
        groqKey: session.groqApiKey,
        geminiKey: session.geminiApiKey,
        nvidiaKey: session.nvidiaApiKey,
        provider,
        groqModel: session.groqModel,
        geminiModel: session.geminiModel,
        nvidiaModel: session.nvidiaModel,
    });

    if (!summary) {
        cleanRetryCache();
        const failureReason = sanitizeErrorMessage(lastError) || 'Unknown error occurred during API summarization.';
        const failedRowId = recordSession({
            guildId,
            channelId: session.textChannelId,
            channelName: session.voiceChannelName,
            startedAt: session.startedAt,
            endedAt: new Date(),
            durationSeconds: (Date.now() - session.startedAt.getTime()) / 1000,
            participantCount: session.participants.size,
            participants: [...session.participants.values()],
            summaryProvider: provider,
            summaryModel,
            transcriptEntriesCount: session.transcript.length,
            status: 'failed',
            errorMessage: failureReason,
            rawTranscript: transcriptText,
        });

        const retryId = failedRowId
            ? `db_${failedRowId}`
            : (Date.now().toString(36) + Math.random().toString(36).slice(2, 8));
        retryCache.set(retryId, {
            guildId,
            sessionInfo: {
                voiceChannelName: session.voiceChannelName,
                startedAt: session.startedAt,
                participants: new Map(session.participants),
                groqApiKey: session.groqApiKey,
                geminiApiKey: session.geminiApiKey,
                nvidiaApiKey: session.nvidiaApiKey,
                summaryProvider: provider,
                groqModel: session.groqModel,
                geminiModel: session.geminiModel,
                nvidiaModel: session.nvidiaModel,
            },
            transcriptText,
            createdAt: Date.now(),
        });

        const retryRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`retry_notes:${retryId}`)
                .setLabel('Retry Summarization')
                .setStyle(ButtonStyle.Primary),
        );

        const transcriptFile = new AttachmentBuilder(Buffer.from(transcriptText, 'utf-8'), { name: 'transcript.txt' });
        await deliverOutput(interaction, guildId, {
            content: `**Summarization Failed:** ${failureReason}\nHere is the raw transcript:`,
            files: [transcriptFile],
            components: [retryRow],
        });
        return;
    }

    recordSession({
        guildId,
        channelId: session.textChannelId,
        channelName: session.voiceChannelName,
        startedAt: session.startedAt,
        endedAt: new Date(),
        durationSeconds: (Date.now() - session.startedAt.getTime()) / 1000,
        participantCount: session.participants.size,
        participants: [...session.participants.values()],
        summaryProvider: provider,
        summaryModel,
        transcriptEntriesCount: session.transcript.length,
        status: 'completed',
        summaryText: summary,
        rawTranscript: transcriptText,
    });

    const { notesFile, suffix } = await publishAndSyncNotes({
        guildId,
        session,
        summary,
        includeOrgSync: true,
    });

    await deliverOutput(interaction, guildId, {
        content: buildDiscordSummaryPreview(session, summary, suffix),
        files: [notesFile],
    });
}

async function handleButton(interaction) {
    if (!interaction.customId?.startsWith('retry_notes:')) return;
    const retryId = interaction.customId.slice('retry_notes:'.length);
    let entry = retryCache.get(retryId);
    if (!entry && retryId.startsWith('db_')) {
        const dbSessionId = Number(retryId.slice(3));
        const sessionRow = Number.isFinite(dbSessionId) ? getSessionById(dbSessionId) : null;
        if (sessionRow && sessionRow.raw_transcript) {
            if (sessionRow.guild_id !== interaction.guildId) {
                await interaction.reply({
                    content: '⛔ **Access Denied:** You cannot trigger a retry for a session from another server.',
                    flags: MessageFlags.Ephemeral,
                });
                return;
            }
            let participantNames;
            try {
                participantNames = JSON.parse(sessionRow.participants || '[]');
            } catch {
                participantNames = [];
            }
            const participantMap = new Map(participantNames.map((name, idx) => [String(idx), name]));
            entry = {
                guildId: sessionRow.guild_id,
                sessionInfo: {
                    voiceChannelName: sessionRow.channel_name || 'Voice Meeting',
                    startedAt: new Date(sessionRow.started_at || Date.now()),
                    participants: participantMap,
                    summaryProvider: sessionRow.summary_provider,
                },
                transcriptText: sessionRow.raw_transcript,
            };
        }
    }
    if (!entry) {
        await interaction.reply({
            content: 'This retry session has expired or the bot was restarted. Please refer to the raw transcript attached above.',
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    if (entry.guildId !== interaction.guildId) {
        await interaction.reply({
            content: '⛔ **Access Denied:** You cannot trigger a retry for a session from another server.',
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    await interaction.deferReply();

    const { guildId, sessionInfo, transcriptText } = entry;
    const guildConfig = getGuildConfig(guildId);
    const settings = resolveSummarySettings({
        ...sessionInfo,
        ...guildConfig,
    });

    const { summary, lastError } = await summarizeTranscriptContent(transcriptText, {
        guildId,
        groqKey: settings.groqKey,
        geminiKey: settings.geminiKey,
        nvidiaKey: settings.nvidiaKey,
        provider: settings.provider,
        groqModel: settings.groqModel,
        geminiModel: settings.geminiModel,
        nvidiaModel: settings.nvidiaModel,
    });

    if (!summary) {
        const failureReason = sanitizeErrorMessage(lastError) || 'Unknown error occurred during API summarization.';
        const retryRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`retry_notes:${retryId}`)
                .setLabel('Retry Summarization')
                .setStyle(ButtonStyle.Primary),
        );
        await interaction.editReply({
            content: `**Retry Failed:** ${failureReason}\nYou can update your configuration via \`/notes setmodel\` and click retry again:`,
            components: [retryRow],
        });
        return;
    }

    const disabledRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`retried_${retryId}`)
            .setLabel('Retried Successfully')
            .setStyle(ButtonStyle.Success)
            .setDisabled(true),
    );
    await interaction.message?.edit({ components: [disabledRow] }).catch(() => {});

    const effectiveSession = {
        ...sessionInfo,
        startedAt: sessionInfo.startedAt instanceof Date ? sessionInfo.startedAt : new Date(sessionInfo.startedAt),
    };

    recordSession({
        guildId,
        channelId: interaction.channelId,
        channelName: sessionInfo.voiceChannelName,
        startedAt: effectiveSession.startedAt,
        endedAt: new Date(),
        durationSeconds: (Date.now() - effectiveSession.startedAt.getTime()) / 1000,
        participantCount: sessionInfo.participants?.size || 0,
        participants: sessionInfo.participants ? [...sessionInfo.participants.values()] : [],
        summaryProvider: settings.provider,
        summaryModel: getActiveSummaryModel(settings.provider, settings),
        transcriptEntriesCount: transcriptText.split('\n').filter(Boolean).length,
        status: 'completed',
        summaryText: summary,
    });

    const { notesFile, suffix } = await publishAndSyncNotes({
        guildId,
        session: effectiveSession,
        summary,
        includeOrgSync: false,
    });

    await deliverOutput(interaction, guildId, {
        content: `**Notes successfully summarized on retry:**${suffix}`,
        files: [notesFile],
    });
}

module.exports = {
    startNotes,
    stopNotes,
    handleButton,
    deliverOutput,
    summarizeTranscriptContent,
    retryCache,
};
