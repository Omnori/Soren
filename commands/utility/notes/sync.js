const { MessageFlags } = require('discord.js');
const {
    getGuildConfig,
    setGuildNotionConfig,
    getLatestCompletedSession,
} = require('../../../lib/guildConfig');
const { syncOrgInfoForGuild } = require('../../../lib/orgInfoSync');
const { sanitizeErrorMessage } = require('../../../lib/safeError');
const { checkAdminPermission } = require('./helpers');

async function handleSyncMode(interaction) {
    const guildId = interaction.guildId;
    if (!checkAdminPermission(interaction)) {
        await interaction.reply({
            content: 'You need the Manage Server permission or be the Server Owner to change Notion sync mode.',
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    const mode = interaction.options.getString('mode');
    setGuildNotionConfig(guildId, { syncMode: mode });

    const modeDesc = mode === 'automatic'
        ? '🤖 **Automatic**: Meeting notes will automatically extract and patch facts/decisions into Org Info upon `/notes stop`.'
        : '✋ **Manual**: Automatic updates are paused. Use `/notes sync` whenever you want to sync meeting facts into Org Info.';

    await interaction.reply({
        content: `**Notion Sync Mode Updated for ${interaction.guild.name}:**\n` +
            `- **Active Mode:** \`${mode}\`\n\n` +
            `${modeDesc}`,
        flags: MessageFlags.Ephemeral,
    });
}

async function handleSync(interaction) {
    const guildId = interaction.guildId;
    if (!checkAdminPermission(interaction)) {
        await interaction.reply({
            content: 'You need the Manage Server permission or be the Server Owner to run Org Info sync.',
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    const config = getGuildConfig(guildId);
    if (!config.notionToken || !config.orgInfoPageId) {
        await interaction.reply({
            content: 'Notion is not configured for this server. Use `/notes setnotion token:<token> wiki:<page_id>` first.',
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    let notesText = interaction.options.getString('notes')?.trim();

    if (!notesText) {
        const latestSession = getLatestCompletedSession(guildId);
        if (latestSession && latestSession.summary_text) {
            notesText = latestSession.summary_text;
        }
    }

    if (!notesText) {
        await interaction.reply({
            content: 'No recent meeting notes found in the database. Run a voice meeting with `/notes start` and `/notes stop` first, or provide notes directly via `/notes sync notes:<text>`.',
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
        const syncRes = await syncOrgInfoForGuild({
            guildId,
            meetingNotes: notesText,
            force: true,
        });

        if (!syncRes.success) {
            await interaction.editReply({
                content: `⚠️ **Sync could not proceed:** ${syncRes.reason || 'Unknown reason'}`,
            });
            return;
        }

        if (syncRes.applied === 0) {
            await interaction.editReply({
                content: `ℹ️ **Org Info Synchronized:** No new organizational facts, ongoing projects, or decisions required updating from the latest notes.`,
            });
            return;
        }

        let patchDetails = '';
        let omittedCount = 0;
        for (const p of syncRes.patches) {
            const badge = p.action === 'update' ? '🔄 [UPDATE]' : '➕ [ADD]';
            const line = `• ${badge} **${p.section}**: ${p.content}\n`;
            if ((patchDetails + line).length > 1400) {
                omittedCount++;
            } else {
                patchDetails += line;
            }
        }
        if (omittedCount > 0) {
            patchDetails += `\n_...and ${omittedCount} additional patch(es)._`;
        }

        const nbSection = syncRes.noticeBoardUpdated
            ? `\n\n⚡ **Central Wiki Notice Board:** Synchronized ${syncRes.noticeBoardItems.length} announcement(s)!`
            : '';

        await interaction.editReply({
            content: `✅ **Org Info Synchronized for ${interaction.guild.name}!**\n` +
                `- **Facts Added:** ${syncRes.addedCount}\n` +
                `- **Facts Updated:** ${syncRes.updatedCount}\n\n` +
                `**Applied Block Patches:**\n${patchDetails.trim()}${nbSection}`,
        });
    } catch (err) {
        console.error(`[notes:${guildId}] Org Info sync failed:`, err);
        await interaction.editReply({
            content: `⚠️ **Org Info sync encountered an error:** ${sanitizeErrorMessage(err)}`,
        });
    }
}

module.exports = {
    handleSyncMode,
    handleSync,
};
