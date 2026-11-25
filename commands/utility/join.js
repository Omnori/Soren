const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { joinVoiceChannel, VoiceConnectionStatus, entersState } = require('@discordjs/voice');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('join')
        .setDescription('Summon Soren into your current voice channel'),
    async execute(interaction) {
        const voiceChannel = interaction.member.voice.channel;

        if (!voiceChannel) {
            await interaction.reply({
                content: 'Hop into a voice channel first — I can\'t crash an empty room by myself!',
                flags: MessageFlags.Ephemeral,
            });
            return;
        }

        await interaction.deferReply();

        const connection = joinVoiceChannel({
            channelId: voiceChannel.id,
            guildId: voiceChannel.guild.id,
            adapterCreator: voiceChannel.guild.voiceAdapterCreator,
        });

        try {
            await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
            await interaction.editReply(`🎧 Dropped into **${voiceChannel.name}**! *(Psst: run \`/notes start\` if you actually want me taking meeting notes.)*`);
        } catch {
            connection.destroy();
            await interaction.editReply(`Couldn't make it into **${voiceChannel.name}**: connection timed out or failed.`);
        }
    },
};
