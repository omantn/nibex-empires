# Nibex: Empires — current design

Updated September 11, 2026. This document supersedes the earlier prototype design. See readme.md for hosting and recovery.

## Purpose

A background strategy game for the Nibex weekend, with secret identities, diplomacy, betrayal and a shared TV finale for the annual cup. Lower check-in pressure is a design goal. More app time earns no extra orders, but reacting to information still matters; this is not a guarantee that every check-in pattern has identical strategic value.

## Cadence and planning

- Default: 180-minute turns, 20 orders per day, two quest deals per day. Host configures these before launch.
- All players receive the daily budget at launch and at Daybreak; it does not accrue per turn. Unspent orders expire at Daybreak.
- Queued expansion routes survive Daybreak and advance one frontier each turn. A plan can extend from owned land or an already queued expansion. Blocked downstream steps wait for the player to cancel or reconnect the route.
- Cancelling current-day plans restores their order slots. Cancelling older plans does not add old slots to today's budget. Pending paid costs are refunded during play.
- Nightfall defaults to 02:00–10:00 server-local time. Orders may be planned at any time; no automatic turns resolve overnight. Heists can be queued by day and resolve only at Daybreak.
- Event turns follow the clock. Only preselected rehearsal mode permits consensus or manual early turns.
- Pauses preserve the remaining time to the next turn, but do not extend the event's end time.

## Map and orders

The hex map scales with player count, using ring spawns, permanent home wards and a resource-rich center. Home wards cannot be conquered. Each empire receives a +1 ore/+1 food stipend per turn; unwarded ore and food tiles produce +1 of their resource.

Orders: expansion (one slot), muster (N ore for N strength, one slot), attack (one food and one slot), move (one slot), raid (one slot), spy (one food and one slot), heist (one food and one slot). Market trades are immediate: five food for one ore, or one ore for five food.

Resolution: production → eligible expansion frontiers → musters → all attack departures → battles → moves → raids → spies → Daybreak heists → quests. Movement destinations must already be owned when queued. Musters can defend immediately, but the amount committed to an attack is limited to unreserved troops present when queued.

All attack departures are removed before any battle is evaluated. Defenders are then snapshotted, so one battle cannot cancel another empire's simultaneous departure. Combat target processing has a canonical order rather than request-arrival order. Independent luck multipliers are 0.8–1.2; defender wins effective ties. Attack support merges with the supported empire if it also marches. Strongest effective coalition fights the defender; losing coalitions are destroyed. Survivor calculations retain the existing raw-difference rule.

Enemy garrisons are visible at borders and through successful spies. Warded garrisons are private. Battle outcomes, not committed troop counts, appear on the public ticker.

## Score and ending

Public points equal unwarded territory (one point, or two in the center) plus a pooled economy score:

`floor((5 × ore + food + 5 × total strength) / 25)`

Pending paid costs remain part of the owner's score until they resolve, preventing a queued muster from lowering the leaderboard or broadcasting that a muster was queued. Market conversions and completed musters preserve value. The ceremony shows stockpile points first and the remaining pooled army contribution separately; rounding happens once for the combined pool.

Relics add secret quest values. Ties sort by total, then territory, then earlier registration. These rules should be announced before play.

At the hard deadline, pending orders expire and paid costs return. The engine freezes the tally without resolving an additional turn. Final score and identities stay server-side until the corresponding ceremony beat. Replay cannot recompute or change the frozen winner.

## Social play

Empire-to-empire messages, voluntary pacts, support and betrayal remain. Public data never includes real names or registration timestamps during play. Join instructions explicitly explain that names are revealed in the finale.

Heists retain proximity limits and the collision rule: multiple crews at one vault all fail. A single crew has a 30% chance to be caught. A caught thief can break a pact. Counterintelligence, sabotage, rumor forgery and player-to-player resource caravans are not implemented.

## Interfaces

Phones begin with an enlarged view of their empire, zoom/pan controls, a world overview, personal score and connection status. Expansion plans appear in the order queue. The map uses the existing colors and generated banners.

The TV retains the full map, countdown and ticker. Leaderboard pages rotate every ten seconds at readable type size. The finale releases scores in stages and rotates the completed standings six at a time.

## Reliability and access

Game-critical multi-write transitions use SQLite transactions. A failed scheduled turn rolls back and pauses the game, leaving a host-visible error. The next-turn deadline commits with the turn. SQLite uses WAL and FULL synchronous mode. Five-minute, startup and manual online backups include WAL state; New game takes a backup before resetting.

Admin requires an environment-supplied password. Admin and player login attempts are limited. New PINs use salted scrypt hashes; existing plaintext PINs upgrade after a successful reconnect. New abbreviations must be unique. Embedded page data is serialized safely so player text cannot break out into executable markup. Player sockets receive fresh personal state on reconnect.

## Still requires a human rehearsal

Resource growth, quest reachability and the new cadence need playtesting with real people. Test the TV at actual viewing distance, phones on the event Wi-Fi, one missed check-in, a server restart and the final ceremony. Use rehearsal mode and a separate database. Balance settings are intentionally locked once the scored game starts.
