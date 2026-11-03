import test from 'node:test';
import assert from 'node:assert/strict';
import { AuditLogEvent, PermissionFlagsBits } from 'discord.js';
import { DEFAULT_RATE_LIMITS, Policy, type AuditEntry, type Lookup } from './policy.js';

// IDs and timings from the real 2026-10-31 nuke of a 24,000-member server
const OWNER = '71388029540900864';
const SELF = '1209585921910120519';
const COMPROMISED = '162257040058744832';
const STAFF = '98867132644720640';
const ESTABLISHED = '120347427877158913';
const ATTACKER = '1061404584767148154';
const NUKE_BOT = '1559002351073763479';
const TICKET_BOT = '575252669443211264';
const ADMIN_ROLE = { id: '1502037390364246179', name: 'Team Lead' };
const DEVELOPER = { id: '1164097204114440223', name: 'Developer' };
const HARMLESS = { id: '1194761105948549271', name: 'NA' };

const t = (iso: string) => Date.parse(iso);
const HOUR = 3_600_000;
const PERMISSIONS: Record<string, bigint> = {
	[ADMIN_ROLE.id]: PermissionFlagsBits.Administrator,
	[DEVELOPER.id]: PermissionFlagsBits.ManageChannels | PermissionFlagsBits.KickMembers,
	[HARMLESS.id]: 0n,
};

function lookup({ joined = {}, bots = [] }: { joined?: Record<string, number>; bots?: string[] } = {}): Lookup {
	return {
		isBot: (id) => bots.includes(id),
		rolePermissions: (id) => PERMISSIONS[id] ?? null,
		joinedAt: (id) => joined[id] ?? t('2024-01-01T00:00:00Z'),
	};
}

const DELETE_LIMIT = DEFAULT_RATE_LIMITS[AuditLogEvent.ChannelDelete]!.limit;
const upTo = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

const policy = () => new Policy({ selfId: SELF, serverName: 'Side 7' });
const grant = (executorId: string, targetId: string, roles: Array<{ id: string; name: string }>, at: number): AuditEntry =>
	({ action: AuditLogEvent.MemberRoleUpdate, executorId, targetId, createdTimestamp: at, changes: [{ key: '$add', new: roles }] });
const botAdd = (executorId: string, botId: string, at: number): AuditEntry =>
	({ action: AuditLogEvent.BotAdd, executorId, targetId: botId, createdTimestamp: at, changes: [] });
const channelDelete = (executorId: string, i: number, at: number): AuditEntry =>
	({ action: AuditLogEvent.ChannelDelete, executorId, targetId: String(i), createdTimestamp: at, changes: [] });

test('replaying the real nuke: both grants are undone and the bot is removed before it can delete anything', () => {
	const p = policy();
	const l = lookup({ joined: { [ATTACKER]: t('2026-10-31T02:06:56Z') }, bots: [NUKE_BOT] });

	const admin = p.evaluate(grant(COMPROMISED, ATTACKER, [ADMIN_ROLE], t('2026-10-31T02:07:21Z')), l);
	assert.deepEqual(admin.map((f) => f.rule), ['new-member-privileged-role']);
	assert.deepEqual(admin[0]!.actions, [{ type: 'removeRoles', userId: ATTACKER, roleIds: [ADMIN_ROLE.id] }]);

	const developer = p.evaluate(grant(COMPROMISED, ATTACKER, [DEVELOPER], t('2026-10-31T02:07:23Z')), l);
	assert.deepEqual(developer[0]!.actions, [{ type: 'removeRoles', userId: ATTACKER, roleIds: [DEVELOPER.id] }]);

	const bot = p.evaluate(botAdd(ATTACKER, NUKE_BOT, t('2026-10-31T02:08:08Z')), l);
	assert.deepEqual(bot[0]!.actions, [{ type: 'kickBot', userId: NUKE_BOT }]);

	// Had it got that far, the limit would have tripped within its first tenth of a second
	const start = t('2026-10-31T02:08:16Z');
	const tripped = upTo(DELETE_LIMIT).map((i) => p.evaluate(channelDelete(NUKE_BOT, i, start + i * 13), l).length);
	assert.deepEqual(tripped, [...Array(DELETE_LIMIT - 1).fill(0), 1]);
});

test('staff can still give privileged roles to established members', () => {
	assert.deepEqual(policy().evaluate(grant(STAFF, ESTABLISHED, [DEVELOPER], t('2026-10-08T21:40:02Z')), lookup()), []);
});

test('only the new member loses the privileged role; the grantor is not acted on', () => {
	const l = lookup({ joined: { [ATTACKER]: t('2026-10-31T00:00:00Z') } });
	const findings = policy().evaluate(grant(STAFF, ATTACKER, [DEVELOPER, HARMLESS], t('2026-10-31T10:00:00Z')), l);
	assert.deepEqual(findings.flatMap((f) => f.actions), [{ type: 'removeRoles', userId: ATTACKER, roleIds: [DEVELOPER.id] }]);
});

test('the new-member window is 24 hours by default and configurable', () => {
	const joined = t('2026-10-30T00:00:00Z');
	const l = lookup({ joined: { [ATTACKER]: joined } });
	assert.equal(policy().evaluate(grant(STAFF, ATTACKER, [DEVELOPER], joined + 23 * HOUR), l).length, 1);
	assert.equal(policy().evaluate(grant(STAFF, ATTACKER, [DEVELOPER], joined + 24 * HOUR), l).length, 0);
	const strict = new Policy({ selfId: SELF, serverName: 'Side 7', newMemberMs: 72 * HOUR });
	assert.equal(strict.evaluate(grant(STAFF, ATTACKER, [DEVELOPER], joined + 48 * HOUR), l).length, 1);
});

test('harmless roles given to new members are ignored', () => {
	const l = lookup({ joined: { [ATTACKER]: t('2026-10-31T00:00:00Z') } });
	assert.deepEqual(policy().evaluate(grant(STAFF, ATTACKER, [HARMLESS], t('2026-10-31T01:00:00Z')), l), []);
});

test('a bot added by any new member is removed, whatever their roles; established members can add bots', () => {
	const joined = t('2026-10-31T02:06:56Z');
	const l = lookup({ joined: { [ATTACKER]: joined }, bots: [NUKE_BOT] });
	const findings = policy().evaluate(botAdd(ATTACKER, NUKE_BOT, joined + 23 * HOUR), l);
	assert.deepEqual(findings[0]!.actions, [{ type: 'kickBot', userId: NUKE_BOT }]);
	assert.equal(findings[0]!.notify!.userId, ATTACKER);
	assert.deepEqual(policy().evaluate(botAdd(ATTACKER, NUKE_BOT, joined + 24 * HOUR), l), []);
	assert.deepEqual(policy().evaluate(botAdd(STAFF, NUKE_BOT, joined), l), []);
});

test('the server owner is covered like everyone else', () => {
	const p = policy();
	const l = lookup({ joined: { [ATTACKER]: t('2026-10-31T00:00:00Z') } });
	assert.deepEqual(p.evaluate(grant(OWNER, ATTACKER, [ADMIN_ROLE], t('2026-10-31T01:00:00Z')), l)[0]!.actions,
		[{ type: 'removeRoles', userId: ATTACKER, roleIds: [ADMIN_ROLE.id] }]);
	const owner = upTo(DELETE_LIMIT).map((i) => p.evaluate(channelDelete(OWNER, i, i), l)).at(-1)!;
	assert.deepEqual(owner[0]!.actions, [{ type: 'quarantine', userId: OWNER }]);
});

test("the bot's own actions are never evaluated", () => {
	const p = policy();
	for (let i = 0; i < 50; i++) {
		assert.deepEqual(p.evaluate(channelDelete(SELF, i, i), lookup()), []);
	}
});

test("the ticket bot's busiest real minute (4 channel deletions) stays under the limit", () => {
	const p = policy();
	const l = lookup({ bots: [TICKET_BOT] });
	assert.deepEqual([0, 15_000, 30_000, 45_000].flatMap((at, i) => p.evaluate(channelDelete(TICKET_BOT, i, at), l)), []);
});

test('actions spread wider than the window do not accumulate', () => {
	const p = policy();
	const { limit, windowMs } = DEFAULT_RATE_LIMITS[AuditLogEvent.ChannelDelete]!;
	const findings = Array.from({ length: limit * 3 }, (_, i) => p.evaluate(channelDelete(STAFF, i, i * (windowMs / (limit - 1) + 1)), lookup()));
	assert.deepEqual(findings.flat(), []);
});

test('a mass-acting bot is banned without a DM; a mass-acting member is quarantined and told why', () => {
	const run = (executorId: string, bots: string[]) => {
		const p = policy();
		return upTo(DELETE_LIMIT).map((i) => p.evaluate(channelDelete(executorId, i, i), lookup({ bots }))).at(-1)![0]!;
	};
	const bot = run(NUKE_BOT, [NUKE_BOT]);
	assert.deepEqual(bot.actions, [{ type: 'banBot', userId: NUKE_BOT }]);
	assert.equal(bot.notify, undefined);

	const member = run(COMPROMISED, []);
	assert.deepEqual(member.actions, [{ type: 'quarantine', userId: COMPROMISED }]);
	assert.match(member.notify!.message, new RegExp(`security measure, your roles on the Side 7 Discord were removed .* ${DELETE_LIMIT} channel deletions within 60 seconds`));
});

test('members are told why their privileged role or bot was removed', () => {
	const l = lookup({ joined: { [ATTACKER]: t('2026-10-31T00:00:00Z') }, bots: [NUKE_BOT] });
	const role = policy().evaluate(grant(STAFF, ATTACKER, [DEVELOPER], t('2026-10-31T01:00:00Z')), l)[0]!;
	assert.match(role.notify!.message, /security measure, your Developer role was removed .* less than 24 hours ago/);
	const bot = policy().evaluate(botAdd(ATTACKER, NUKE_BOT, t('2026-10-31T01:00:00Z')), l)[0]!;
	assert.match(bot.notify!.message, new RegExp(`security measure, the bot <@${NUKE_BOT}> you added`));
});
