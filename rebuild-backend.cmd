@echo off
REM IT Avenue Workspace - rebuild the backend after code changes
REM
REM Run this whenever the backend code (backend\) has changed, for example after pulling or after a fix:
REM   1. takes a database backup first (backups\db-<date>.dump), because starting the new backend
REM      runs the schema migrations against your live database;
REM   2. rebuilds the backend image and restarts only the backend container;
REM   3. shows the start-up log and the container status so you can see it came up.
REM The database and the uploaded files are not touched. Use start-backend.cmd for a plain start.
cd /d "%~dp0"

set PGUSER=itavenue
set PGDB=itavenue
for /f "tokens=2 delims==" %%a in ('findstr /b "POSTGRES_USER=" .env 2^>nul') do set PGUSER=%%a
for /f "tokens=2 delims==" %%a in ('findstr /b "POSTGRES_DB=" .env 2^>nul') do set PGDB=%%a
for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd-HHmm"') do set STAMP=%%i

if not exist backups mkdir backups

echo [1/3] Backing up the database to backups\db-%STAMP%.dump ...
docker exec itavenue-db sh -c "pg_dump -U %PGUSER% -d %PGDB% --format=custom -f /tmp/rebuild-backup.dump"
if errorlevel 1 goto backupfailed
docker cp itavenue-db:/tmp/rebuild-backup.dump "backups\db-%STAMP%.dump"
if errorlevel 1 goto backupfailed
docker exec itavenue-db rm -f /tmp/rebuild-backup.dump
echo       Backup saved.

echo.
echo [2/3] Rebuilding and restarting the backend ...
docker compose up -d --build backend
if errorlevel 1 goto buildfailed

echo.
echo [3/3] Waiting for the backend to start ...
timeout /t 8 /nobreak >nul
docker compose ps
echo.
docker compose logs --tail 15 backend
echo.
echo Done. Check it with:  curl http://127.0.0.1:3001/api/health
echo To undo a bad rebuild, restore backups\db-%STAMP%.dump (see docs\BACKUP.md).
echo.
pause
exit /b 0

:backupfailed
echo.
echo The database backup FAILED, so nothing was rebuilt. Is Docker running, and is the itavenue-db container up?
echo   docker compose ps
echo.
pause
exit /b 1

:buildfailed
echo.
echo The rebuild FAILED. The old backend container may still be running. See the messages above.
echo.
pause
exit /b 1
