const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    MessageFlags,
    PermissionFlagsBits,
} = require('discord.js');
const {
    getConversationHistory,
    appendConversationTurn,
    getGuildConfig,
    getRecentSessions,
    updateLastDigestAt,
} = require('./database');
const {
    runGroundedAssistantWithMeta,
    executePendingConfirmation,
    deletePendingConfirmation,
    executeTool,
    resolveCallerIdentity,
} = require('./assistantEngine');
const { fetchActionItems } = require('./memberAssistant');
const { getNotionClient } = require('./notion');
const { sanitizeErrorMessage } = require('./safeError');
const { truncateDiscordText } = require('./discordUtils');

function hasAdminPermission(memberOrInteraction) {
    const guild = memberOrInteraction?.guild;
    const userId = memberOrInteraction?.user?.id || memberOrInteraction?.author?.id || memberOrInteraction?.id;
    if (guild?.ownerId && userId && guild.ownerId === userId) return true;
    const perms = memberOrInteraction?.memberPermissions || memberOrInteraction?.member?.permissions || memberOrInteraction?.permissions;
    return Boolean(
        perms?.has?.(PermissionFlagsBits.Administrator) ||
        perms?.has?.(PermissionFlagsBits.ManageGuild)
    );
}

/**
 * Builds interactive Discord button rows for pending write confirmations and open tasks.
 */
function buildAssistantActionRows(meta = {}) {
    const rows = [];

    if (Array.isArray(meta.pendingConfirmations) && meta.pendingConfirmations.length > 0) {
        const confirm = meta.pendingConfirmations[0];
        rows.push(
            new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`confirm_action:${confirm.id}`)
                    .setLabel('Confirm Action')
                    .setStyle(ButtonStyle.Danger),
                new ButtonBuilder()
                    .setCustomId(`cancel_action:${confirm.id}`)
                    .setLabel('Cancel')
                    .setStyle(ButtonStyle.Secondary),
            ),
        );
    }

    if (Array.isArray(meta.quickTasks) && meta.quickTasks.length > 0 && rows.length < 4) {
        const taskButtons = meta.quickTasks.slice(0, 3).map((task) => {
            const cleanId = String(task.id).replace(/-/g, '');
            const labelText = truncateDiscordText(`✓ Done: ${task.task || 'Task'}`, 78, '...');
            return new ButtonBuilder()
                .setCustomId(`task_done:${cleanId}`)
                .setLabel(labelText)
                .setStyle(ButtonStyle.Success);
        });
        if (taskButtons.length > 0) {
            rows.push(new ActionRowBuilder().addComponents(...taskButtons));
        }
    }

    return rows;
}

/**
 * Executes a grounded assistant turn using persistent SQLite channel/thread memory,
 * then persists both user and assistant messages for seamless multi-turn conversations.
 */
async function runAndPersistAssistantTurn({
    guildId,
    channelId,
    userId,
    targetMember,
    userMessage,
    isAdmin = false,
    entryPoint = 'chat',
}) {
    const cleanText = String(userMessage || '').trim();
    const recentHistory = channelId
        ? getConversationHistory(guildId, channelId, { limit: 8 })
        : [];

    const username = targetMember?.user?.username || targetMember?.username || targetMember?.displayName || 'user';
    const historyForModel = [
        ...recentHistory.map((m) => ({ role: m.role, content: m.content, name: m.name })),
        { role: 'user', content: cleanText, name: username },
    ];

    const result = await runGroundedAssistantWithMeta(guildId, userId, historyForModel, {
        channelId,
        entryPoint,
        targetMember,
        isAdmin,
        interactiveConfirm: true,
    });

    if (channelId && cleanText) {
        appendConversationTurn(guildId, channelId, {
            userId,
            role: 'user',
            authorName: username,
            content: cleanText,
        });
        if (result?.answer) {
            appendConversationTurn(guildId, channelId, {
                userId: 'soren',
                role: 'assistant',
                authorName: 'Soren',
                content: result.answer,
            });
        }
    }

    return {
        ...result,
        components: buildAssistantActionRows(result),
    };
}

/**
 * Handles interactive buttons rendered under Soren responses (Confirm, Cancel, Mark Task Done).
 */
async function handleAssistantButton(interaction) {
    const customId = interaction.customId || '';

    if (customId.startsWith('confirm_action:')) {
        const confirmId = customId.slice('confirm_action:'.length);
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const outcome = await executePendingConfirmation(confirmId, interaction.user.id, interaction.guildId);

        if (!outcome.ok) {
            await interaction.editReply({ content: outcome.message });
            return;
        }

        const doneRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`confirmed_${confirmId}`)
                .setLabel('Confirmed & Executed')
                .setStyle(ButtonStyle.Success)
                .setDisabled(true),
        );
        await interaction.message?.edit({ components: [doneRow] }).catch(() => {});
        await interaction.editReply({ content: `✅ **Executed:** ${outcome.description}` });
        return;
    }

    if (customId.startsWith('cancel_action:')) {
        const confirmId = customId.slice('cancel_action:'.length);
        deletePendingConfirmation(confirmId);
        const cancelledRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`cancelled_${confirmId}`)
                .setLabel('Cancelled')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(true),
        );
        await interaction.message?.edit({ components: [cancelledRow] }).catch(() => {});
        await interaction.reply({ content: 'Action cancelled. Nothing was modified in Notion.', flags: MessageFlags.Ephemeral });
        return;
    }

    if (customId.startsWith('task_done:')) {
        const taskId = customId.slice('task_done:'.length);
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const isAdmin = hasAdminPermission(interaction);
        const caller = resolveCallerIdentity(interaction.guildId, interaction.user.id, {
            targetMember: interaction.member || interaction.user,
        });
        caller.isAdmin = isAdmin;

        const res = await executeTool(interaction.guildId, 'update_user_task', {
            task_id: taskId,
            status: 'Done',
        }, caller);

        if (typeof res === 'string' && res.startsWith('⛔')) {
            await interaction.editReply({ content: res });
            return;
        }

        try {
            const parsed = JSON.parse(res);
            if (parsed.success) {
                await interaction.editReply({ content: `✅ Marked task as **Done** in Notion!` });
                return;
            }
        } catch {
            // Fall through to generic message
        }

        await interaction.editReply({ content: sanitizeErrorMessage(res) });
    }
}

/**
 * Builds a proactive daily workspace digest (open tasks + recent meetings) for a guild.
 */
async function buildGuildDigestMessage(guildId) {
    const config = getGuildConfig(guildId);
    if (!config?.notionToken) return null;

    const parts = [`☀️ **Soren's Daily Workspace Pulse** (${new Date().toISOString().slice(0, 10)})`];

    if (config.actionItemsDbId) {
        try {
            const client = getNotionClient(config.notionToken);
            const items = await fetchActionItems(client, config.actionItemsDbId, { limit: 25 });
            const openItems = items.filter((it) => !['done', 'completed'].includes((it.status || '').toLowerCase()));
            if (openItems.length > 0) {
                const lines = openItems.slice(0, 8).map((it) => {
                    const dueStr = it.due ? ` *(Due: ${it.due})*` : '';
                    return `• **${it.task}** — ${it.assignee} \`[${it.status}]\`${dueStr}`;
                });
                const extra = openItems.length > 8 ? `\n_...and ${openItems.length - 8} more open task(s)._` : '';
                parts.push(`\n**📋 Open Action Items (${openItems.length}):**\n${lines.join('\n')}${extra}`);
            } else {
                parts.push('\n**📋 Open Action Items:** Zero open tasks! Either everyone is crushing it or nobody logged them yet.');
            }
        } catch (err) {
            console.warn(`[digest:${guildId}] Failed fetching action items:`, err.message);
        }
    }

    const recent = getRecentSessions(guildId, 2);
    if (recent && recent.length > 0) {
        const meetingLines = recent.map((s) => {
            const dateStr = String(s.started_at || '').slice(0, 10);
            return `• **${s.channel_name || 'Voice Meeting'}** (${dateStr}) — ${s.participant_count || 0} attendee(s)`;
        });
        parts.push(`\n**🎙️ Recent Meetings:**\n${meetingLines.join('\n')}`);
    }

    parts.push('\n_Ping `@Soren` to check tasks, update Notion, or interrogate yesterday\'s meeting decisions._');
    return parts.join('\n');
}

async function runScheduledDigests(client) {
    const { getGuildsWithDigestChannel } = require('./database');
    const guilds = getGuildsWithDigestChannel();
    const now = Date.now();
    const ONE_DAY_MS = 23 * 60 * 60 * 1000;

    for (const g of guilds) {
        if (now - (g.last_digest_at || 0) < ONE_DAY_MS) continue;
        try {
            const channel = await client.channels.fetch(g.digest_channel_id).catch(() => null);
            if (!channel || typeof channel.send !== 'function') continue;
            const digest = await buildGuildDigestMessage(g.guild_id);
            if (!digest) continue;
            await channel.send({ content: truncateDiscordText(digest, 1900) });
            updateLastDigestAt(g.guild_id, now);
        } catch (err) {
            console.warn(`[digest:${g.guild_id}] Failed sending scheduled digest:`, err.message);
        }
    }
}

module.exports = {
    hasAdminPermission,
    buildAssistantActionRows,
    runAndPersistAssistantTurn,
    handleAssistantButton,
    buildGuildDigestMessage,
    runScheduledDigests,
};
