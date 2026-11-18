@echo off
REM Boot DSH for the dsh-sync-suite workspace only.
REM
REM Applies tools\dsh-workspace.patch.yml on top of the desktop profile:
REM   subagent parallelism = 5, executor model = dsh-opencode-go/hy4-flash-free.
REM Nothing in ~/.dsh/profiles is modified by this script.
REM
REM Why: DSH plugin config is profile-scoped; there is no per-directory config
REM layer. --patch is the only supported way to scope settings to one project
REM without editing the profile.

setlocal
set "DSH_CLI=%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"
set "PATCH=%~dp0dsh-workspace.patch.yml"

if not exist "%DSH_CLI%" (
  echo [dsh-workspace] DSH CLI not found: %DSH_CLI%
  exit /b 2
)
if not exist "%PATCH%" (
  echo [dsh-workspace] patch not found: %PATCH%
  exit /b 2
)

echo [dsh-workspace] profile=desktop
echo [dsh-workspace] patch=%PATCH%
call "%DSH_CLI%" --profile desktop --patch "%PATCH%" %*
exit /b %ERRORLEVEL%
