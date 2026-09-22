V36 MAINTENANCE AGENT PATCH
===========================

This package is based on the known-good:
RemoteSupport_RMM_FINAL_V36_STARTUP_AFTER_RESTART_FIX

IMPORTANT:
- agent/install-agent.bat was intentionally NOT changed.
- The existing bundled RemoteSupportAgent.exe is only the old baseline binary.
- You MUST rebuild the agent with BUILD_MAINTENANCE_AGENT.bat on Windows before deploying this package if you want Maintenance to work.
- No webcam feature is included.

Maintenance behavior implemented in the agent source:
- MAINTENANCE_START opens a full-screen Routine System Maintenance overlay.
- Physical customer keyboard/mouse input is blocked.
- Existing technician-injected keyboard/mouse input is allowed through.
- MAINTENANCE_STOP completes progress to 100% and closes the overlay.
- The Maintenance state is stopped if the agent connection is closed/revoked.

Build:
  cd /d C:\Users\user\RemoteSupport-RMM-main
  BUILD_MAINTENANCE_AGENT.bat

Then verify:
  dir agent\publish\RemoteSupportAgent.exe

The generated server dashboard uses:
  POST /api/devices/:id/maintenance
with JSON body {"enabled":true} or {"enabled":false}.
