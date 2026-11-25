@echo off
rem Global mon.ai control: mon [start|stop|restart|status|open] [-NoBrowser]
rem This folder is on the user PATH, so it works from any terminal (PowerShell, cmd, Win+R).
pwsh -NoProfile -ExecutionPolicy Bypass -File "%~dp0..\scripts\mon.ps1" %*
