const { MessageFlags, PermissionFlagsBits } = require('discord.js');
const { getGuildConfig } = require('../../../lib/guildConfig');
const { getNotionClient } = require('../../../lib/notion');
const { readNoticeBoard, updateNoticeBoardCallout } = require('../../../lib/noticeBoard');
const { sanitizeErrorMessage } = require('../../../lib/notion');

async function handleNotice(interaction) {
    const guildId = interaction.guildId;
    const config = getGuildConfig(guildId);

    if (!config.notionToken || !config.wikiPageId) {
        await interaction.reply({
            content: '⚠️ **Notion Central Wiki is not connected.** Configure it first via `/notes setnotion` or `/notion setup`.',
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    const action = interaction.options.getString('action') || 'view';
    const text = interaction.options.getString('text');
    const category = interaction.options.getString('category');

    const client = getNotionClient(config.notionToken);

    // View action
    if (action === 'view') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        try {
            const nb = await readNoticeBoard(client, config.wikiPageId);
            if (!nb.exists) {
                await interaction.editReply({
                    content: 'ℹ️ No Sprint Focus & Notice Board callout banner found on the Central Wiki.',
                });
                return;
            }

            const itemsFormatted = (nb.items || []).map((it) => `• ${it}`).join('\n');
            const wikiUrl = `https://notion.so/${config.wikiPageId.replace(/-/g, '')}`;

            const response = `⚡ **${nb.title || 'Sprint Focus & Notice Board'}**\n\n` +
                (itemsFormatted ? `${itemsFormatted}\n\n` : '_No active announcements posted._\n\n') +
                `🎯 **North Star:** ${nb.northStar}\n` +
                `💡 **Core Policy:** ${nb.corePolicy}\n\n` +
                `🔗 [View Central Wiki in Notion](${wikiUrl})`;

            await interaction.editReply({ content: response });
            return;
        } catch (err) {
            await interaction.editReply({
                content: `⚠️ Failed to retrieve Notice Board: ${sanitizeErrorMessage(err.message)}`,
            });
            return;
        }
    }

    // Mutating actions require Admin or ManageGuild permissions
    const memberPerms = interaction.memberPermissions;
    const isAdmin = memberPerms?.has(PermissionFlagsBits.Administrator) ||
                    memberPerms?.has(PermissionFlagsBits.ManageGuild) ||
                    interaction.user.id === interaction.guild?.ownerId;

    if (!isAdmin) {
        await interaction.reply({
            content: '⛔ You need Administrator or Manage Server permissions to modify the Central Wiki Notice Board.',
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    if ((action === 'add' || action === 'set') && (!text || !text.trim())) {
        await interaction.reply({
            content: `⚠️ Please provide \`text\` when using action \`${action}\`.`,
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    await interaction.deferReply();

    try {
        const updateRes = await updateNoticeBoardCallout(client, config.wikiPageId, {
            action,
            text,
            category,
        });

        const wikiUrl = `https://notion.so/${config.wikiPageId.replace(/-/g, '')}`;
        const itemsFormatted = (updateRes.items || []).map((it) => `• ${it}`).join('\n');

        const replyContent = `✅ **Central Wiki Notice Board Updated!** (${action.toUpperCase()})\n\n` +
            `⚡ **${updateRes.title || 'Sprint Focus & Notice Board'}**\n` +
            (itemsFormatted ? `${itemsFormatted}\n\n` : '_All dynamic announcements cleared._\n\n') +
            `🔗 [Open Central Hub in Notion](${wikiUrl})`;

        await interaction.editReply({ content: replyContent });
    } catch (err) {
        console.error(`[notes:${guildId}] Failed to update notice board:`, err);
        await interaction.editReply({
            content: `⚠️ Failed to update Notice Board: ${sanitizeErrorMessage(err.message)}`,
        });
    }
}

module.exports = { handleNotice };
