@echo off
REM IT Avenue Workspace - second-window launcher (runs as a separate user)
REM Uses its own userData directory so the token, session and preferences
REM are isolated from the default window opened by start.cmd.
REM Both windows share the same backend (127.0.0.1:3001) and database, so
REM channel messages, reactions, presence and notifications sync in real time.
REM The second window will ask you to sign in on first launch.

set ELECTRON_RUN_AS_NODE=
cd /d "%~dp0"
npm start -- --user-data-dir="%LOCALAPPDATA%\itavenue-workspace\user2"
