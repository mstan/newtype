import test from 'node:test';
import assert from 'node:assert/strict';
import { AuditLogEvent } from 'discord.js';
import { loadConfig, parseRateLimits } from './config.js';
import { DEFAULT_RATE_LIMITS } from './policy.js';

const base = { DISCORD_TOKEN: 'token' };

test('defaults: report mode, 24h, no log channels, default limits', () => {
	const config = loadConfig(base);
	assert.equal(config.mode, 'report');
	assert.equal(config.newMemberMs, 24 * 3_600_000);
	assert.equal(config.logChannels.size, 0);
	assert.deepEqual(config.rateLimits, DEFAULT_RATE_LIMITS);
});

test('log channels are read per server', () => {
	const config = loadConfig({ ...base, NEWTYPE_LOG_CHANNELS: '1164093403265507360:1565928230005772390, 1428565606155948123:1428565606155948124' });
	assert.equal(config.logChannels.get('1164093403265507360'), '1565928230005772390');
	assert.equal(config.logChannels.size, 2);
});

test('bad settings fail loudly at startup', () => {
	assert.throws(() => loadConfig({}), /DISCORD_TOKEN/);
	assert.throws(() => loadConfig({ ...base, NEWTYPE_MODE: 'on' }), /NEWTYPE_MODE/);
	assert.throws(() => loadConfig({ ...base, NEWTYPE_LOG_CHANNELS: 'mod-log' }), /guildId:channelId/);
	assert.throws(() => loadConfig({ ...base, NEWTYPE_NEW_MEMBER_HOURS: '-1' }), /NEWTYPE_NEW_MEMBER_HOURS/);
	assert.throws(() => parseRateLimits('{'), /not valid JSON/);
	assert.throws(() => parseRateLimits('{"MessageDelete":{"limit":3}}'), /not one of/);
	assert.throws(() => parseRateLimits('{"ChannelDelete":{"limit":0}}'), /positive integer/);
});

test('rate limit overrides merge over the defaults', () => {
	const limits = parseRateLimits('{"ChannelDelete":{"limit":6,"windowSeconds":30}}');
	assert.deepEqual(limits[AuditLogEvent.ChannelDelete], { limit: 6, windowMs: 30_000, label: 'channel deletions' });
	assert.deepEqual(limits[AuditLogEvent.RoleDelete], DEFAULT_RATE_LIMITS[AuditLogEvent.RoleDelete]);
});
