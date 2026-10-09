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
const { transcribePcm16kMono: transcribeWithGroq, summarizeTranscriptWithGroq } = require('../../../lib/groqService');
const { summarizeTranscript } = require('../../../lib/geminiService');
const { fetchOrgInfoContext, syncOrgInfoForGuild } = require('../../../lib/orgInfoSync');
const { syncMeetingTasksAndPersonalNotes } = require('../../../lib/memberAssistant');
const {
    getGuildConfig,
    getNotesChannelId,
    recordSession,
    logApiRequest,
    checkGroqDailyLimit,
} = require('../../../lib/guildConfig');
const { publishMeetingNotes, getNotionClient } = require('../../../lib/notion');
const { sanitizeErrorMessage } = require('../../../lib/safeError');
const { truncateDiscordText } = require('../../../lib/discordUtils');

const MIN_UTTERANCE_BYTES = 16000; // ~0.5s of 16kHz mono 16-bit audio, filters out noise blips
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
    const date = session.startedAt.toLocaleDateString('en-CA'); // YYYY-MM-DD
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

        const model = process.env.GROQ_MODEL || 'whisper-large-v3-turbo';
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
            console.error(`[notes:${guild.id}] Groq STT transcription failed:`, error);
            const isRateLimit = String(error?.message || '').includes('429') || String(error?.message || '').includes('Rate Limit');
            logApiRequest({
                guildId: guild.id,
                service: 'groq_stt',
                model,
                status: isRateLimit ? 'rate_limited' : 'error',
                errorMessage: error?.message || String(error),
            });
            if (!session.sttErrors) session.sttErrors = [];
            const msg = error?.message || String(error);
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
            if (error.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
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

    // Check Groq daily limit upfront before connecting to voice
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

    const providerOverride = interaction.options.getString('provider');
    const modelOverride = interaction.options.getString('model');

    const summaryProvider = providerOverride || guildConfig.summaryProvider || process.env.SUMMARY_PROVIDER || 'groq';
    const groqModel = (summaryProvider === 'groq' && modelOverride)
        ? modelOverride.trim()
        : (guildConfig.groqModel || process.env.GROQ_SUMMARY_MODEL || 'openai/gpt-oss-120b');
    const geminiModel = (summaryProvider === 'gemini' && modelOverride)
        ? modelOverride.trim()
        : (guildConfig.geminiModel || process.env.GEMINI_MODEL || 'gemini-2.5-flash');

    const session = createSession(guildId, {
        connection,
        textChannelId: interaction.channelId,
        voiceChannelName: voiceChannel.name,
        startedAt: new Date(),
        participants: new Map(),
        groqApiKey: groqKey,
        geminiApiKey: guildConfig.geminiApiKey || process.env.GEMINI_API_KEY,
        summaryProvider,
        groqModel,
        geminiModel,
        sttErrors: [],
    });

    const receiver = connection.receiver;
    const onSpeakingStart = (userId) => captureUserUtterance(receiver, userId, session, voiceChannel.guild);
    receiver.speaking.on('start', onSpeakingStart);
    session.onSpeakingStart = onSpeakingStart;

    const modelName = process.env.GROQ_MODEL || 'whisper-large-v3-turbo';
    const activeSummaryModel = summaryProvider === 'gemini' ? geminiModel : groqModel;
    await interaction.editReply(
        `Joined **${voiceChannel.name}** and started taking notes (${modelName} STT | ${summaryProvider.toUpperCase()} \`${activeSummaryModel}\` Summary). Run \`/notes stop\` when done.`,
    );
}

async function summarizeTranscriptContent(transcriptText, { guildId, groqKey, geminiKey, provider, groqModel, geminiModel, orgContext = null }) {
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

    if (provider === 'gemini' && geminiKey) {
        try {
            const res = await summarizeTranscript(transcriptText, geminiKey, geminiModel, effectiveOrgContext);
            summary = res.summary || res;
            totalTokens = res.totalTokens || 0;
            if (guildId) {
                logApiRequest({
                    guildId,
                    service: 'gemini_summary',
                    model: geminiModel,
                    status: 'success',
                    tokensUsed: totalTokens,
                });
            }
        } catch (error) {
            lastError = error;
            console.warn('[notes] Gemini summarization failed, trying Groq fallback:', error);
            if (guildId) {
                const isRateLimit = String(error?.message || '').includes('429');
                logApiRequest({
                    guildId,
                    service: 'gemini_summary',
                    model: geminiModel,
                    status: isRateLimit ? 'rate_limited' : 'error',
                    errorMessage: error?.message || String(error),
                });
            }
            if (groqKey) {
                try {
                    const res = await summarizeTranscriptWithGroq(transcriptText, groqKey, groqModel, guildId, effectiveOrgContext);
                    summary = res.summary || res;
                    totalTokens = res.totalTokens || 0;
                    if (guildId) {
                        logApiRequest({
                            guildId,
                            service: 'groq_summary',
                            model: groqModel,
                            status: 'success',
                            tokensUsed: totalTokens,
                        });
                    }
                } catch (groqError) {
                    lastError = groqError;
                    console.error('All summarization attempts failed:', groqError);
                    if (guildId) {
                        const isRateLimit = String(groqError?.message || '').includes('429');
                        logApiRequest({
                            guildId,
                            service: 'groq_summary',
                            model: groqModel,
                            status: isRateLimit ? 'rate_limited' : 'error',
                            errorMessage: groqError?.message || String(groqError),
                        });
                    }
                }
            }
        }
    } else if (groqKey) {
        try {
            const res = await summarizeTranscriptWithGroq(transcriptText, groqKey, groqModel, guildId, effectiveOrgContext);
            summary = res.summary || res;
            totalTokens = res.totalTokens || 0;
            if (guildId) {
                logApiRequest({
                    guildId,
                    service: 'groq_summary',
                    model: groqModel,
                    status: 'success',
                    tokensUsed: totalTokens,
                });
            }
        } catch (error) {
            lastError = error;
            console.warn('[notes] Groq summarization failed, trying Gemini fallback:', error);
            if (guildId) {
                const isRateLimit = String(error?.message || '').includes('429');
                logApiRequest({
                    guildId,
                    service: 'groq_summary',
                    model: groqModel,
                    status: isRateLimit ? 'rate_limited' : 'error',
                    errorMessage: error?.message || String(error),
                });
            }
            if (geminiKey) {
                try {
                    const res = await summarizeTranscript(transcriptText, geminiKey, geminiModel, effectiveOrgContext);
                    summary = res.summary || res;
                    totalTokens = res.totalTokens || 0;
                    if (guildId) {
                        logApiRequest({
                            guildId,
                            service: 'gemini_summary',
                            model: geminiModel,
                            status: 'success',
                            tokensUsed: totalTokens,
                        });
                    }
                } catch (geminiError) {
                    lastError = geminiError;
                    console.error('All summarization attempts failed:', geminiError);
                    if (guildId) {
                        const isRateLimit = String(geminiError?.message || '').includes('429');
                        logApiRequest({
                            guildId,
                            service: 'gemini_summary',
                            model: geminiModel,
                            status: isRateLimit ? 'rate_limited' : 'error',
                            errorMessage: geminiError?.message || String(geminiError),
                        });
                    }
                }
            }
        }
    } else {
        lastError = new Error('No API key configured for summarization.');
    }

    return { summary, totalTokens, lastError };
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
            summaryModel: session.summaryProvider === 'gemini' ? session.geminiModel : session.groqModel,
            transcriptEntriesCount: 0,
            status: 'empty',
            errorMessage: session.sttErrors?.join('; ') || null,
        });
        let msg = 'Stopped. No speech was captured, so there are no notes to summarize.';
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

    const groqKey = session.groqApiKey;
    const geminiKey = session.geminiApiKey;
    const provider = session.summaryProvider || 'groq';
    const groqModel = session.groqModel;
    const geminiModel = session.geminiModel;

    const { summary, lastError } = await summarizeTranscriptContent(transcriptText, {
        guildId,
        groqKey,
        geminiKey,
        provider,
        groqModel,
        geminiModel,
    });

    if (!summary) {
        cleanRetryCache();
        const failureReason = sanitizeErrorMessage(lastError) || 'Unknown error occurred during API summarization.';
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
            summaryModel: provider === 'gemini' ? geminiModel : groqModel,
            transcriptEntriesCount: session.transcript.length,
            status: 'failed',
            errorMessage: failureReason,
        });

        const retryId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
        retryCache.set(retryId, {
            guildId,
            sessionInfo: {
                voiceChannelName: session.voiceChannelName,
                startedAt: session.startedAt,
                participants: new Map(session.participants),
                groqApiKey: groqKey,
                geminiApiKey: geminiKey,
                summaryProvider: provider,
                groqModel,
                geminiModel,
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
        summaryModel: provider === 'gemini' ? geminiModel : groqModel,
        transcriptEntriesCount: session.transcript.length,
        status: 'completed',
        summaryText: summary,
    });

    const notesMarkdown = buildNotesMarkdown(session, summary);
    const notesFile = new AttachmentBuilder(Buffer.from(notesMarkdown, 'utf-8'), { name: buildFilename(session) });

    // Phase 3: Non-fatal publishing to Notion Meetings database
    let notionOutput = '';
    const guildConfig = getGuildConfig(guildId);
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

    // Phase 4: Org Info sync (Automatic or prompt for manual)
    let orgInfoOutput = '';
    if (guildConfig.notionToken && guildConfig.orgInfoPageId) {
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

    // Phase 6: Sync Action Items to Action Items DB & Personal Pages
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

    await deliverOutput(interaction, guildId, {
        content: `Notes are ready:${notionOutput}${orgInfoOutput}${taskSyncOutput}`,
        files: [notesFile],
    });
}

async function handleButton(interaction) {
    if (!interaction.customId?.startsWith('retry_notes:')) return;
    const retryId = interaction.customId.slice('retry_notes:'.length);
    const entry = retryCache.get(retryId);
    if (!entry) {
        await interaction.reply({
            content: 'This retry session has expired or the bot was restarted. Please refer to the raw transcript attached above.',
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    // Strict cross-guild isolation check
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

    const groqKey = guildConfig.groqApiKey || sessionInfo.groqApiKey || process.env.GROQ_API_KEY;
    const geminiKey = guildConfig.geminiApiKey || sessionInfo.geminiApiKey || process.env.GEMINI_API_KEY;
    const provider = guildConfig.summaryProvider || sessionInfo.summaryProvider || process.env.SUMMARY_PROVIDER || 'groq';
    const groqModel = guildConfig.groqModel || sessionInfo.groqModel || process.env.GROQ_SUMMARY_MODEL || 'openai/gpt-oss-120b';
    const geminiModel = guildConfig.geminiModel || sessionInfo.geminiModel || process.env.GEMINI_MODEL || 'gemini-2.5-flash';

    const { summary, lastError } = await summarizeTranscriptContent(transcriptText, {
        guildId,
        groqKey,
        geminiKey,
        provider,
        groqModel,
        geminiModel,
    });

    if (!summary) {
        const failureReason = lastError?.message || 'Unknown error occurred during API summarization.';
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

    // Disable the button on the previous message if possible
    const disabledRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`retried_${retryId}`)
            .setLabel('Retried Successfully')
            .setStyle(ButtonStyle.Success)
            .setDisabled(true),
    );
    await interaction.message?.edit({ components: [disabledRow] }).catch(() => {});

    // Deliver the finalized notes
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
        summaryProvider: provider,
        summaryModel: provider === 'gemini' ? geminiModel : groqModel,
        transcriptEntriesCount: transcriptText.split('\n').filter(Boolean).length,
        status: 'completed',
    });

    const notesMarkdown = buildNotesMarkdown(effectiveSession, summary);
    const notesFile = new AttachmentBuilder(Buffer.from(notesMarkdown, 'utf-8'), { name: buildFilename(effectiveSession) });

    // Non-fatal publishing to Notion Meetings database on retry
    let notionOutput = '';
    if (guildConfig.notionToken && guildConfig.meetingsDbId) {
        try {
            const notionRes = await publishMeetingNotes({
                token: guildConfig.notionToken,
                meetingsDbId: guildConfig.meetingsDbId,
                session: effectiveSession,
                markdownContent: notesMarkdown,
            });
            if (notionRes.published && notionRes.url) {
                notionOutput = `\n- **Notion Wiki:** [Open Meeting Page in Notion](${notionRes.url})`;
            }
        } catch (err) {
            console.error(`[notes:${guildId}] Non-fatal retry publishing to Notion:`, err.message);
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
                participants: effectiveSession.participants,
                session: effectiveSession,
            });
            if (taskSyncRes.tasksCreated > 0 || taskSyncRes.membersUpdated > 0) {
                taskSyncOutput = `\n- **Tasks & Personal Notes:** 📋 Synced ${taskSyncRes.tasksCreated} action item(s) to Action Items DB and updated ${taskSyncRes.membersUpdated} member page(s).`;
            }
        } catch (err) {
            console.error(`[notes:${guildId}] Non-fatal retry syncing tasks to personal notes:`, err.message);
        }
    }

    await deliverOutput(interaction, guildId, {
        content: `**Notes successfully summarized on retry:**${notionOutput}${taskSyncOutput}`,
        files: [notesFile],
    });
}

module.exports = {
    startNotes,
    stopNotes,
    handleButton,
    deliverOutput,
    retryCache,
};
