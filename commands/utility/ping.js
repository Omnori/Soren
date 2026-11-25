const { SlashCommandBuilder } = require('discord.js');
const { getGuildConfig } = require('../../lib/guildConfig');

const QUIPS = [
    'All systems green and mildly caffeinated.',
    'Still smarter than a sticky note.',
    'Ready to read Notion so you don\'t have to.',
    'Zero hallucinations guaranteed (terms and conditions apply).',
];

module.exports = {
    data: new SlashCommandBuilder()
        .setName('ping')
        .setDescription('Check Soren\'s pulse, gateway latency, uptime, and active AI setup'),
    async execute(interaction) {
        const displayName = interaction.user.globalName || interaction.user.username;
        const wsPing = Math.max(0, Math.round(interaction.client?.ws?.ping ?? 0));
        const uptimeSec = Math.floor(process.uptime());
        const mins = Math.floor(uptimeSec / 60);
        const hrs = Math.floor(mins / 60);
        const uptimeStr = hrs > 0 ? `${hrs}h ${mins % 60}m` : `${mins}m ${uptimeSec % 60}s`;
        const cfg = interaction.guildId ? getGuildConfig(interaction.guildId) : {};
        const provider = cfg.summaryProvider || process.env.SUMMARY_PROVIDER || 'nvidia';
        const quip = QUIPS[Math.floor(Math.random() * QUIPS.length)];

        await interaction.reply({
            content:
                `⚡ **Pong, ${displayName}!** *(${quip})*\n` +
                `- **Gateway Ping:** \`${wsPing}ms\`\n` +
                `- **Uptime:** \`${uptimeStr}\`\n` +
                `- **Active AI Brain:** \`${provider.toUpperCase()}\`\n` +
                `- **Notion Grounded:** ${cfg.notionToken && cfg.wikiPageId ? '🟢 Connected' : '⚪ Not yet (`/notion setup`)'}`,
        });
    },
};