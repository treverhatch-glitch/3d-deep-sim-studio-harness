@echo off
rem Windows: runs the setup without npm.ps1, which PowerShell blocks when script execution is disabled.
rem Same as "npm run setup". Usage: setup.cmd   (or .\setup.cmd in PowerShell)
node "%~dp0scripts\setup.mjs" %*
