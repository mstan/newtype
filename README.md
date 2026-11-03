# Newtype

**A Discord anti-nuke bot that stops the attack before the damage.**

In Gundam, a Newtype senses the attack before it lands. Discord can't, so this bot does: it watches your server's audit log live and cuts off the steps a nuke needs, a brand-new account getting privileged roles, that account adding a bot, and mass destruction, before your channels are gone.

MIT licensed. Free for every community.

---

## What happened to us

Side 7 is a fan-run community of nearly 24,000 members that keeps a shut-down game alive.

At 7:05 PM Pacific on October 30, 2026, a co-founding staff member's Discord account was compromised. In **2 minutes 20 seconds**, the attacker used it to give Administrator to an account that had joined **25 seconds earlier**. That account added a nuke bot **47 seconds later**. The bot deleted **75 channels in its first second** and all **204 within 11 seconds**. It then created 200 spam channels and 36 spam roles and renamed the server. About three years of community history went with it: every channel, message, forum post, pin and attachment. Discord offers no way to restore any of it.

### What we were already doing
- **Every protection Discord offers was switched on.** Two-factor authentication for moderators, AutoMod and Security Actions were all enabled.
- **Staff were online and acted fast.** They removed the bot by hand 4 minutes 24 seconds after it arrived and restored the server name at 5 minutes 31 seconds.

### What we had to do
- **Watch it finish before we could act.** The destruction was over in 11 seconds. No response by a person, however fast, could have saved a single channel.
- **Clean up with a privileged bot and an AI assistant.** Discord gives server owners no bulk tools. Banning the attackers, clearing the 130 spam channels and 36 roles left behind, and preserving the forensic record all had to go through our bot's privileged access token, with an AI assistant identifying and carrying out each step. Running a privileged bot that way is a real risk we would never choose outside an emergency. Discord left us no alternative.
- **Build the protection ourselves.** Within 48 hours, our bot had safeguards Discord fails to provide.

### How Discord allows this to happen

None of Discord's protections fired. They're designed for spam and join raids, not a compromised account handing power to a bot. The gaps are basic safety settings that simply don't exist:

1. **No way to restrict who can add bots.** Administrator includes adding bots that also have Administrator. Discord has no separate permission for it, no approval step and no owner-only option.
2. **No warning and no optional waiting period.** An account that joined 25 seconds ago can be given Administrator and use it immediately. Discord shows no warning, and there's no setting to require a minimum time in the server before anyone can hold a privileged role.
3. **No limit on destructive speed.** Discord rate-limits per channel, so deleting 200 different channels runs at full speed: 75 in one second.
4. **No recycle bin.** Deleted channels, messages, forum posts and attachments are gone permanently. Even a perfect backup of the layout couldn't bring back the conversations.
5. **Everything on Discord is at Discord's mercy.** Files, guides and history kept on Discord are one compromised account away from vanishing.
6. **An audit log built for blame, not recovery.** It doesn't record which category a channel was in or its order, and entries vanish after 45 days.
7. **No alert to the owner** when a bot is added or Administrator is granted.

### How Discord failed to follow up

Afterwards, I opened a ticket with Discord. We're a community of nearly 24,000 members, and we lost three years of history to an attack that went straight through Discord's own permission model. I never spoke to a person. I got a canned macro response that didn't even address what had happened, and then the ticket was closed with no follow-up. Despite our size and how much we lost, Discord made it clear they don't take this seriously.

### Why Newtype

Discord fails to prevent this, so I've built this in response and am making it available to everyone so that this hopefully never has to happen to anyone else.

Among the open-source anti-nuke bots we found, the common approach is an allowlist that bans unapproved bot adds and reacts to mass deletion. That approach breaks normal staff work. It also starts too late: by the time mass deletion is detected, 75 channels are gone. Newtype goes after the steps that come before the damage:

- **It checks how recently someone joined, not an allowlist.** An account less than 24 hours old can't keep a privileged role or add a bot. Staff can still promote established members normally.
- **It breaks the escalation chain.** Our attack would have been stopped at the role grant, 47 seconds before the bot existed.
- **Its speed limits are tuned to your server.** `npm run calibrate` reads your own audit history and suggests limits.
- **It logs every bot add**, whoever does it.
- **It explains itself.** Affected members get a DM saying it's a security measure. The log channel and the owner get an alert each time.
- **It can watch before it acts.** Report mode shows exactly what it would have done before you let it act.

---

## What Newtype does

| Rule | Trigger | Action | DM to |
|---|---|---|---|
| New member adds a bot | An account that joined less than 24 hours ago adds a bot | Remove the bot | The member who added it |
| New member gets a privileged role | A role with Administrator, Manage Server, Manage Roles, Manage Channels, Manage Webhooks, Ban or Kick goes to an account that joined less than 24 hours ago | Remove that role only; whoever gave it is untouched | The member who received it |
| Mass actions | Above the limits below, in one minute | Ban a bot, or remove every role from a member | The member (bots get no DM) |
| Every bot add | Any bot is added, by anyone | Notice in the log channel | |

Default limits per minute (calibrated on a 24,000-member server's normal six weeks; the nuke ran at 75 deletions a second):

| Action | Limit |
|---|---|
| Channel deletions | 5 |
| Channel creations | 5 |
| Role deletions | 3 |
| Role creations | 3 |
| Bans | 5 |
| Kicks | 5 |
| Webhook creations | 3 |

Each alert goes to your log channel and to the server owner by DM. The same offender and rule alert at most once a minute, so a nuke can't flood you.

## Who it covers

Newtype applies its rules to everyone, **the server owner included**. Owner accounts get compromised too, and Newtype will remove bots the owner's account adds, revoke privileged roles it hands out, and ban bots it uses for mass actions. Discord never lets a bot strip the owner's own powers.

To exempt a member, place their highest role **above Newtype's role**. Discord stops any bot from acting on members ranked above it. Do this sparingly: every exempt account is one whose compromise Newtype can't contain. At startup, Newtype lists every privileged role ranked above it so you can see exactly who is exempt.

## Setup

1. **Create the bot.** At the [Discord Developer Portal](https://discord.com/developers/applications), create an application, add a bot, and copy its token. Newtype needs **no privileged intents**.
2. **Invite it** with the permissions it uses (View Audit Log, Manage Roles, Kick, Ban, plus View Channels, Send Messages and Embed Links for alerts), replacing `YOUR_CLIENT_ID`:
   ```
   https://discord.com/oauth2/authorize?client_id=YOUR_CLIENT_ID&scope=bot&permissions=268455046
   ```
3. **Rank it.** In Server Settings → Roles, drag Newtype's role **above every role you want it to protect against**, ideally directly under the owner. It can't act on anyone ranked above it.
4. **Configure and run** (Node.js 22.9 or later):
   ```sh
   git clone https://github.com/mstan/newtype.git && cd newtype
   cp .env.example .env    # add your token and log channel
   npm ci && npm run build
   npm start
   ```
   It starts in **report mode**. Watch the alerts for a few days.
5. **Calibrate** to your server's normal activity:
   ```sh
   npm run calibrate -- <serverId>
   ```
   It prints each action's busiest minute and a suggested `NEWTYPE_RATE_LIMITS` line. Use `--before <time>` to leave out an incident or an unusual rebuild.
6. **Enforce.** Set `NEWTYPE_MODE=enforce` and restart.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `DISCORD_TOKEN` | required | Bot token |
| `NEWTYPE_MODE` | `report` | `report` alerts only; `enforce` acts |
| `NEWTYPE_LOG_CHANNELS` | none | `serverId:channelId` pairs, comma-separated. Without one, alerts go to the owner by DM |
| `NEWTYPE_NEW_MEMBER_HOURS` | `24` | How long after joining a member counts as new |
| `NEWTYPE_RATE_LIMITS` | defaults above | JSON from `npm run calibrate`, e.g. `{"ChannelDelete":{"limit":5,"windowSeconds":60}}` |

## What it can't do

- **It can't undo a deletion.** Discord has no recycle bin. Newtype works by stopping the attack before deletions start; the mass-action limit is the backstop, and even it trips within the first fraction of a second.
- **It reacts to the audit log.** Discord records an action and then tells Newtype, so the first actions of an attack always happen.
- **It can't act on anyone ranked above it**, or on the server owner.
- **Speed limits reset when it restarts.** They're counted in memory.

## Development

```sh
npm test    # builds, then runs the tests, including a replay of the real attack
```

## License

[MIT](LICENSE)
