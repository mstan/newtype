// Turns the policy's findings into actions on a real server, tells the affected member why,
// and alerts the log channel and the server owner.
import { AuditLogEvent, EmbedBuilder, type Guild } from 'discord.js';
import { Policy, type Action, type AuditEntry, type Finding, type Lookup, type RateLimit } from './policy.js';

export type Mode = 'report' | 'enforce';

export interface NewtypeOptions {
	mode: Mode;
	// guildId -> channelId for alerts and bot-add notices
	logChannels: ReadonlyMap<string, string>;
	newMemberMs?: number;
	rateLimits?: Partial<Record<AuditLogEvent, RateLimit>>;
	log?: (message: string) => void;
}

interface Outcome {
	ok: boolean;
	text: string;
}

const REASON = 'Newtype anti-nuke';

// Don't act on or alert about the same user for the same rule more than once a minute;
// a nuke produces hundreds of audit entries in a few seconds
const REPEAT_SUPPRESS_MS = 60_000;

// Audit entries whose target is a member, so fetching it tells us when they joined
const MEMBER_TARGETS = new Set([AuditLogEvent.MemberRoleUpdate, AuditLogEvent.BotAdd]);

export class Newtype {
	private readonly policies = new Map<string, Policy>();
	private readonly recent = new Map<string, number>();
	private readonly log: (message: string) => void;

	constructor(private readonly options: NewtypeOptions) {
		this.log = options.log ?? ((message) => console.log(message));
	}

	get enforce(): boolean {
		return this.options.mode === 'enforce';
	}

	private policy(guild: Guild): Policy {
		let policy = this.policies.get(guild.id);
		if (!policy) {
			policy = new Policy({
				selfId: guild.client.user.id,
				serverName: guild.name,
				newMemberMs: this.options.newMemberMs,
				rateLimits: this.options.rateLimits,
			});
			this.policies.set(guild.id, policy);
		}
		return policy;
	}

	async handle(entry: AuditEntry, guild: Guild): Promise<void> {
		// Make sure join dates and bot flags are cached for the people involved
		const ids = [entry.executorId, MEMBER_TARGETS.has(entry.action) ? entry.targetId : null];
		await Promise.all(ids.map((id) => id && guild.members.fetch(id).catch(() => guild.client.users.fetch(id).catch(() => null))));

		if (entry.action === AuditLogEvent.BotAdd) {
			await this.botAddedNotice(entry, guild);
		}

		const lookup: Lookup = {
			isBot: (id) => guild.client.users.cache.get(id)?.bot ?? false,
			rolePermissions: (id) => guild.roles.cache.get(id)?.permissions.bitfield ?? null,
			joinedAt: (id) => guild.members.cache.get(id)?.joinedTimestamp ?? null,
		};

		for (const finding of this.policy(guild).evaluate(entry, lookup)) {
			const key = `${guild.id}:${finding.rule}:${finding.actions.map((a) => a.userId).join(',')}`;
			const last = this.recent.get(key);
			if (last !== undefined && entry.createdTimestamp - last < REPEAT_SUPPRESS_MS) {
				continue;
			}
			this.recent.set(key, entry.createdTimestamp);

			const outcomes: Outcome[] = [];
			for (const action of finding.actions) {
				outcomes.push(this.enforce ? await this.apply(guild, action) : { ok: true, text: `Would ${describe(action)}` });
			}
			const dmStatus = finding.notify ? await this.notify(guild, finding.notify, outcomes) : null;
			this.log(`[${guild.name}] [${this.options.mode}] ${finding.rule}: ${finding.summary} -> ${outcomes.map((o) => o.text).join('; ')}${dmStatus ? `; ${dmStatus}` : ''}`);
			await this.alert(guild, finding, outcomes, dmStatus);
		}
	}

	private async apply(guild: Guild, action: Action): Promise<Outcome> {
		try {
			if (action.type === 'banBot') {
				await guild.bans.create(action.userId, { reason: REASON });
				return { ok: true, text: `Banned bot <@${action.userId}>` };
			}

			const member = await guild.members.fetch(action.userId).catch(() => null);
			if (!member) {
				return { ok: false, text: `<@${action.userId}> is no longer in the server` };
			}
			if (member.id === guild.ownerId) {
				return { ok: false, text: `Discord does not allow any bot to act on the server owner <@${member.id}>` };
			}

			if (action.type === 'kickBot') {
				if (!member.kickable) {
					return { ok: false, text: `Could NOT remove bot <@${member.id}>: it is ranked above Newtype` };
				}
				await member.kick(REASON);
				return { ok: true, text: `Removed bot <@${member.id}>` };
			}
			if (action.type === 'quarantine' && member.user.bot) {
				if (!member.bannable) {
					return { ok: false, text: `Could NOT ban bot <@${member.id}>: it is ranked above Newtype` };
				}
				await guild.bans.create(member.id, { reason: REASON });
				return { ok: true, text: `Banned bot <@${member.id}>` };
			}

			const roleIds = action.type === 'removeRoles' ? action.roleIds : null;
			const candidates = roleIds
				? member.roles.cache.filter((r) => roleIds.includes(r.id))
				: member.roles.cache.filter((r) => r.id !== guild.id && !r.managed);
			const removable = candidates.filter((r) => r.editable);
			const stuck = candidates.filter((r) => !r.editable);
			if (removable.size) {
				await member.roles.remove([...removable.keys()], REASON);
			}

			const parts: string[] = [];
			if (removable.size) parts.push(`Removed ${removable.map((r) => r.name).join(', ')} from <@${member.id}>`);
			if (stuck.size) parts.push(`could NOT remove ${stuck.map((r) => r.name).join(', ')}: ranked above Newtype`);
			return { ok: stuck.size === 0, text: parts.join('; ') || `<@${member.id}> had no roles to remove` };
		} catch (error) {
			return { ok: false, text: `Failed to ${describe(action)}: ${(error as Error).message}` };
		}
	}

	// Tells the member why, but only once the action actually happened
	private async notify(guild: Guild, { userId, message }: { userId: string; message: string }, outcomes: Outcome[]): Promise<string> {
		if (!this.enforce) {
			return `Would DM <@${userId}>`;
		}
		if (outcomes.some((o) => !o.ok)) {
			return `No DM sent to <@${userId}>: the action did not fully succeed`;
		}
		try {
			const user = await guild.client.users.fetch(userId);
			await user.send(message);
			return `DM sent to <@${userId}>`;
		} catch (error) {
			return `Could not DM <@${userId}>: ${(error as Error).message}`;
		}
	}

	private async alert(guild: Guild, finding: Finding, outcomes: Outcome[], dmStatus: string | null): Promise<void> {
		const embed = new EmbedBuilder()
			.setColor(this.enforce ? 0xff0000 : 0xffa500)
			.setTitle(this.enforce ? `🛡️ Newtype: ${finding.rule}` : `🔶 Newtype (report only): ${finding.rule}`)
			.setDescription(finding.summary)
			.addFields({ name: this.enforce ? 'Action taken' : 'Would have done', value: outcomes.map((o) => o.text).join('\n').slice(0, 1024) })
			.setTimestamp()
			.setFooter({ text: 'Newtype anti-nuke' });
		if (finding.notify && dmStatus) {
			embed.addFields({ name: dmStatus.slice(0, 256), value: finding.notify.message.slice(0, 1024) });
		}

		await this.sendToLogChannel(guild, embed);
		const owner = await guild.fetchOwner().catch(() => null);
		await owner?.send({ embeds: [embed] }).catch((e: Error) => this.log(`[${guild.name}] Owner DM failed: ${e.message}`));
	}

	// Every bot added to the server is logged, whoever added it and in either mode
	private async botAddedNotice(entry: AuditEntry, guild: Guild): Promise<void> {
		const adder = entry.executorId ? guild.members.cache.get(entry.executorId) : undefined;
		const bot = entry.targetId ? guild.client.users.cache.get(entry.targetId) : undefined;
		const embed = new EmbedBuilder()
			.setColor(0x5865f2)
			.setTitle('🤖 Bot added')
			.setDescription(`<@${entry.executorId}> added bot <@${entry.targetId}>`)
			.addFields(
				{ name: 'Bot', value: `${bot?.tag ?? 'unknown'} (${entry.targetId})`, inline: true },
				{ name: 'Added by', value: `${adder?.user.tag ?? 'unknown'} (${entry.executorId})`, inline: true },
				{ name: 'Adder joined', value: adder?.joinedTimestamp ? `<t:${Math.floor(adder.joinedTimestamp / 1000)}:R>` : 'unknown', inline: true },
			)
			.setTimestamp(entry.createdTimestamp)
			.setFooter({ text: 'Newtype anti-nuke' });

		if (!(await this.sendToLogChannel(guild, embed))) {
			const owner = await guild.fetchOwner().catch(() => null);
			await owner?.send({ embeds: [embed] }).catch(() => undefined);
		}
	}

	private async sendToLogChannel(guild: Guild, embed: EmbedBuilder): Promise<boolean> {
		const channelId = this.options.logChannels.get(guild.id);
		const channel = channelId ? guild.channels.cache.get(channelId) : undefined;
		if (!channel?.isTextBased()) {
			return false;
		}
		try {
			await channel.send({ embeds: [embed] });
			return true;
		} catch (error) {
			this.log(`[${guild.name}] Log channel alert failed: ${(error as Error).message}`);
			return false;
		}
	}
}

export function describe(action: Action): string {
	switch (action.type) {
		case 'banBot': return `ban bot <@${action.userId}>`;
		case 'kickBot': return `remove bot <@${action.userId}>`;
		case 'quarantine': return `remove every role from <@${action.userId}> (ban if a bot)`;
		case 'removeRoles': return `remove ${action.roleIds.map((id) => `<@&${id}>`).join(', ')} from <@${action.userId}>`;
	}
}
