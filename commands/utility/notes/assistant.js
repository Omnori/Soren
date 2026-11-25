const { MessageFlags, PermissionFlagsBits } = require('discord.js');
const {
    getGuildConfig,
    logAudit,
    getRecentAuditLogs,
} = require('../../../lib/guildConfig');
const { runAndPersistAssistantTurn } = require('../../../lib/assistantDiscord');
const { sendSafeChunkedReply, sendSafeMessageReply } = require('../../../lib/discordUtils');
const { sanitizeErrorMessage } = require('../../../lib/safeError');
const { checkAdminPermission } = require('./helpers');

const activeAskCollectors = new Map();

async function handleAsk(interaction) {
    const guildId = interaction.guildId;
    const config = getGuildConfig(guildId);

    if (!config.notionToken || !config.wikiPageId) {
        await interaction.reply({
            content: '⚠️ Notion is not configured for this server yet. An administrator must configure it with `/notes setnotion` first.',
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    const question = interaction.options.getString('question')?.trim();
    if (!question) {
        await interaction.reply({
            content: 'Please provide a question to ask.',
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    const targetUserOption = interaction.options.getUser('member');
    let targetMember = interaction.user;

    // Strict user-scoped resolution:
    if (targetUserOption && targetUserOption.id !== interaction.user.id) {
        const isAdmin = interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ||
                        interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ||
                        interaction.guild?.ownerId === interaction.user.id;
        if (!isAdmin) {
            await interaction.reply({
                content: '⛔ **Access Denied:** Only administrators can query another member\'s personal records and tasks. You can run `/notes ask` without specifying a member to query your own tasks and general wiki info.',
                flags: MessageFlags.Ephemeral,
            });
            return;
        }
        targetMember = targetUserOption;
    }

    await interaction.deferReply();

    try {
        const isAdmin = checkAdminPermission(interaction);
        const result = await runAndPersistAssistantTurn({
            guildId,
            channelId: interaction.channelId,
            userId: interaction.user.id,
            targetMember,
            userMessage: question,
            isAdmin,
            entryPoint: 'notes_ask',
        });

        logAudit({
            guildId,
            userId: interaction.user.id,
            userTag: interaction.user.tag || interaction.user.username,
            action: 'ask_query',
            targetMemberId: targetMember.id,
            details: question,
        });

        const targetNote = targetMember.id !== interaction.user.id
            ? ` *(Target Member: <@${targetMember.id}>)*`
            : '';

        const replyContent = `**Question:** "${question}"${targetNote}\n\n${result.answer}\n\n` +
            `*💬 **Conversation Active (2 mins):** Reply naturally in this channel for follow-ups (tasks, notes, org updates, or docs). Type \`done\` to close.*`;

        await sendSafeChunkedReply(interaction, replyContent, {
            fileName: 'assistant_response.md',
            components: result.components,
        });

        // Start short-lived 2-minute message collector routed through the unified assistant engine
        if (interaction.channel) {
            const frozenTargetMember = targetMember;
            const collectorKey = `${guildId}:${interaction.user.id}:${interaction.channelId}`;
            if (activeAskCollectors.has(collectorKey)) {
                try {
                    activeAskCollectors.get(collectorKey).stop('superseded');
                } catch {
                    // Ignore error stopping previous collector
                }
                activeAskCollectors.delete(collectorKey);
            }

            const filter = (m) => m.author.id === interaction.user.id && !m.author.bot;
            const collector = interaction.channel.createMessageCollector({
                filter,
                time: 120000, // 2 minutes
            });
            activeAskCollectors.set(collectorKey, collector);

            collector.on('end', () => {
                if (activeAskCollectors.get(collectorKey) === collector) {
                    activeAskCollectors.delete(collectorKey);
                }
            });

            collector.on('collect', async (userMsg) => {
                try {
                    const lower = (userMsg.content || '').trim().toLowerCase();
                    if (['done', 'stop', 'exit', 'cancel', 'bye', 'close'].includes(lower)) {
                        await sendSafeMessageReply(userMsg, '👋 Q&A session closed. Mention `@Soren` or run `/ask` anytime!', {
                            fileName: 'followup_response.md',
                        });
                        collector.stop('user_exit');
                        return;
                    }

                    await userMsg.channel.sendTyping().catch(() => {});
                    const fuRes = await runAndPersistAssistantTurn({
                        guildId,
                        channelId: interaction.channelId,
                        userId: interaction.user.id,
                        targetMember: frozenTargetMember,
                        userMessage: userMsg.content,
                        isAdmin,
                        entryPoint: 'notes_ask_followup',
                    });

                    await sendSafeMessageReply(userMsg, fuRes.answer, {
                        fileName: 'followup_response.md',
                        components: fuRes.components,
                    });
                } catch (fuErr) {
                    console.error('[notes:collector] Error processing follow-up:', fuErr);
                    const safeErr = sanitizeErrorMessage(fuErr);
                    await userMsg.reply({
                        content: `⚠️ Failed to process follow-up: ${safeErr.slice(0, 500)}`,
                    }).catch(() => {});
                }
            });
        }
    } catch (err) {
        console.error(`[notes:ask] Error handling question:`, err);
        const safeErr = sanitizeErrorMessage(err);
        await interaction.editReply({
            content: `⚠️ **Assistant encountered an error:** ${safeErr}`,
        }).catch(async () => {
            await interaction.followUp({
                content: `⚠️ **Assistant encountered an error:** ${safeErr.slice(0, 500)}`,
                flags: MessageFlags.Ephemeral,
            }).catch(() => {});
        });
    }
}

async function handleAudit(interaction) {
    const guildId = interaction.guildId;
    if (!checkAdminPermission(interaction)) {
        await interaction.reply({
            content: 'You need the Manage Server permission or be the Server Owner to view audit logs.',
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    const logs = getRecentAuditLogs(guildId, 15);
    if (!logs || logs.length === 0) {
        await interaction.reply({
            content: `No audit log entries recorded yet for **${interaction.guild.name}**.`,
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    let rows = '';
    let omittedLogs = 0;
    for (const l of logs) {
        const timeStr = new Date(l.created_at).toLocaleString('en-US', { timeZone: 'UTC' });
        const targetStr = l.target_member_id ? ` (Target: <@${l.target_member_id}>)` : '';
        let detailStr = l.details || '';
        if (detailStr.length > 80) detailStr = detailStr.slice(0, 77) + '...';
        const line = `• \`[${timeStr} UTC]\` <@${l.user_id}>: **${l.action}**${targetStr}\n  _${detailStr}_\n`;
        if ((rows + line).length > 1600) {
            omittedLogs++;
        } else {
            rows += line;
        }
    }
    if (omittedLogs > 0) {
        rows += `\n_...and ${omittedLogs} older log entries._`;
    }

    await interaction.reply({
        content: `📋 **Recent Assistant & Notion Audit Logs for ${interaction.guild.name} (Last ${logs.length}):**\n\n${rows.trim()}`,
        flags: MessageFlags.Ephemeral,
    });
}

module.exports = {
    handleAsk,
    handleAudit,
    activeAskCollectors,
};
