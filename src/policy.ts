// Decision logic, with no Discord calls so it can be tested on its own. Given one audit
// log entry and a way to look things up about the server, it returns what should be done.
import { AuditLogEvent, PermissionFlagsBits } from 'discord.js';

// A role carrying any of these can destroy the server or let someone else do it
export const DANGEROUS_PERMISSIONS = [
	PermissionFlagsBits.Administrator,
	PermissionFlagsBits.ManageGuild,
	PermissionFlagsBits.ManageRoles,
	PermissionFlagsBits.ManageChannels,
	PermissionFlagsBits.ManageWebhooks,
	PermissionFlagsBits.BanMembers,
	PermissionFlagsBits.KickMembers,
];

export const DEFAULT_NEW_MEMBER_MS = 24 * 60 * 60 * 1000;

export interface RateLimit {
	limit: number;
	windowMs: number;
	label: string;
}

// Calibrated on a 24,000-member community's normal six weeks: no person did more than 2
// of any of these in a minute and its ticket bot peaked at 4 channel deletions a minute.
// The nuke that hit it ran ~75 deletions a second. Run `npm run calibrate` for your own.
export const DEFAULT_RATE_LIMITS: Partial<Record<AuditLogEvent, RateLimit>> = {
	[AuditLogEvent.ChannelDelete]: { limit: 5, windowMs: 60_000, label: 'channel deletions' },
	[AuditLogEvent.ChannelCreate]: { limit: 5, windowMs: 60_000, label: 'channel creations' },
	[AuditLogEvent.RoleDelete]: { limit: 3, windowMs: 60_000, label: 'role deletions' },
	[AuditLogEvent.RoleCreate]: { limit: 3, windowMs: 60_000, label: 'role creations' },
	[AuditLogEvent.MemberBanAdd]: { limit: 5, windowMs: 60_000, label: 'bans' },
	[AuditLogEvent.MemberKick]: { limit: 5, windowMs: 60_000, label: 'kicks' },
	[AuditLogEvent.WebhookCreate]: { limit: 3, windowMs: 60_000, label: 'webhook creations' },
};

export interface AuditEntry {
	action: AuditLogEvent;
	executorId: string | null;
	targetId: string | null;
	createdTimestamp: number;
	changes: ReadonlyArray<{ key: string; old?: unknown; new?: unknown }>;
}

export interface Lookup {
	isBot(userId: string): boolean;
	rolePermissions(roleId: string): bigint | null;
	joinedAt(userId: string): number | null;
}

export type Action =
	| { type: 'kickBot' | 'banBot' | 'quarantine'; userId: string }
	| { type: 'removeRoles'; userId: string; roleIds: string[] };

export type Rule = 'new-member-bot' | 'new-member-privileged-role' | 'mass-action';

export interface Finding {
	rule: Rule;
	summary: string;
	actions: Action[];
	// Who to tell, and what, once the actions have succeeded
	notify?: { userId: string; message: string };
}

export interface PolicyOptions {
	// The bot's own user ID; its own actions are the only ones never evaluated
	selfId: string;
	serverName: string;
	newMemberMs?: number;
	rateLimits?: Partial<Record<AuditLogEvent, RateLimit>>;
}

export function isDangerous(permissions: bigint): boolean {
	return DANGEROUS_PERMISSIONS.some((flag) => (permissions & flag) === flag);
}

const hours = (ms: number) => Math.round(ms / 3_600_000);

export const messages = {
	privilegedRole: (server: string, roles: string, newMemberMs: number) =>
		`Hi! As a security measure, your ${roles} role${roles.includes(',') ? 's were' : ' was'} removed automatically on the ${server} Discord because your account joined the server less than ${hours(newMemberMs)} hours ago. Privileged roles can be given again once your account has been in the server for ${hours(newMemberMs)} hours. If you have questions, please contact the ${server} staff.`,
	botRemoved: (server: string, botId: string, newMemberMs: number) =>
		`Hi! As a security measure, the bot <@${botId}> you added to the ${server} Discord was removed automatically because your account joined the server less than ${hours(newMemberMs)} hours ago. Once your account has been in the server for ${hours(newMemberMs)} hours, it can be added again. If you have questions, please contact the ${server} staff.`,
	massAction: (server: string, count: number, label: string, seconds: number) =>
		`Hi! As a security measure, your roles on the ${server} Discord were removed automatically because your account made ${count} ${label} within ${seconds} seconds, which matches the pattern of a server attack. If this was legitimate work, please contact the server owner to have your roles restored.`,
};

// Per-user timestamps for one action type, trimmed to the window on every push
class RateWindow {
	private readonly byUser = new Map<string, number[]>();

	constructor(private readonly windowMs: number) {}

	push(userId: string, at: number): number {
		const times = (this.byUser.get(userId) ?? []).filter((t) => at - t < this.windowMs);
		times.push(at);
		this.byUser.set(userId, times);
		return times.length;
	}
}

function addedRoles(entry: AuditEntry): Array<{ id: string; name: string }> {
	return entry.changes
		.filter((c) => c.key === '$add' && Array.isArray(c.new))
		.flatMap((c) => c.new as Array<{ id: string; name: string }>);
}

export class Policy {
	private readonly selfId: string;
	private readonly serverName: string;
	private readonly newMemberMs: number;
	private readonly rateLimits: Partial<Record<AuditLogEvent, RateLimit>>;
	private readonly windows = new Map<AuditLogEvent, RateWindow>();

	constructor({ selfId, serverName, newMemberMs = DEFAULT_NEW_MEMBER_MS, rateLimits = DEFAULT_RATE_LIMITS }: PolicyOptions) {
		this.selfId = selfId;
		this.serverName = serverName;
		this.newMemberMs = newMemberMs;
		this.rateLimits = rateLimits;
		for (const [action, limit] of Object.entries(rateLimits)) {
			this.windows.set(Number(action) as AuditLogEvent, new RateWindow(limit.windowMs));
		}
	}

	private isNewMember(userId: string, at: number, lookup: Lookup): boolean {
		const joinedAt = lookup.joinedAt(userId);
		return joinedAt != null && at - joinedAt < this.newMemberMs;
	}

	evaluate(entry: AuditEntry, lookup: Lookup): Finding[] {
		const findings: Finding[] = [];
		const { executorId, targetId, createdTimestamp: at } = entry;
		// Everyone is covered, the server owner included. Members ranked above the bot are
		// effectively exempt only because Discord won't let the bot act on them.
		if (!executorId || executorId === this.selfId) {
			return findings;
		}

		// 1. A bot added by a member who joined recently
		if (entry.action === AuditLogEvent.BotAdd && targetId && this.isNewMember(executorId, at, lookup)) {
			findings.push({
				rule: 'new-member-bot',
				summary: `<@${executorId}> joined less than ${hours(this.newMemberMs)}h ago and added bot <@${targetId}>`,
				actions: [{ type: 'kickBot', userId: targetId }],
				notify: { userId: executorId, message: messages.botRemoved(this.serverName, targetId, this.newMemberMs) },
			});
		}

		// 2. A dangerous role given to a member who joined recently
		if (entry.action === AuditLogEvent.MemberRoleUpdate && targetId && this.isNewMember(targetId, at, lookup)) {
			const dangerous = addedRoles(entry).filter((r) => {
				const permissions = lookup.rolePermissions(r.id);
				return permissions != null && isDangerous(permissions);
			});
			if (dangerous.length) {
				const roleNames = dangerous.map((r) => r.name).join(', ');
				findings.push({
					rule: 'new-member-privileged-role',
					summary: `<@${executorId}> gave <@${targetId}> ${roleNames}, but they joined less than ${hours(this.newMemberMs)}h ago`,
					actions: [{ type: 'removeRoles', userId: targetId, roleIds: dangerous.map((r) => r.id) }],
					notify: { userId: targetId, message: messages.privilegedRole(this.serverName, roleNames, this.newMemberMs) },
				});
			}
		}

		// 3. Mass destructive actions
		const limit = this.rateLimits[entry.action];
		const window = this.windows.get(entry.action);
		if (limit && window) {
			const count = window.push(executorId, at);
			if (count >= limit.limit) {
				const bot = lookup.isBot(executorId);
				findings.push({
					rule: 'mass-action',
					summary: `<@${executorId}> made ${count} ${limit.label} in ${limit.windowMs / 1000}s`,
					actions: [{ type: bot ? 'banBot' : 'quarantine', userId: executorId }],
					notify: bot ? undefined : { userId: executorId, message: messages.massAction(this.serverName, count, limit.label, limit.windowMs / 1000) },
				});
			}
		}

		return findings;
	}
}
