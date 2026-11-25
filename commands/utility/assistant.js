const { SlashCommandBuilder, ChannelType, MessageFlags, PermissionFlagsBits } = require('discord.js');
const {
    getGuildConfig,
    setAssistantChannelId,
    setDigestChannelId,
    clearConversationHistory,
    getGuildWiki,
    getNotionItemsByGuild,
} = require('../../lib/database');
const { DEFAULT_MODELS, normalizeGeminiModel, normalizeNvidiaModel } = require('../../lib/aiConfig');
const { buildGuildDigestMessage, hasAdminPermission } = require('../../lib/assistantDiscord');
const { truncateDiscordText } = require('../../lib/discordUtils');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('assistant')
        .setDescription('Configure Soren\'s live conversational assistant, memory, and daily workspace pulse')
        .addSubcommand((sub) =>
            sub
                .setName('channel')
                .setDescription('Set or clear a dedicated channel where Soren replies without needing @Soren (Admins only)')
                .addChannelOption((opt) =>
                    opt
                        .setName('channel')
                        .setDescription('Text channel for direct chat with Soren (omit to view or pass clear)')
                        .addChannelTypes(ChannelType.GuildText)
                        .setRequired(false),
                )
                .addBooleanOption((opt) =>
                    opt
                        .setName('disable')
                        .setDescription('Disable the dedicated assistant channel')
                        .setRequired(false),
                ),
        )
        .addSubcommand((sub) =>
            sub
                .setName('digest')
                .setDescription('Configure proactive daily workspace digest or send one right now (Admins only)')
                .addChannelOption((opt) =>
                    opt
                        .setName('channel')
                        .setDescription('Channel to receive daily task & meeting digests')
                        .addChannelTypes(ChannelType.GuildText)
                        .setRequired(false),
                )
                .addBooleanOption((opt) =>
                    opt
                        .setName('post_now')
                        .setDescription('Post a live workspace pulse summary right now')
                        .setRequired(false),
                )
                .addBooleanOption((opt) =>
                    opt
                        .setName('disable')
                        .setDescription('Disable scheduled daily digests')
                        .setRequired(false),
                ),
        )
        .addSubcommand((sub) =>
            sub
                .setName('clear')
                .setDescription('Clear Soren\'s recent conversation memory in this channel/thread'),
        )
        .addSubcommand((sub) =>
            sub
                .setName('status')
                .setDescription('Check Soren\'s live AI providers, Notion grounding, memory, and channel status'),
        ),

    async execute(interaction) {
        const guildId = interaction.guildId;
        if (!guildId) {
            return interaction.reply({
                content: 'This command can only be used inside a Discord server.',
                flags: MessageFlags.Ephemeral,
            });
        }

        const sub = interaction.options.getSubcommand();

        if (sub === 'clear') {
            clearConversationHistory(guildId, interaction.channelId);
            return interaction.reply({
                content: '🧹 Cleared Soren\'s conversation memory for this channel. Fresh context starts now!',
                flags: MessageFlags.Ephemeral,
            });
        }

        if (sub === 'status') {
            const config = getGuildConfig(guildId);
            const wiki = getGuildWiki(guildId);
            const items = getNotionItemsByGuild(guildId);
            const providers = [];
            if (config.nvidiaApiKey || process.env.NVIDIA_API_KEY) providers.push(`NVIDIA (\`${normalizeNvidiaModel(config.nvidiaModel)}\`)`);
            if (config.geminiApiKey || process.env.GEMINI_API_KEY) providers.push(`Gemini (\`${normalizeGeminiModel(config.geminiModel)}\`)`);
            if (config.groqApiKey || process.env.GROQ_API_KEY) providers.push(`Groq (\`${config.groqModel || process.env.GROQ_SUMMARY_MODEL || DEFAULT_MODELS.groq}\`)`);

            const statusMsg = [
                `🤖 **Soren Live Assistant Status — ${interaction.guild.name}**`,
                `- **Primary Provider:** \`${config.summaryProvider || 'nvidia'}\``,
                `- **Configured Fallbacks:** ${providers.length ? providers.join(' · ') : '_None configured_'}`,
                `- **Notion Central Wiki:** ${config.notionToken && config.wikiPageId ? `🟢 Connected (\`${items.length}\` cached items)` : '🔴 Not configured'}`,
                `- **Last Wiki Sync:** ${wiki?.last_scanned_at ? `<t:${Math.floor(wiki.last_scanned_at / 1000)}:R>` : '`Never`'}`,
                `- **Dedicated Chat Channel:** ${config.assistantChannelId ? `<#${config.assistantChannelId}>` : '_Mention `@Soren` in any channel_'}`,
                `- **Daily Pulse Digest:** ${config.digestChannelId ? `<#${config.digestChannelId}>` : '_Disabled_'}`,
            ].join('\n');

            return interaction.reply({ content: statusMsg, flags: MessageFlags.Ephemeral });
        }

        if (!hasAdminPermission(interaction)) {
            return interaction.reply({
                content: '⛔ You need Manage Server or Administrator permission to configure assistant settings.',
                flags: MessageFlags.Ephemeral,
            });
        }

        if (sub === 'channel') {
            const disable = interaction.options.getBoolean('disable');
            const channel = interaction.options.getChannel('channel');

            if (disable) {
                setAssistantChannelId(guildId, null);
                return interaction.reply({
                    content: '✅ Dedicated assistant channel disabled. Team members can still chat anytime with `@Soren` or `/ask`.',
                    flags: MessageFlags.Ephemeral,
                });
            }

            if (!channel) {
                const config = getGuildConfig(guildId);
                return interaction.reply({
                    content: config.assistantChannelId
                        ? `💬 Dedicated assistant channel is <#${config.assistantChannelId}> (no \`@Soren\` mention needed there).`
                        : 'No dedicated assistant channel is set. Pass `channel:#your-channel` to enable always-on chat.',
                    flags: MessageFlags.Ephemeral,
                });
            }

            const perms = channel.permissionsFor(interaction.guild.members.me);
            if (!perms?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])) {
                return interaction.reply({
                    content: `⚠️ I need View Channel and Send Messages permissions in ${channel}.`,
                    flags: MessageFlags.Ephemeral,
                });
            }

            setAssistantChannelId(guildId, channel.id);
            return interaction.reply(
                `💬 **Live Assistant Channel Enabled:** ${channel}\nTeam members can now talk to Soren directly there without needing \`@Soren\`!`,
            );
        }

        if (sub === 'digest') {
            const disable = interaction.options.getBoolean('disable');
            const channel = interaction.options.getChannel('channel');
            const postNow = interaction.options.getBoolean('post_now');

            if (disable) {
                setDigestChannelId(guildId, null);
                return interaction.reply({ content: '✅ Daily workspace digest disabled.', flags: MessageFlags.Ephemeral });
            }

            if (channel) {
                setDigestChannelId(guildId, channel.id);
            }

            if (postNow) {
                await interaction.deferReply();
                const digest = await buildGuildDigestMessage(guildId);
                if (!digest) {
                    return interaction.editReply('⚠️ Notion is not configured yet. Run `/notion setup` first.');
                }
                return interaction.editReply(truncateDiscordText(digest, 1900));
            }

            const config = getGuildConfig(guildId);
            if (channel) {
                return interaction.reply(`☀️ Daily workspace pulse digests will be posted to ${channel}.`);
            }
            return interaction.reply({
                content: config.digestChannelId
                    ? `☀️ Daily digests are active in <#${config.digestChannelId}>. Pass \`post_now:true\` to trigger one right now.`
                    : 'Daily digest is not set. Pass `channel:#ops` or `post_now:true`.',
                flags: MessageFlags.Ephemeral,
            });
        }
    },
};
