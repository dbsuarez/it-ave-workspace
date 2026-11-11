# Backup and restore

Two things hold all the data: the **PostgreSQL database** (volume `itavenue_db_data`) and the
**uploaded files** (volume `itavenue_uploads`). Back up both, from the same moment where you can.
Your `.env` (secrets) is a third item: keep a copy somewhere private, never in git.

The commands below were run against this stack and restore verified (same user and message counts
in the restored copy). They use PowerShell from the repo folder; `POSTGRES_USER` and
`POSTGRES_DB` come from `.env`.

> **Do not redirect a dump with `>` in Windows PowerShell 5.1.** It re-encodes binary output and
> corrupts the file. Dump inside the container, then `docker cp` it out, as below.

## Back up

```powershell
$u = (Select-String .env -Pattern '^POSTGRES_USER=(.*)$').Matches[0].Groups[1].Value
$d = (Select-String .env -Pattern '^POSTGRES_DB=(.*)$').Matches[0].Groups[1].Value
$stamp = Get-Date -Format 'yyyyMMdd-HHmm'
New-Item -ItemType Directory -Force backups | Out-Null

# Database (custom format: compressed, restores selectively)
docker exec itavenue-db sh -c "pg_dump -U $u -d $d --format=custom -f /tmp/backup.dump"
docker cp itavenue-db:/tmp/backup.dump "backups\db-$stamp.dump"
docker exec itavenue-db rm -f /tmp/backup.dump

# Uploaded files
docker cp itavenue-backend:/app/uploads "backups\uploads-$stamp"
```

Copy the `backups` folder **off this machine** (another disk or cloud storage). A backup that only
lives next to the database does not survive a dead disk. `backups/` should stay out of git.

## Scheduled backups

To have this done for you every day, start the backup service: `docker compose --profile backup up -d backup`.
It writes the same two files into `backups/` on a schedule and removes old ones. See
[`deploy/README.md`](../deploy/README.md#scheduled-backups). You still need to copy `backups/` off the machine.

## Restore

Restore into a new, empty database first to check the dump, then swap if you need to.

```powershell
# 1. Check a dump into a scratch database (safe; does not touch live data)
docker exec itavenue-db psql -U $u -d postgres -c "CREATE DATABASE restore_check"
docker cp backups\db-YYYYMMDD-HHMM.dump itavenue-db:/tmp/restore.dump
docker exec itavenue-db pg_restore -U $u -d restore_check --no-owner /tmp/restore.dump
docker exec itavenue-db psql -U $u -d restore_check -c "SELECT count(*) FROM users"
docker exec itavenue-db psql -U $u -d postgres -c "DROP DATABASE restore_check"

# 2. Real restore (destroys current data): stop the app, replace the database, start again
docker compose stop backend
docker exec itavenue-db psql -U $u -d postgres -c "DROP DATABASE $d" -c "CREATE DATABASE $d"
docker exec itavenue-db pg_restore -U $u -d $d --no-owner /tmp/restore.dump
docker cp "backups\uploads-YYYYMMDD-HHMM\." itavenue-backend:/app/uploads/
docker compose start backend
```

Restoring the database without its matching uploads leaves messages pointing at missing files
(downloads answer "File data is missing on disk"), so restore both from the same stamp.

## Routine

- Take a backup **before every deploy or schema change** and before running `docker compose down -v`
  (`-v` deletes the volumes).
- Until there is a scheduler, run it by hand daily. A Windows Task Scheduler entry running the
  block above is the next step.
- Test a restore (step 1) now and then. An untested backup is a guess.
- Sessions survive a restore: tokens are checked against `users.token_version`, so if you restore an
  older dump, people whose password changed since may need to sign in again.
