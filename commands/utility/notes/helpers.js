const { PermissionFlagsBits } = require('discord.js');

function checkAdminPermission(interaction) {
    if (interaction.guild?.ownerId === interaction.user?.id) return true;
    return interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ||
           interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);
}

function statusBadge(isCreated) {
    return isCreated ? '✨ *Auto-created*' : '🔗 *Linked existing*';
}

function formatStatus(id) {
    return id ? '✅ Configured' : '⚪ Not configured';
}

module.exports = {
    checkAdminPermission,
    statusBadge,
    formatStatus,
};
