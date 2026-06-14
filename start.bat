@echo off
REM start.bat - double-click (or run) to launch aice-avm on Windows.
REM Builds from source if OCaml/dune is present, otherwise downloads the
REM prebuilt binaries from the latest GitHub release, then starts the
REM receiver and sends a sample actor.
powershell -ExecutionPolicy Bypass -File "%~dp0scripts\start.ps1" %*
