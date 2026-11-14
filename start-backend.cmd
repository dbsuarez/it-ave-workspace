@echo off
REM IT Avenue Workspace - backend launcher
REM Starts the database and backend containers with Docker Compose.
REM Passwordless sign-in is enabled via ALLOW_PASSWORDLESS_SIGNIN=true in .env.
REM On the login page you can use either:
REM   - just your username (no password)   <- passwordless
REM   - username + password                <- normal
cd /d "%~dp0"
docker compose up -d
echo.
echo Backend starting. Check it with:
echo   docker compose ps
echo   curl http://127.0.0.1:3001/api/health
echo.
pause
