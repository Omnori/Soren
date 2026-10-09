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
const { checkAdminPermission } = require('./helpers');

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

    const groqKey = interaction.options.getString('groq_key');
    const geminiKey = interaction.options.getString('gemini_key');
    const nvidiaKey = interaction.options.getString('nvidia_key');
    const provider = interaction.options.getString('provider');
    const groqModel = interaction.options.getString('groq_model');
    const geminiModel = interaction.options.getString('gemini_model');
    const nvidiaModel = interaction.options.getString('nvidia_model');

    if (!groqKey && !geminiKey && !nvidiaKey && !provider && !groqModel && !geminiModel && !nvidiaModel) {
        return handleKeyInfo(interaction);
    }

    const updatePayload = {};
    if (groqKey) updatePayload.groqApiKey = groqKey.trim();
    if (geminiKey) updatePayload.geminiApiKey = geminiKey.trim();
    if (nvidiaKey) updatePayload.nvidiaApiKey = nvidiaKey.trim();
    if (provider) {
        updatePayload.summaryProvider = provider.toLowerCase().trim();
    } else if (nvidiaKey && !groqKey && !geminiKey) {
        // Automatically set NVIDIA as provider if user sets nvidia_key without other keys
        updatePayload.summaryProvider = 'nvidia';
    }
    if (groqModel) updatePayload.groqModel = groqModel.trim();
    if (geminiModel) updatePayload.geminiModel = geminiModel.trim();
    if (nvidiaModel) updatePayload.nvidiaModel = nvidiaModel.trim();

    setGuildKeys(guildId, updatePayload);

    const config = getGuildConfig(guildId);
    const mask = (str) => (str ? `\`${str.slice(0, 4)}...${str.slice(-4)}\`` : '_not set_');

    await interaction.reply({
        content: `**Configuration updated for ${interaction.guild.name}!**\n` +
            `- **Groq API Key:** ${mask(config.groqApiKey)}\n` +
            `- **Gemini API Key:** ${mask(config.geminiApiKey)}\n` +
            `- **Summary Provider:** **${config.summaryProvider || 'groq'}**\n` +
            `- **Groq Summary Model:** \`${config.groqModel || process.env.GROQ_SUMMARY_MODEL || 'openai/gpt-oss-120b'}\`\n` +
            `- **Gemini Summary Model:** \`${config.geminiModel || process.env.GEMINI_MODEL || 'gemini-2.5-flash'}\`\n` +
            `- **NVIDIA API Key:** ${mask(config.nvidiaApiKey || process.env.NVIDIA_API_KEY)}\n` +
            `- **NVIDIA Summary Model:** \`${config.nvidiaModel || process.env.NVIDIA_MODEL || 'nvidia/nemotron-3-super-120b-a12b'}\``,
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

    const groqModel = interaction.options.getString('groq_model');
    const geminiModel = interaction.options.getString('gemini_model');
    const nvidiaModel = interaction.options.getString('nvidia_model');

    if (!groqModel && !geminiModel && !nvidiaModel) {
        return handleKeyInfo(interaction);
    }

    const updatePayload = {};
    if (groqModel) updatePayload.groqModel = groqModel.trim();
    if (geminiModel) updatePayload.geminiModel = geminiModel.trim();

    setGuildKeys(guildId, updatePayload);

    const config = getGuildConfig(guildId);
    await interaction.reply({
        content: `**Models updated for ${interaction.guild.name}!**\n` +
            `- **Groq Summary Model:** \`${config.groqModel || process.env.GROQ_SUMMARY_MODEL || 'openai/gpt-oss-120b'}\`\n` +
            `- **Gemini Summary Model:** \`${config.geminiModel || process.env.GEMINI_MODEL || 'gemini-2.5-flash'}\``,
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
    const mask = (str) => (str ? `\`${str.slice(0, 4)}...${str.slice(-4)}\`` : '_not set_');

    await interaction.reply({
        content: `**Configuration for ${interaction.guild.name}:**\n` +
            `- **Groq API Key:** ${mask(config.groqApiKey)}\n` +
            `- **Gemini API Key:** ${mask(config.geminiApiKey)}\n` +
            `- **Summary Provider:** **${config.summaryProvider || 'groq'}**\n` +
            `- **Groq Summary Model:** \`${config.groqModel || process.env.GROQ_SUMMARY_MODEL || 'openai/gpt-oss-120b'}\`\n` +
            `- **Gemini Summary Model:** \`${config.geminiModel || process.env.GEMINI_MODEL || 'gemini-2.5-flash'}\``,
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
        `- 🎙️ **Total Recorded Meetings:** \`${stats.total_sessions || 0}\`\n` +
        `- ⏱️ **Total Time in Voice:** \`${timeFormatted}\`\n` +
        `- 💬 **Speech Utterances Processed:** \`${stats.total_transcripts || 0}\`\n` +
        `- 👥 **Total Meeting Attendees:** \`${stats.total_participants || 0}\`\n\n` +
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
