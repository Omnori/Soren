const { MessageFlags } = require('discord.js');
const {
    getGuildConfig,
    setGuildNotionConfig,
    clearGuildNotionConfig,
} = require('../../../lib/guildConfig');
const {
    normalizeNotionId,
    maskToken,
    validateWikiPageAccess,
    getWikiPageInfo,
    provisionWikiStructure,
    createCentralWikiHub,
} = require('../../../lib/notion');
const { sanitizeErrorMessage } = require('../../../lib/safeError');
const { checkAdminPermission, statusBadge, formatStatus } = require('./helpers');
const { activeAskCollectors } = require('./assistant');

async function handleSetNotion(interaction) {
    const guildId = interaction.guildId;
    if (!checkAdminPermission(interaction)) {
        await interaction.reply({
            content: 'You need the Manage Server permission or be the Server Owner to configure Notion integration.',
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    const token = interaction.options.getString('token')?.trim();
    const wikiInput = interaction.options.getString('wiki')?.trim();

    if (!token || !wikiInput) {
        await interaction.reply({
            content: 'Both `token` and `wiki` parameters are required.',
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    const normalizedId = normalizeNotionId(wikiInput);
    if (!normalizedId) {
        await interaction.reply({
            content: '⚠️ Invalid Notion page ID or URL format. Please provide a valid Notion page URL or 32-character Page ID.',
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    // Validate access to the wiki page via Notion API
    const validation = await validateWikiPageAccess(token, normalizedId);

    if (!validation.valid) {
        if (validation.isConnectionShareError) {
            await interaction.editReply({
                content: '⚠️ **Cannot access the specified Notion Wiki page.**\n\n' +
                    'Please ensure you have connected your Notion integration to this page:\n' +
                    '1. Open the wiki page in Notion\n' +
                    '2. Click **Share** (or `...` in the top-right corner)\n' +
                    '3. Go to **Connections** (or **Add connections**)\n' +
                    '4. Select your integration\n\n' +
                    'Once connected, run `/notes setnotion` again.',
            });
            return;
        }

        if (validation.isUnauthorized) {
            await interaction.editReply({
                content: '⚠️ **Invalid Notion API Token.**\n\n' +
                    'Please verify that your internal integration secret (usually starting with `ntn_` or `secret_`) ' +
                    'was copied correctly from [Notion Integrations](https://www.notion.so/my-integrations) and is still active.',
            });
            return;
        }

        await interaction.editReply({
            content: `⚠️ **Failed to connect to Notion:** ${validation.message || 'Unknown error'}\n\n` +
                'Please verify the page ID and ensure your Notion integration is added under page **Share → Connections**.',
        });
        return;
    }

    // Auto-provision or link children under the wiki page (Meetings, Org Info, Action Items)
    const existingConfig = {
        ...getGuildConfig(guildId),
        orgName: interaction.guild.name,
    };
    let provision;
    try {
        provision = await provisionWikiStructure(token, validation.pageId, existingConfig);
    } catch (err) {
        console.error(`[notes:${guildId}] Failed to provision Notion wiki structure:`, err);
        await interaction.editReply({
            content: `⚠️ **Notion page verified, but auto-provisioning failed:** ${sanitizeErrorMessage(err)}\n` +
                'Please verify your integration has edit permissions and re-run `/notes setnotion`.',
        });
        return;
    }

    // Save { notionToken, wikiPageId, meetingsDbId, orgInfoPageId, actionItemsDbId, membersDbId } encrypted at rest
    setGuildNotionConfig(guildId, {
        notionToken: token,
        wikiPageId: validation.pageId,
        meetingsDbId: provision.meetingsDbId,
        orgInfoPageId: provision.orgInfoPageId,
        actionItemsDbId: provision.actionItemsDbId,
        membersDbId: provision.membersDbId,
    });

    const layoutBadge = {
        preserved_existing: '🛡️ *Existing wiki structure preserved 100%*',
        created_comprehensive: '✨ *Comprehensive executive Central Wiki layout auto-built*',
        augmented_missing_parts: '🧩 *Augmented with missing operational framework & sprint board*',
    }[provision.layoutStatus] || '🛡️ *Structure mapped*';

    await interaction.editReply({
        content: `✅ **Notion Wiki Connected & Intelligently Provisioned for ${interaction.guild.name}!**\n` +
            `- **Wiki Root:** **${validation.title}** (\`${validation.pageId}\`)\n` +
            `- **Central Wiki Structure:** ${layoutBadge}\n` +
            `- **Notion Token:** ${maskToken(token)}\n\n` +
            `**Provisioned Entities:**\n` +
            `- 📅 **Meetings Database:** \`${provision.meetingsDbId}\` ${statusBadge(provision.created.meetings)}\n` +
            `- 🏢 **Org Info Page:** \`${provision.orgInfoPageId}\` ${statusBadge(provision.created.orgInfo)}\n` +
            `- ✅ **Action Items Database:** \`${provision.actionItemsDbId}\` ${statusBadge(provision.created.actionItems)}\n` +
            `- 👥 **Members Database:** \`${provision.membersDbId}\` ${statusBadge(provision.created.members)}`,
    });
}

async function handleNotionInfo(interaction) {
    const guildId = interaction.guildId;
    const config = getGuildConfig(guildId);

    if (!config.notionToken || !config.wikiPageId) {
        await interaction.reply({
            content: `**Notion Wiki Configuration for ${interaction.guild.name}:**\n` +
                `- **Status:** _Not configured_\n\n` +
                `Use \`/notes setnotion token:<token> wiki:<page_id>\` to connect your server's Notion wiki.`,
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const check = await getWikiPageInfo(config.notionToken, config.wikiPageId);

    if (check.valid) {
        await interaction.editReply({
            content: `**Notion Wiki Configuration for ${interaction.guild.name}:**\n` +
                `- **Connection Status:** 🟢 Connected\n` +
                `- **Wiki Title:** **${check.title}**\n` +
                `- **Notion Token:** ${maskToken(config.notionToken)}\n\n` +
                `**Integration Entities:**\n` +
                `- 📅 **Meetings Database:** ${formatStatus(config.meetingsDbId)}\n` +
                `- 🏢 **Org Info Page:** ${formatStatus(config.orgInfoPageId)}\n` +
                `- ✅ **Action Items Database:** ${formatStatus(config.actionItemsDbId)}\n` +
                `- 👥 **Members Database:** ${formatStatus(config.membersDbId)}`,
        });
    } else {
        const safeErr = sanitizeErrorMessage(check.message || 'Access denied');
        await interaction.editReply({
            content: `**Notion Wiki Configuration for ${interaction.guild.name}:**\n` +
                `- **Connection Status:** 🔴 Connection Error (${safeErr})\n` +
                `- **Notion Token:** ${maskToken(config.notionToken)}\n\n` +
                `_Tip: Open the page in Notion → Share → Connections → ensure your integration is added._`,
        });
    }
}

async function handleNotionProvision(interaction) {
    const guildId = interaction.guildId;
    if (!checkAdminPermission(interaction)) {
        await interaction.reply({
            content: 'You need the Manage Server permission or be the Server Owner to provision the Notion wiki.',
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    const config = getGuildConfig(guildId);
    if (!config.notionToken || !config.wikiPageId) {
        await interaction.reply({
            content: 'Notion is not configured for this server yet. Use `/notes setnotion token:<token> wiki:<page_id>` first.',
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
        const configWithOrg = {
            ...config,
            orgName: interaction.guild.name,
        };
        const provision = await provisionWikiStructure(config.notionToken, config.wikiPageId, configWithOrg);

        setGuildNotionConfig(guildId, {
            notionToken: config.notionToken,
            wikiPageId: config.wikiPageId,
            meetingsDbId: provision.meetingsDbId,
            orgInfoPageId: provision.orgInfoPageId,
            actionItemsDbId: provision.actionItemsDbId,
            membersDbId: provision.membersDbId,
        });

        const layoutBadge = {
            preserved_existing: '🛡️ *Existing wiki structure preserved 100%*',
            created_comprehensive: '✨ *Comprehensive executive Central Wiki layout auto-built*',
            augmented_missing_parts: '🧩 *Augmented with missing operational framework & sprint board*',
        }[provision.layoutStatus] || '🛡️ *Structure mapped*';

        await interaction.editReply({
            content: `**Notion Wiki Provisioning for ${interaction.guild.name}:**\n\n` +
                `- **Central Wiki Structure:** ${layoutBadge}\n` +
                `**Entities:**\n` +
                `- 📅 **Meetings Database:** ${statusBadge(provision.created.meetings)}\n` +
                `- 🏢 **Org Info Page:** ${statusBadge(provision.created.orgInfo)}\n` +
                `- ✅ **Action Items Database:** ${statusBadge(provision.created.actionItems)}\n` +
                `- 👥 **Members Database:** ${statusBadge(provision.created.members)}`,
        });
    } catch (err) {
        console.error(`[notes:${guildId}] Notion provisioning failed:`, err);
        await interaction.editReply({
            content: `⚠️ **Provisioning failed:** ${sanitizeErrorMessage(err)}`,
        });
    }
}

async function handleCreateHub(interaction) {
    const guildId = interaction.guildId;
    if (!checkAdminPermission(interaction)) {
        await interaction.reply({
            content: 'You need the Manage Server permission or be the Server Owner to create a Central Wiki Hub.',
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    const config = getGuildConfig(guildId);
    if (!config.notionToken || !config.wikiPageId) {
        await interaction.reply({
            content: 'Notion is not configured for this server yet. Use `/notes setnotion token:<token> wiki:<page_id>` first.',
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    await interaction.deferReply();

    try {
        const orgName = interaction.options.getString('name')?.trim() || interaction.guild?.name || 'Soren';
        const page = await createCentralWikiHub(config.notionToken, config.wikiPageId, orgName);
        const pageUrl = page.url || `https://notion.so/${page.id.replace(/-/g, '')}`;

        await interaction.editReply({
            content: `🏛️ **Executive Central Wiki Hub Created Successfully!**\n\n` +
                `- **Title:** **${orgName} Central Wiki**\n` +
                `- **Notion URL:** [Open in Notion](${pageUrl})\n\n` +
                `**Architecture & Layout:**\n` +
                `• 📢 **Executive Callout Banner**: Notice Board, Active Sprint Focus & North Star Metric\n` +
                `• 🏛️ **2-Column Workspace Grid**:\n` +
                `  - **Column 1**: Strategy & Philosophy, Leadership, Capital & Startup Finance (≤5% dilution rule), Agency Services, Brand Assets\n` +
                `  - **Column 2**: Products & Tech Lab (Nori V Cam), Strategic Partnerships, Client Accounts & CRM (Diyo, Kaapi), Public Website & Roster\n` +
                `• 🗄️ **Master Registries**: Connected with Meetings DB, Action Items DB, Members DB, and Living Org Memory\n\n` +
                `Anyone reviewing this Notion page can now immediately understand your entire organization at a glance!`,
        });
    } catch (err) {
        console.error(`[notes:${guildId}] Failed to create Central Wiki Hub:`, err);
        await interaction.editReply({
            content: `⚠️ **Failed to create Central Wiki Hub:** ${sanitizeErrorMessage(err)}`,
        });
    }
}

async function handleClearNotion(interaction) {
    const guildId = interaction.guildId;
    if (!checkAdminPermission(interaction)) {
        await interaction.reply({
            content: 'You need the Manage Server permission or be the Server Owner to configure Notion integration.',
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    clearGuildNotionConfig(guildId);

    // Cancel any active ask collectors for this guild
    for (const [key, collector] of activeAskCollectors.entries()) {
        if (key.startsWith(`${guildId}:`)) {
            try {
                collector.stop('guild_cleared');
            } catch {
                // Ignore collector stop error
            }
            activeAskCollectors.delete(key);
        }
    }

    await interaction.reply({
        content: `Notion integration and wiki configurations removed for **${interaction.guild.name}**.`,
        flags: MessageFlags.Ephemeral,
    });
}

module.exports = {
    handleSetNotion,
    handleNotionInfo,
    handleNotionProvision,
    handleCreateHub,
    handleClearNotion,
};
