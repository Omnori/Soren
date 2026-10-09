const { SlashCommandBuilder, ChannelType } = require('discord.js');

const { startNotes, stopNotes, handleButton } = require('./notes/voice');
const {
    handleChannel,
    handleSetKey,
    handleSetModel,
    handleClearKey,
    handleKeyInfo,
    handleStats,
} = require('./notes/config');
const {
    handleSetNotion,
    handleNotionInfo,
    handleClearNotion,
    handleNotionProvision,
    handleCreateHub,
} = require('./notes/notion');
const { handleSyncMode, handleSync } = require('./notes/sync');
const { handleAsk, handleAudit } = require('./notes/assistant');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('notes')
        .setDescription('Voice-channel note taking (Powered by Groq & Gemini)')
        .addSubcommand((sub) =>
            sub
                .setName('start')
                .setDescription('Join your voice channel and start taking notes')
                .addStringOption((opt) =>
                    opt
                        .setName('provider')
                        .setDescription('Override summary AI provider for this session')
                        .setRequired(false)
                        .addChoices({ name: 'Groq', value: 'groq' }, { name: 'Gemini', value: 'gemini' }),
                )
                .addStringOption((opt) =>
                    opt
                        .setName('model')
                        .setDescription('Override summary model code name (e.g. openai/gpt-oss-120b, gemini-2.5-flash)')
                        .setRequired(false),
                ),
        )
        .addSubcommand((sub) => sub.setName('stop').setDescription('Stop taking notes and post a summary'))
        .addSubcommand((sub) =>
            sub
                .setName('channel')
                .setDescription('View or set the channel notes get posted to')
                .addChannelOption((opt) =>
                    opt
                        .setName('channel')
                        .setDescription('Text channel to post notes in (omit to view current)')
                        .addChannelTypes(ChannelType.GuildText)
                        .setRequired(false),
                ),
        )
        .addSubcommand((sub) =>
            sub
                .setName('setkey')
                .setDescription('Set Groq / Gemini API key and models for this server (Admins only)')
                .addStringOption((opt) =>
                    opt.setName('groq_key').setDescription('Groq API Key (used for voice STT and Groq summaries)').setRequired(false),
                )
                .addStringOption((opt) =>
                    opt.setName('gemini_key').setDescription('Gemini API Key (optional for Gemini summaries)').setRequired(false),
                )
                .addStringOption((opt) =>
                    opt
                        .setName('provider')
                        .setDescription('Preferred summary AI provider')
                        .setRequired(false)
                        .addChoices({ name: 'Groq', value: 'groq' }, { name: 'Gemini', value: 'gemini' }),
                )
                .addStringOption((opt) =>
                    opt
                        .setName('groq_model')
                        .setDescription('Groq summary model code name (e.g. openai/gpt-oss-120b, openai/gpt-oss-20b)')
                        .setRequired(false),
                )
                .addStringOption((opt) =>
                    opt
                        .setName('gemini_model')
                        .setDescription('Gemini summary model code name (e.g. gemini-2.5-flash, gemini-1.5-pro)')
                        .setRequired(false),
                ),
        )
        .addSubcommand((sub) =>
            sub
                .setName('setmodel')
                .setDescription('Set summary AI model code names for Groq or Gemini (Admins only)')
                .addStringOption((opt) =>
                    opt
                        .setName('groq_model')
                        .setDescription('Groq summary model code name (e.g. openai/gpt-oss-120b, openai/gpt-oss-20b)')
                        .setRequired(false),
                )
                .addStringOption((opt) =>
                    opt
                        .setName('gemini_model')
                        .setDescription('Gemini summary model code name (e.g. gemini-2.5-flash, gemini-1.5-pro)')
                        .setRequired(false),
                ),
        )
        .addSubcommand((sub) => sub.setName('clearkey').setDescription('Clear API keys and model configurations for this server'))
        .addSubcommand((sub) => sub.setName('keyinfo').setDescription('View API keys and model configuration for this server'))
        .addSubcommand((sub) => sub.setName('stats').setDescription('View voice notes stats and meeting history for this server'))
        .addSubcommand((sub) =>
            sub
                .setName('setnotion')
                .setDescription('Connect server to a Notion Wiki page (Admins only)')
                .addStringOption((opt) =>
                    opt
                        .setName('token')
                        .setDescription('Notion internal integration secret (starts with ntn_ or secret_)')
                        .setRequired(true),
                )
                .addStringOption((opt) =>
                    opt
                        .setName('wiki')
                        .setDescription('Notion Wiki root page URL or Page ID')
                        .setRequired(true),
                ),
        )
        .addSubcommand((sub) =>
            sub
                .setName('notioninfo')
                .setDescription('View Notion wiki connection status and page details for this server'),
        )
        .addSubcommand((sub) =>
            sub
                .setName('clearnotion')
                .setDescription('Disconnect and clear Notion wiki configuration for this server (Admins only)'),
        )
        .addSubcommand((sub) =>
            sub
                .setName('notionprovision')
                .setDescription('Verify or re-provision wiki databases and pages (Meetings, Org Info, Action Items) (Admins only)'),
        )
        .addSubcommand((sub) =>
            sub
                .setName('createhub')
                .setDescription('Generate an executive Soren-style Central Wiki Dashboard in Notion (Admins only)')
                .addStringOption((opt) =>
                    opt
                        .setName('name')
                        .setDescription('Organization name for the Central Wiki (default: server name)')
                        .setRequired(false),
                ),
        )
        .addSubcommand((sub) =>
            sub
                .setName('syncmode')
                .setDescription('Toggle Org Info sync mode between automatic and manual (Admins only)')
                .addStringOption((opt) =>
                    opt
                        .setName('mode')
                        .setDescription('Sync mode: automatic or manual')
                        .setRequired(true)
                        .addChoices(
                            { name: 'Automatic (Sync after every meeting)', value: 'automatic' },
                            { name: 'Manual (Sync via /notes sync only)', value: 'manual' },
                        ),
                ),
        )
        .addSubcommand((sub) =>
            sub
                .setName('sync')
                .setDescription('Extract and sync facts/decisions from the latest meeting into Org Info (Admins only)')
                .addStringOption((opt) =>
                    opt
                        .setName('notes')
                        .setDescription('Optional specific notes text to sync (omit to use latest meeting)')
                        .setRequired(false),
                ),
        )
        .addSubcommand((sub) =>
            sub
                .setName('ask')
                .setDescription('Ask questions grounded in the server wiki, meeting notes, and personal tasks')
                .addStringOption((opt) =>
                    opt
                        .setName('question')
                        .setDescription('Your question about projects, decisions, meetings, or tasks')
                        .setRequired(true),
                )
                .addUserOption((opt) =>
                    opt
                        .setName('member')
                        .setDescription('Admin only: query another member personal notes and tasks')
                        .setRequired(false),
                ),
        )
        .addSubcommand((sub) =>
            sub
                .setName('audit')
                .setDescription('View recent assistant Q&A and Notion update audit logs (Admins only)')
                .addIntegerOption((opt) =>
                    opt
                        .setName('limit')
                        .setDescription('Number of logs to view (default: 10, max: 25)')
                        .setRequired(false),
                ),
        ),

    async execute(interaction) {
        const sub = interaction.options.getSubcommand();
        if (sub === 'start') return startNotes(interaction);
        if (sub === 'stop') return stopNotes(interaction);
        if (sub === 'channel') return handleChannel(interaction);
        if (sub === 'setkey') return handleSetKey(interaction);
        if (sub === 'setmodel') return handleSetModel(interaction);
        if (sub === 'clearkey') return handleClearKey(interaction);
        if (sub === 'keyinfo') return handleKeyInfo(interaction);
        if (sub === 'stats') return handleStats(interaction);
        if (sub === 'setnotion') return handleSetNotion(interaction);
        if (sub === 'notioninfo') return handleNotionInfo(interaction);
        if (sub === 'clearnotion') return handleClearNotion(interaction);
        if (sub === 'notionprovision') return handleNotionProvision(interaction);
        if (sub === 'createhub') return handleCreateHub(interaction);
        if (sub === 'syncmode') return handleSyncMode(interaction);
        if (sub === 'sync') return handleSync(interaction);
        if (sub === 'ask') return handleAsk(interaction);
        if (sub === 'audit') return handleAudit(interaction);
    },
    handleButton,
};
