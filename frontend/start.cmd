@echo off
REM IT Avenue Workspace - desktop launcher
REM The environment may contain ELECTRON_RUN_AS_NODE=1, which forces Electron
REM to behave as plain Node and breaks the app. Clear it for this process.
set ELECTRON_RUN_AS_NODE=
cd /d "%~dp0"
npm start
