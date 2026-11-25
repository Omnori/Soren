require('dotenv').config({ quiet: true });

// Require the necessary discord.js classes
const fs = require('node:fs');
const path = require('node:path');
const { Client, Collection, Events, GatewayIntentBits, MessageFlags } = require('discord.js');
const { sanitizeErrorMessage } = require('./lib/safeError');
const { pruneOldConversationHistory } = require('./lib/database');
const {
    runAndPersistAssistantTurn,
    handleAssistantButton,
    hasAdminPermission,
    runScheduledDigests,
} = require('./lib/assistantDiscord');
let token = process.env.DISCORD_TOKEN;
if (!token) {
    try {
        const config = require('./config.json');
        token = config.token;
    } catch {
        // config.json missing or doesn't contain token
    }
}

if (!token) {
    console.error('Error: DISCORD_TOKEN is not set in environment or config.json.');
    process.exit(1);
}

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ],
});

client.once(Events.ClientReady, (readyClient) => {
    console.log(`Ready! Logged in as ${readyClient.user.tag}`);
    // Prune expired conversation memory & check proactive daily digests hourly
    const runMaintenance = () => {
        pruneOldConversationHistory();
        runScheduledDigests(readyClient).catch((err) => {
            console.warn('[digest] Scheduled digest loop error:', err.message);
        });
    };
    setTimeout(runMaintenance, 15_000).unref();
    setInterval(runMaintenance, 60 * 60 * 1000).unref();
});

// Log in to Discord with your client's token
client.login(token);


client.commands = new Collection();
const foldersPath = path.join(__dirname, 'commands');
const commandFolders = fs.readdirSync(foldersPath);
for (const folder of commandFolders) {
    const commandsPath = path.join(foldersPath, folder);
    const commandFiles = fs.readdirSync(commandsPath).filter((file) => file.endsWith('.js'));
    for (const file of commandFiles) {
        const filePath = path.join(commandsPath, file);
        const command = require(filePath);
        // Set a new item in the Collection with the key as the command name and the value as the exported module
        if ('data' in command && 'execute' in command) {
            client.commands.set(command.data.name, command);
        } else {
            console.log(`[WARNING] The command at ${filePath} is missing a required "data" or "execute" property.`);
        }
    }
}
client.on(Events.InteractionCreate, async (interaction) => {
    if (interaction.isChatInputCommand()) {
        const command = interaction.client.commands.get(interaction.commandName);

        if (!command) {
            console.error(`No command matching ${interaction.commandName} was found.`);
            return;
        }

        try {
            await command.execute(interaction);
        } catch (error) {
            console.error(`[InteractionError:${interaction.commandName}]`, error);
            const errorDetail = sanitizeErrorMessage(error);
            const userMessage = `**Error executing /${interaction.commandName}:** ${errorDetail}`.slice(0, 1950);

            if (interaction.replied || interaction.deferred) {
                await interaction.followUp({ content: userMessage, flags: MessageFlags.Ephemeral }).catch(() => {});
            } else {
                await interaction.reply({ content: userMessage, flags: MessageFlags.Ephemeral }).catch(() => {});
            }
        }
        return;
    }

    if (interaction.isButton()) {
        if (interaction.customId.startsWith('retry_notes:')) {
            const command = interaction.client.commands.get('notes');
            if (command && typeof command.handleButton === 'function') {
                try {
                    await command.handleButton(interaction);
                } catch (error) {
                    console.error('[ButtonError:retry_notes]', error);
                    const errorDetail = sanitizeErrorMessage(error);
                    const userMessage = `**Retry error:** ${errorDetail}`.slice(0, 1950);
                    if (interaction.replied || interaction.deferred) {
                        await interaction.followUp({ content: userMessage, flags: MessageFlags.Ephemeral }).catch(() => {});
                    } else {
                        await interaction.reply({ content: userMessage, flags: MessageFlags.Ephemeral }).catch(() => {});
                    }
                }
            }
            return;
        }

        if (
            interaction.customId.startsWith('confirm_action:') ||
            interaction.customId.startsWith('cancel_action:') ||
            interaction.customId.startsWith('task_done:')
        ) {
            try {
                await handleAssistantButton(interaction);
            } catch (error) {
                console.error('[ButtonError:assistant]', error);
                const errorDetail = sanitizeErrorMessage(error);
                const userMessage = `**Action error:** ${errorDetail}`.slice(0, 1950);
                if (interaction.replied || interaction.deferred) {
                    await interaction.followUp({ content: userMessage, flags: MessageFlags.Ephemeral }).catch(() => {});
                } else {
                    await interaction.reply({ content: userMessage, flags: MessageFlags.Ephemeral }).catch(() => {});
                }
            }
        }
    }
});

const { sendSafeMessageReply } = require('./lib/discordUtils');
const { getGuildConfig } = require('./lib/guildConfig');

client.on(Events.MessageCreate, async (message) => {
    // Ignore bot messages or direct messages
    if (message.author.bot || !message.guildId) return;

    const guildId = message.guildId;
    const config = getGuildConfig(guildId);
    const isMention = message.mentions.has(client.user.id);
    const isAssistantChannel = Boolean(config.assistantChannelId && message.channelId === config.assistantChannelId);
    const isAssistantThread = Boolean(
        message.channel?.isThread?.() && (
            message.channel.ownerId === client.user.id ||
            (config.assistantChannelId && message.channel.parentId === config.assistantChannelId)
        )
    );

    if (!isMention && !isAssistantChannel && !isAssistantThread) return;

    // In passive channels, ignore slash/bang/comment prefixes so users can still have side notes
    if (!isMention && /^[!/#]/.test((message.content || '').trim())) return;

    // Ignore replies explicitly directed at another non-bot user unless @Soren was mentioned
    if (!isMention && message.reference?.messageId && message.mentions.repliedUser && message.mentions.repliedUser.id !== client.user.id) {
        return;
    }

    // Check if Notion integration is set up
    if (!config.notionToken || !config.wikiPageId) {
        if (isMention) {
            return message.reply('Notion Integration is not configured for this server. Run `/notion setup` first.');
        }
        return;
    }

    // Clean the message content to remove the bot mention
    const mentionRegex = new RegExp(`<@!?${client.user.id}>`, 'g');
    const cleanMessage = (message.content || '').replace(mentionRegex, '').trim();

    if (!cleanMessage) {
        if (isMention) {
            return message.reply('Yes? How can I help you? Ask me about tasks, meetings, clients, or company docs — e.g. `@Soren what are my open tasks?`');
        }
        return;
    }

    try {
        await message.channel.sendTyping().catch(() => {});

        const result = await runAndPersistAssistantTurn({
            guildId,
            channelId: message.channel.id,
            userId: message.author.id,
            targetMember: message.member || message.author,
            userMessage: cleanMessage,
            isAdmin: hasAdminPermission(message),
            entryPoint: isAssistantChannel ? 'assistant_channel' : 'mention',
        });

        await sendSafeMessageReply(message, result.answer, {
            fileName: 'soren_reply.md',
            components: result.components,
        });
    } catch (err) {
        console.error('[messageCreateEvent] Grounded assistant mention error:', err);
        const safeErr = sanitizeErrorMessage(err);
        await message.reply(`Sorry, I encountered an error: ${safeErr}`).catch(() => {});
    }
});

process.on('unhandledRejection', (reason) => {
    console.error('Unhandled Promise Rejection:', reason);
});