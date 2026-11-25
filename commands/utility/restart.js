const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('restart')
        .setDescription("Restarts the bot's process (admin only)")
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    async execute(interaction) {
        // setDefaultMemberPermissions only sets the default in Discord's UI; a server
        // admin can loosen it per-guild, so double-check here too.
        if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
            await interaction.reply({
                content: 'Only server administrators can restart the bot.',
                flags: MessageFlags.Ephemeral,
            });
            return;
        }

        await interaction.reply(
            '🔄 Rebooting my brain cells... Back in a few seconds (assuming PM2 or Docker catches me on the way down).',
        );
        setTimeout(() => process.exit(0), 500);
    },
};
