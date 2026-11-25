const { MessageFlags, PermissionFlagsBits } = require('discord.js');
const {
    getGuildConfig,
    setGuildKeys,
    clearGuildKeys,
    getNotesChannelId,
    setNotesChannelId,
    getGuildStats,
    getRecentSessions,
} = require('../../../lib/guildConfig');
const { DEFAULT_MODELS, normalizeGeminiModel, normalizeNvidiaModel } = require('../../../lib/aiConfig');
const { checkAdminPermission } = require('./helpers');

function maskSecret(str) {
    return str ? `\`${str.slice(0, 4)}...${str.slice(-4)}\`` : '_not set_';
}

function buildKeyUpdatePayload(interaction, { allowKeys = false } = {}) {
    const groqKey = allowKeys ? interaction.options.getString('groq_key') : null;
    const geminiKey = allowKeys ? interaction.options.getString('gemini_key') : null;
    const nvidiaKey = allowKeys ? interaction.options.getString('nvidia_key') : null;
    const provider = interaction.options.getString('provider');
    const groqModel = interaction.options.getString('groq_model');
    const geminiModel = interaction.options.getString('gemini_model');
    const nvidiaModel = interaction.options.getString('nvidia_model');

    if (!groqKey && !geminiKey && !nvidiaKey && !provider && !groqModel && !geminiModel && !nvidiaModel) {
        return null;
    }

    const updatePayload = {};
    if (groqKey) updatePayload.groqApiKey = groqKey.trim();
    if (geminiKey) updatePayload.geminiApiKey = geminiKey.trim();
    if (nvidiaKey) updatePayload.nvidiaApiKey = nvidiaKey.trim();

    if (provider) {
        updatePayload.summaryProvider = provider.toLowerCase().trim();
    } else if (nvidiaKey && !groqKey && !geminiKey) {
        updatePayload.summaryProvider = 'nvidia';
    }

    if (groqModel) {
        const trimmed = groqModel.trim();
        if (trimmed.startsWith('nvidia/')) {
            updatePayload.nvidiaModel = normalizeNvidiaModel(trimmed);
            if (!provider) updatePayload.summaryProvider = 'nvidia';
        } else {
            updatePayload.groqModel = trimmed;
        }
    }

    if (geminiModel) {
        const trimmed = geminiModel.trim();
        if (trimmed.startsWith('nvidia/')) {
            updatePayload.nvidiaModel = normalizeNvidiaModel(trimmed);
            if (!provider) updatePayload.summaryProvider = 'nvidia';
        } else {
            updatePayload.geminiModel = normalizeGeminiModel(trimmed);
        }
    }

    if (nvidiaModel) {
        updatePayload.nvidiaModel = normalizeNvidiaModel(nvidiaModel);
        if (!provider && !allowKeys) {
            updatePayload.summaryProvider = 'nvidia';
        }
    }

    return updatePayload;
}

function formatGuildConfigSummary(guildName, config, { includeKeys = false, updated = false } = {}) {
    const header = updated
        ? `**Configuration updated for ${guildName}!**`
        : `**Configuration for ${guildName}:**`;

    const lines = [header];
    if (includeKeys) {
        lines.push(
            `- **Groq API Key:** ${maskSecret(config.groqApiKey)}`,
            `- **Gemini API Key:** ${maskSecret(config.geminiApiKey)}`,
            `- **NVIDIA API Key:** ${maskSecret(config.nvidiaApiKey || process.env.NVIDIA_API_KEY)}`,
        );
    }

    lines.push(
        `- **Summary Provider:** **${config.summaryProvider || 'nvidia'}**`,
        `- **Groq Summary Model:** \`${config.groqModel || process.env.GROQ_SUMMARY_MODEL || DEFAULT_MODELS.groq}\``,
        `- **Gemini Summary Model:** \`${normalizeGeminiModel(config.geminiModel)}\``,
        `- **NVIDIA Summary Model:** \`${normalizeNvidiaModel(config.nvidiaModel)}\``,
    );

    return lines.join('\n');
}

async function handleChannel(interaction) {
    const guildId = interaction.guildId;
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels)) {
        await interaction.reply({
            content: 'You need the Manage Channels permission to configure the notes channel.',
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    const channelOption = interaction.options.getChannel('channel');

    if (!channelOption) {
        const currentId = getNotesChannelId(guildId);
        await interaction.reply({
            content: currentId
                ? `Notes are currently posted to <#${currentId}>.`
                : 'No notes channel is set — notes post wherever `/notes stop` is run.',
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    const permissions = channelOption.permissionsFor(interaction.guild.members.me);
    const required = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.AttachFiles];
    if (!permissions?.has(required)) {
        await interaction.reply({
            content: `I don't have permission to view/send messages/attach files in ${channelOption}. Fix that first.`,
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    setNotesChannelId(guildId, channelOption.id);
    await interaction.reply(`Notes will now be posted to ${channelOption}.`);
}

async function handleSetKey(interaction) {
    const guildId = interaction.guildId;
    if (!checkAdminPermission(interaction)) {
        await interaction.reply({
            content: 'You need the Manage Server permission or be the Server Owner to configure API keys.',
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    const updatePayload = buildKeyUpdatePayload(interaction, { allowKeys: true });
    if (!updatePayload) {
        return handleKeyInfo(interaction);
    }

    setGuildKeys(guildId, updatePayload);
    const config = getGuildConfig(guildId);

    await interaction.reply({
        content: formatGuildConfigSummary(interaction.guild.name, config, { includeKeys: true, updated: true }),
        flags: MessageFlags.Ephemeral,
    });
}

async function handleSetModel(interaction) {
    const guildId = interaction.guildId;
    if (!checkAdminPermission(interaction)) {
        await interaction.reply({
            content: 'You need the Manage Server permission or be the Server Owner to configure models.',
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    const updatePayload = buildKeyUpdatePayload(interaction, { allowKeys: false });
    if (!updatePayload) {
        return handleKeyInfo(interaction);
    }

    setGuildKeys(guildId, updatePayload);
    const config = getGuildConfig(guildId);

    await interaction.reply({
        content: formatGuildConfigSummary(interaction.guild.name, config, { includeKeys: false, updated: true }),
        flags: MessageFlags.Ephemeral,
    });
}

async function handleClearKey(interaction) {
    const guildId = interaction.guildId;
    if (!checkAdminPermission(interaction)) {
        await interaction.reply({
            content: 'You need the Manage Server permission or be the Server Owner to configure API keys.',
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    clearGuildKeys(guildId);
    await interaction.reply({
        content: `API keys and model configurations removed for **${interaction.guild.name}**.`,
        flags: MessageFlags.Ephemeral,
    });
}

async function handleKeyInfo(interaction) {
    const guildId = interaction.guildId;
    const config = getGuildConfig(guildId);

    await interaction.reply({
        content: formatGuildConfigSummary(interaction.guild.name, config, { includeKeys: true, updated: false }),
        flags: MessageFlags.Ephemeral,
    });
}

async function handleStats(interaction) {
    const guildId = interaction.guildId;
    const stats = getGuildStats(guildId);
    const recent = getRecentSessions(guildId, 5);

    const totalHours = Math.floor((stats.total_duration_seconds || 0) / 3600);
    const totalMinutes = Math.floor(((stats.total_duration_seconds || 0) % 3600) / 60);
    const timeFormatted = totalHours > 0 ? `${totalHours}h ${totalMinutes}m` : `${totalMinutes}m`;

    let recentText = '_No meetings recorded yet._';
    if (recent && recent.length > 0) {
        recentText = recent
            .map((s) => {
                const dateStr = `<t:${Math.floor(new Date(s.started_at).getTime() / 1000)}:d>`;
                const durationMin = Math.round((s.duration_seconds || 0) / 60);
                const statusEmoji = s.status === 'completed' ? '✅' : s.status === 'failed' ? '❌' : '⚪';
                return `• ${statusEmoji} **${s.channel_name || 'Voice Meeting'}** (${dateStr}, ~${durationMin}m) — ${s.participant_count || 0} attendees`;
            })
            .join('\n');
    }

    const embedContent = `📊 **Voice Notes Stats for ${interaction.guild.name}**\n\n` +
        `**Overview:**\n` +
        `- 🎙️ **Total Recorded Meetings:** \`${stats.total_meetings || 0}\`\n` +
        `- ✅ **Completed Summaries:** \`${stats.completed_meetings || 0}\`\n` +
        `- ❌ **Failed Summaries:** \`${stats.failed_meetings || 0}\`\n` +
        `- ⏱️ **Total Time in Voice:** \`${timeFormatted}\`\n\n` +
        `**Recent Meetings:**\n${recentText}`;

    await interaction.reply({
        content: embedContent,
        flags: MessageFlags.Ephemeral,
    });
}

module.exports = {
    handleChannel,
    handleSetKey,
    handleSetModel,
    handleClearKey,
    handleKeyInfo,
    handleStats,
};
