import { Client, Events, GatewayIntentBits, PermissionFlagsBits, type Guild } from 'discord.js';
import { loadConfig } from './config.js';
import { Newtype } from './newtype.js';
import { isDangerous } from './policy.js';

const config = loadConfig(process.env);
const newtype = new Newtype(config);

// Audit log entries arrive through GuildModeration; Guilds keeps roles and channels cached.
// Members are fetched one at a time when they act, so no privileged intent is needed.
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildModeration] });

const REQUIRED = {
	ViewAuditLog: PermissionFlagsBits.ViewAuditLog,
	ManageRoles: PermissionFlagsBits.ManageRoles,
	KickMembers: PermissionFlagsBits.KickMembers,
	BanMembers: PermissionFlagsBits.BanMembers,
};

// Warn about anything that would stop Newtype from protecting this server
function checkSetup(guild: Guild): void {
	const me = guild.members.me;
	if (!me) return;

	const missing = Object.entries(REQUIRED).filter(([, flag]) => !me.permissions.has(flag)).map(([name]) => name);
	if (missing.length) {
		console.warn(`[${guild.name}] Missing permissions: ${missing.join(', ')}. Newtype cannot act until they are granted.`);
	}

	// Members holding these roles are out of Newtype's reach
	const above = guild.roles.cache
		.filter((r) => r.position > me.roles.highest.position && isDangerous(r.permissions.bitfield))
		.sort((a, b) => b.position - a.position)
		.map((r) => r.name);
	if (above.length) {
		console.warn(`[${guild.name}] These privileged roles rank above Newtype, so their members are exempt: ${above.join(', ')}. Move Newtype's role above them unless that exemption is intended.`);
	}

	const channelId = config.logChannels.get(guild.id);
	if (!channelId) {
		console.warn(`[${guild.name}] No log channel in NEWTYPE_LOG_CHANNELS; alerts go to the owner by DM only.`);
	} else if (!guild.channels.cache.get(channelId)?.isTextBased()) {
		console.warn(`[${guild.name}] Log channel ${channelId} is missing or not a text channel.`);
	}
}

client.once(Events.ClientReady, (ready) => {
	console.log(`Newtype online as ${ready.user.tag} in ${config.mode.toUpperCase()} mode, watching ${ready.guilds.cache.size} server(s)`);
	ready.guilds.cache.forEach(checkSetup);
});

client.on(Events.GuildCreate, checkSetup);

client.on(Events.GuildAuditLogEntryCreate, (entry, guild) => {
	newtype
		.handle({ action: entry.action, executorId: entry.executorId, targetId: entry.targetId, createdTimestamp: entry.createdTimestamp, changes: entry.changes }, guild)
		.catch((error: Error) => console.error(`[${guild.name}] Failed to handle audit entry ${entry.id}: ${error.stack ?? error.message}`));
});

await client.login(config.token);
