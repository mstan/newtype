// Reads a server's audit log (Discord keeps 45 days) and suggests NEWTYPE_RATE_LIMITS from
// how fast people and bots normally act there.
//
//   npm run calibrate -- <guildId> [--before 2026-10-30T00:00:00Z]
//
// --before ignores everything after that time, e.g. an incident or an unusual rebuild.
import { REST, Routes, AuditLogEvent, type APIAuditLog, type APIUser } from 'discord.js';
import { DEFAULT_RATE_LIMITS } from './policy.js';

const [guildId, ...rest] = process.argv.slice(2);
const beforeIndex = rest.indexOf('--before');
const before = beforeIndex >= 0 ? Date.parse(rest[beforeIndex + 1] ?? '') : Infinity;
if (!guildId || !/^\d{17,20}$/.test(guildId) || Number.isNaN(before)) {
	console.error('Usage: npm run calibrate -- <guildId> [--before <ISO time>]');
	process.exit(1);
}
const token = process.env.DISCORD_TOKEN;
if (!token) {
	console.error('DISCORD_TOKEN is not set');
	process.exit(1);
}

const api = new REST().setToken(token);
const self = (await api.get(Routes.user('@me'))) as APIUser;
const snowflakeTime = (id: string) => Number(BigInt(id) >> 22n) + 1420070400000;

// Every entry Discord still has, newest first
const entries: APIAuditLog['audit_log_entries'] = [];
const users = new Map<string, APIUser>();
for (let cursor: string | undefined; ;) {
	const query = new URLSearchParams({ limit: '100', ...(cursor ? { before: cursor } : {}) });
	const page = (await api.get(Routes.guildAuditLog(guildId), { query })) as APIAuditLog;
	page.users.forEach((u) => users.set(u.id, u));
	if (!page.audit_log_entries.length) break;
	entries.push(...page.audit_log_entries);
	cursor = page.audit_log_entries.at(-1)!.id;
}
const kept = entries.filter((e) => e.user_id && e.user_id !== self.id && snowflakeTime(e.id) < before);
const oldest = entries.length ? new Date(snowflakeTime(entries.at(-1)!.id)).toISOString() : 'n/a';
console.log(`Read ${entries.length} audit entries back to ${oldest}; ${kept.length} used (excluding Newtype${Number.isFinite(before) ? ' and anything after --before' : ''}).\n`);

const suggestion: Record<string, { limit: number; windowSeconds: number }> = {};
for (const [actionKey, limit] of Object.entries(DEFAULT_RATE_LIMITS)) {
	const action = Number(actionKey) as AuditLogEvent;
	const byUser = new Map<string, number[]>();
	for (const e of kept.filter((e) => e.action_type === action)) {
		const times = byUser.get(e.user_id!) ?? [];
		times.push(snowflakeTime(e.id));
		byUser.set(e.user_id!, times);
	}

	// Each user's busiest window
	const peaks = [...byUser].map(([userId, times]) => {
		times.sort((a, b) => a - b);
		let peak = 0;
		for (let i = 0, j = 0; i < times.length; i++) {
			while (times[i]! - times[j]! >= limit.windowMs) j++;
			peak = Math.max(peak, i - j + 1);
		}
		return { userId, peak };
	}).sort((a, b) => b.peak - a.peak);

	const top = peaks[0]?.peak ?? 0;
	const suggested = Math.max(top + 1, 3);
	suggestion[AuditLogEvent[action]] = { limit: suggested, windowSeconds: limit.windowMs / 1000 };
	const who = peaks.slice(0, 3).map(({ userId, peak }) => `${users.get(userId)?.username ?? userId} ${peak}`).join(', ') || 'none';
	console.log(`${AuditLogEvent[action].padEnd(14)} busiest ${limit.windowMs / 1000}s: ${who.padEnd(50)} default ${limit.limit}, suggested ${suggested}`);
}

console.log('\nTo use the suggestions, add this line to .env (review it first):');
console.log(`NEWTYPE_RATE_LIMITS=${JSON.stringify(suggestion)}`);
