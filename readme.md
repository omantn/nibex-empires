# Nibex: Empires — host guide

The weekend empire game for the Nibex cup. Players use /join and /play; keep /dashboard on the TV and /admin on the host's device.

## Start

Run `Start-Nibex.ps1` in PowerShell. It asks for an admin password if ADMIN_PASSWORD is not already set, starts the server, and restarts it after an unexpected nonzero exit. No admin password is stored in the source code. Keep the host computer awake during the event.

Alternatively, set ADMIN_PASSWORD in the process environment and run `npm start`. The default port is 3000. Set PORT to change it. PUBLIC_URL overrides the address encoded in the join QR code if the automatic LAN address picks the wrong adapter.

### Raspberry Pi / Linux

Clone the repo, then run `./setup-pi.sh`. It installs Node if needed, installs dependencies, asks for the admin password and port, and registers a systemd service that starts on boot and restarts on crash. Re-run it any time to change the password or port. After a `git pull`, run `sudo systemctl restart nibex`.

## Before the event

1. Download a backup from Admin before replacing an existing rehearsal. New game also takes a backup before clearing state.
2. Start a fresh lobby for this version: cadence and scoring have changed. Existing databases migrate without wiping players, but do not change versions during a scored competition.
3. Set the end time, turn length, daily orders, Nightfall and quest allowance before launch. Defaults are 180-minute turns, 20 orders per day, two quests per day and Nightfall from 02:00 to 10:00. Times use the server computer's local timezone.
4. Leave Rehearsal mode off for the cup. It enables early consensus/admin turns and cannot be changed after launch.
5. Test the join QR on a phone connected to the event Wi-Fi. Confirm the TV can reach the dashboard, and that real phones reconnect after sleeping.
6. Run a short rehearsal with a few people. The automated tests verify correctness; human playtesting is still needed to tune the three-hour cadence, resource growth and quest difficulty.

## During play

Players receive a fixed daily order budget. They can plan connected expansion routes that advance one frontier per turn. Current-day cancellations return the order slot; cancelling plans bought on previous days does not bank old daily allowances. Paid ore/food always returns when a pending order is cancelled during play.

The player map opens on their capital, with zoom/pan controls and a World overview. The TV leaderboard rotates through groups of readable rows every ten seconds.

Pause stops game actions and turns. Resume preserves the remaining time to the next turn. The final end time is a hard event deadline and is NOT extended by a pause; the host can explicitly adjust it in Admin before it passes.

If a turn throws an error, its database transaction rolls back and the scheduler pauses the game. Inspect the server log before resuming. Do not repeatedly resolve the same broken turn.

## Finale

At the deadline (or End game now), unexecuted orders expire, their paid resources are refunded, and the final standings are frozen in one transaction. No extra final turn is invented. Inform players of this cutoff before play.

Start Finale reveals last place through champion. Names and secret scores are released from the server only as their ceremony beats arrive. Replaying uses the same frozen result. Ties use total score, then territory score, then earlier registration; publish that rule before launch. Final standings rotate in groups of six so every name can be read.

## Backups and restoration

Automatic SQLite snapshots run at startup and every five minutes. Admin can download one on demand. They include committed WAL state; copying only a live nibex.db file is not a reliable backup. Snapshots live in `backups/` beside the database, or in NIBEX_BACKUP_DIR if configured. Backups contain identities and authentication data: keep them on the host's machine or a private backup drive.

For recovery, stop the server. Preserve the existing database and its WAL/SHM companions together. Copy the selected snapshot to a NEW filename, set NIBEX_DB to its absolute path, then start the server. This avoids mixing old WAL files into a restored database and leaves the original available. Verify the turn number and player count before resuming. A snapshot restore can lose changes made since that snapshot; ordinary process restart resumes committed database state.

Missed turns collapse into one late turn rather than replaying many turns. The deadline wins if the server restarts after the event has ended.

## Verification

Run `npm test`. Tests use disposable databases and an isolated HTTP server on port 3187; they never open the event database. Coverage includes simultaneous attacks, transactional rollback, private identities, safe page serialization, market/muster scoring, final lock, daily budgets, expansion plans, PIN migration, settings validation and backup recovery in a new process.

## Player instructions

The live How to play panel on /play is authoritative and uses the configured cadence. HOW-TO-PLAY.html is a refreshed printable guide using the defaults; regenerate it with `npm run guide`. The older HOW-TO-PLAY.pdf is a pre-review export and should not be handed out for this version. DESIGN.md describes the current rules.

