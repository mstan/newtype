import { AuditLogEvent } from 'discord.js';
import { DEFAULT_NEW_ACCOUNT_MS, DEFAULT_NEW_MEMBER_MS, DEFAULT_RATE_LIMITS, type RateLimit } from './policy.js';
import type { Mode } from './newtype.js';

export interface Config {
	token: string;
	mode: Mode;
	logChannels: Map<string, string>;
	newAccountMs: number;
	newMemberMs: number;
	rateLimits: Partial<Record<AuditLogEvent, RateLimit>>;
}

const SNOWFLAKE = /^\d{17,20}$/;

export function loadConfig(env: NodeJS.ProcessEnv): Config {
	const token = env.DISCORD_TOKEN?.trim();
	if (!token) {
		throw new Error('DISCORD_TOKEN is not set (see .env.example)');
	}

	const mode = (env.NEWTYPE_MODE?.trim() || 'report') as Mode;
	if (mode !== 'report' && mode !== 'enforce') {
		throw new Error(`NEWTYPE_MODE must be "report" or "enforce", not "${env.NEWTYPE_MODE}"`);
	}

	const logChannels = new Map<string, string>();
	for (const pair of (env.NEWTYPE_LOG_CHANNELS ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
		const [guildId, channelId] = pair.split(':').map((s) => s.trim());
		if (!guildId || !channelId || !SNOWFLAKE.test(guildId) || !SNOWFLAKE.test(channelId)) {
			throw new Error(`NEWTYPE_LOG_CHANNELS entry "${pair}" must be guildId:channelId`);
		}
		logChannels.set(guildId, channelId);
	}

	return {
		token,
		mode,
		logChannels,
		newAccountMs: positive(env, 'NEWTYPE_NEW_ACCOUNT_DAYS', DEFAULT_NEW_ACCOUNT_MS / 86_400_000) * 86_400_000,
		newMemberMs: positive(env, 'NEWTYPE_NEW_MEMBER_HOURS', DEFAULT_NEW_MEMBER_MS / 3_600_000) * 3_600_000,
		rateLimits: parseRateLimits(env.NEWTYPE_RATE_LIMITS),
	};
}

function positive(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
	const value = Number(env[name]?.trim() || fallback);
	if (!Number.isFinite(value) || value <= 0) {
		throw new Error(`${name} must be a positive number, not "${env[name]}"`);
	}
	return value;
}

// JSON keyed by audit log action name, e.g. {"ChannelDelete":{"limit":4,"windowSeconds":60}}.
// Actions left out keep their defaults.
export function parseRateLimits(json: string | undefined): Partial<Record<AuditLogEvent, RateLimit>> {
	const limits = { ...DEFAULT_RATE_LIMITS };
	if (!json?.trim()) {
		return limits;
	}

	let parsed: Record<string, { limit?: number; windowSeconds?: number }>;
	try {
		parsed = JSON.parse(json);
	} catch (error) {
		throw new Error(`NEWTYPE_RATE_LIMITS is not valid JSON: ${(error as Error).message}`);
	}

	for (const [name, value] of Object.entries(parsed)) {
		const action = AuditLogEvent[name as keyof typeof AuditLogEvent];
		const current = action === undefined ? undefined : limits[action];
		if (action === undefined || !current) {
			throw new Error(`NEWTYPE_RATE_LIMITS: "${name}" is not one of ${Object.keys(DEFAULT_RATE_LIMITS).map((a) => AuditLogEvent[Number(a)]).join(', ')}`);
		}
		const limit = value.limit ?? current.limit;
		const windowMs = (value.windowSeconds ?? current.windowMs / 1000) * 1000;
		if (!(Number.isInteger(limit) && limit > 0) || !(windowMs > 0)) {
			throw new Error(`NEWTYPE_RATE_LIMITS: "${name}" needs a positive integer limit and a positive windowSeconds`);
		}
		limits[action] = { ...current, limit, windowMs };
	}
	return limits;
}
