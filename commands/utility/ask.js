const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { runAndPersistAssistantTurn, hasAdminPermission } = require('../../lib/assistantDiscord');
const { sendSafeChunkedReply } = require('../../lib/discordUtils');
const { getGuildConfig } = require('../../lib/guildConfig');
const { sanitizeErrorMessage } = require('../../lib/safeError');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('ask')
        .setDescription('Ask Soren anything about your Notion wiki, tasks, meetings, or policies')
        .addStringOption((option) =>
            option
                .setName('question')
                .setDescription('The question you want to ask')
                .setRequired(true)
        ),
    async execute(interaction) {
        const guildId = interaction.guildId;
        if (!guildId) {
            return interaction.reply({
                content: 'This command can only be used within a Discord server.',
                flags: MessageFlags.Ephemeral,
            });
        }

        const config = getGuildConfig(guildId);
        if (!config.notionToken || !config.wikiPageId) {
            return interaction.reply({
                content: 'Notion Integration has not been fully set up for this server yet.\nAn admin can set it up using `/notion setup`.',
                flags: MessageFlags.Ephemeral,
            });
        }

        // Defer reply because LLM and Notion API queries can take a few seconds
        await interaction.deferReply();

        const question = interaction.options.getString('question');
        const userId = interaction.user.id;

        try {
            const result = await runAndPersistAssistantTurn({
                guildId,
                channelId: interaction.channelId,
                userId,
                targetMember: interaction.member || interaction.user,
                userMessage: question,
                isAdmin: hasAdminPermission(interaction),
                entryPoint: 'ask',
            });

            await sendSafeChunkedReply(interaction, result.answer, {
                fileName: 'soren_answer.md',
                components: result.components,
            });
        } catch (err) {
            console.error('[askCommand] Error running grounded assistant:', err);
            const safeErr = sanitizeErrorMessage(err);
            await interaction.editReply({
                content: `Sorry, I encountered an error while processing your request: ${safeErr}`,
            });
        }
    },
};
