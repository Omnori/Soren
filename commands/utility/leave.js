const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { getVoiceConnection } = require('@discordjs/voice');
const { getSession } = require('../../lib/notesSessions');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('leave')
        .setDescription('Dismiss Soren from the current voice channel'),
    async execute(interaction) {
        const guildId = interaction.guildId;

        if (getSession(guildId)) {
            await interaction.reply({
                content: 'Hold on — I\'m actively taking meeting notes! Use `/notes stop` so we don\'t lose the summary.',
                flags: MessageFlags.Ephemeral,
            });
            return;
        }

        const connection = getVoiceConnection(guildId);
        if (!connection) {
            await interaction.reply({ content: 'I\'m not in a voice channel — unless you\'re hearing ghosts.', flags: MessageFlags.Ephemeral });
            return;
        }

        connection.destroy();
        await interaction.reply('👋 Clocking out of voice. Catch me in chat anytime!');
    },
};
