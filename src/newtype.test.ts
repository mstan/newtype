import test from 'node:test';
import assert from 'node:assert/strict';
import { AuditLogEvent, Collection, PermissionFlagsBits, type Guild } from 'discord.js';
import { Newtype, type Mode } from './newtype.js';
import { DEFAULT_RATE_LIMITS, type AuditEntry } from './policy.js';

const DELETE_LIMIT = DEFAULT_RATE_LIMITS[AuditLogEvent.ChannelDelete]!.limit;

const GUILD = '1164093403265507360';
const LOG = '1565928230005772390';
const OWNER = '71388029540900864';
const SELF = '1209585921910120519';
const STAFF = '98867132644720640';
const ATTACKER = '1061404584767148154';
const NUKE_BOT = '1559002351073763479';
const ADMIN = { id: '1502037390364246179', name: 'Team Lead', permissions: PermissionFlagsBits.Administrator };
const NOW = Date.parse('2026-10-31T02:08:08Z');

interface FakeMember { id: string; bot?: boolean; joined: number; roles?: Array<typeof ADMIN & { editable?: boolean }>; rank?: 'below' | 'above' }

// A server with just enough of discord.js's shape for Newtype, recording everything it does
function fakeServer(memberList: FakeMember[]) {
	const record = { log: [] as unknown[], ownerDms: [] as unknown[], dms: [] as Array<[string, string]>, bans: [] as string[], kicks: [] as string[], removed: [] as string[] };
	const users = new Collection<string, { id: string; bot: boolean; tag: string }>();
	const members = new Collection<string, unknown>();
	const roles = new Collection<string, unknown>();
	for (const m of memberList) {
		users.set(m.id, { id: m.id, bot: !!m.bot, tag: m.id });
		const memberRoles = new Collection<string, unknown>();
		for (const r of m.roles ?? []) {
			const role = { id: r.id, name: r.name, managed: false, editable: r.editable ?? true, permissions: { bitfield: r.permissions } };
			memberRoles.set(r.id, role);
			roles.set(r.id, role);
		}
		const above = m.rank === 'above';
		members.set(m.id, {
			id: m.id, user: users.get(m.id), joinedTimestamp: m.joined, kickable: !above, bannable: !above,
			kick: async () => { record.kicks.push(m.id); },
			roles: { cache: memberRoles, remove: async (ids: string[]) => { record.removed.push(...ids); } },
		});
	}
	const guild = {
		id: GUILD, name: 'Side 7', ownerId: OWNER,
		client: { user: { id: SELF }, users: { cache: users, fetch: async (id: string) => ({ send: async (m: string) => { record.dms.push([id, m]); } }) } },
		roles: { cache: roles },
		members: { cache: members, fetch: async (id: string) => members.get(id) ?? Promise.reject(new Error('Unknown Member')) },
		bans: { create: async (id: string) => { record.bans.push(id); } },
		channels: { cache: new Collection([[LOG, { isTextBased: () => true, send: async (m: unknown) => { record.log.push(m); } }]]) },
		fetchOwner: async () => ({ send: async (m: unknown) => { record.ownerDms.push(m); } }),
	} as unknown as Guild;
	return { guild, record };
}

const newtype = (mode: Mode) => new Newtype({ mode, logChannels: new Map([[GUILD, LOG]]), log: () => undefined });
const titles = (log: unknown[]) => log.map((m) => (m as { embeds: Array<{ data: { title: string } }> }).embeds[0]!.data.title);
const fields = (m: unknown) => (m as { embeds: Array<{ data: { fields: Array<{ name: string; value: string }> } }> }).embeds[0]!.data.fields;
const botAdd = (executorId: string): AuditEntry => ({ action: AuditLogEvent.BotAdd, executorId, targetId: NUKE_BOT, createdTimestamp: NOW, changes: [] });
const grant = (targetId: string): AuditEntry => ({ action: AuditLogEvent.MemberRoleUpdate, executorId: STAFF, targetId, createdTimestamp: NOW, changes: [{ key: '$add', new: [ADMIN] }] });
const deletes = async (n: Newtype, guild: Guild, executorId: string, count: number) => {
	for (let i = 0; i < count; i++) {
		await n.handle({ action: AuditLogEvent.ChannelDelete, executorId, targetId: String(i), createdTimestamp: NOW + i * 13, changes: [] }, guild);
	}
};

test('every bot add is logged, whoever added it, in either mode', async () => {
	for (const mode of ['report', 'enforce'] as const) {
		for (const adder of [OWNER, STAFF]) {
			const { guild, record } = fakeServer([{ id: adder, joined: 0 }, { id: NUKE_BOT, bot: true, joined: NOW }]);
			await newtype(mode).handle(botAdd(adder), guild);
			assert.deepEqual(titles(record.log), ['🤖 Bot added'], `${mode} / ${adder}`);
		}
	}
});

test('enforce: a bot added by a brand-new member is removed and the member is told why', async () => {
	const { guild, record } = fakeServer([{ id: ATTACKER, joined: NOW - 72_000 }, { id: NUKE_BOT, bot: true, joined: NOW }]);
	await newtype('enforce').handle(botAdd(ATTACKER), guild);
	assert.deepEqual(record.kicks, [NUKE_BOT]);
	assert.deepEqual(titles(record.log), ['🤖 Bot added', '🛡️ Newtype: new-member-bot']);
	assert.equal(record.dms.length, 1);
	assert.equal(record.dms[0]![0], ATTACKER);
});

test('report: nothing is done and nobody is DMed, but the alert shows what would have been sent', async () => {
	const { guild, record } = fakeServer([{ id: ATTACKER, joined: NOW - 25_000, roles: [ADMIN] }]);
	await newtype('report').handle(grant(ATTACKER), guild);
	assert.deepEqual([record.removed, record.dms, record.bans, record.kicks], [[], [], [], []]);
	assert.deepEqual(titles(record.log), ['🔶 Newtype (report only): new-member-privileged-role']);
	assert.equal(fields(record.log[0])[1]!.name, `Would DM <@${ATTACKER}>`);
	assert.equal(record.ownerDms.length, 1);
});

test('enforce: a privileged role given to a brand-new member is removed', async () => {
	const { guild, record } = fakeServer([{ id: ATTACKER, joined: NOW - 25_000, roles: [ADMIN] }]);
	await newtype('enforce').handle(grant(ATTACKER), guild);
	assert.deepEqual(record.removed, [ADMIN.id]);
	assert.equal(record.dms[0]![0], ATTACKER);
});

test('enforce: a member ranked above Newtype keeps their roles, and is not falsely told otherwise', async () => {
	const { guild, record } = fakeServer([{ id: STAFF, joined: 0, roles: [{ ...ADMIN, editable: false }] }]);
	await deletes(newtype('enforce'), guild, STAFF, DELETE_LIMIT);
	assert.deepEqual(record.removed, []);
	assert.deepEqual(record.dms, []);
	const taken = fields(record.log[0]);
	assert.match(taken[0]!.value, /could NOT remove Team Lead: ranked above Newtype/);
	assert.match(taken[1]!.name, /No DM sent/);
});

test('enforce: the owner is covered, but Discord forbids acting on them, so it is reported instead', async () => {
	const { guild, record } = fakeServer([{ id: OWNER, joined: 0, roles: [ADMIN] }]);
	await deletes(newtype('enforce'), guild, OWNER, DELETE_LIMIT);
	assert.deepEqual([record.removed, record.dms], [[], []]);
	assert.match(fields(record.log[0])[0]!.value, /Discord does not allow any bot to act on the server owner/);
});

test('enforce: a mass-deleting bot is banned once, with one alert, however many deletions follow', async () => {
	const { guild, record } = fakeServer([{ id: NUKE_BOT, bot: true, joined: NOW - 8_000 }]);
	await deletes(newtype('enforce'), guild, NUKE_BOT, 40);
	assert.deepEqual(record.bans, [NUKE_BOT]);
	assert.equal(record.log.length, 1);
	assert.deepEqual(record.dms, []);
});
