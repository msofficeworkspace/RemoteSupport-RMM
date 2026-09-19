# Architecture

## Reusable installation URL

`/install` creates a new device record with a random UID and redirects to `/uid/<UID>`.

The UID identifies the enrolled PC. The authentication secret is separate and is never stored in plaintext.

A temporary installer token is stored as a hash for 30 minutes. The first installer download consumes the token and rotates the device's permanent secret. The generated BAT embeds the server URL, device ID, permanent secret, and agent executable URL.

## Device lifecycle

1. Customer opens `/install`.
2. Server creates a unique device UID.
3. Customer reaches `/uid/<UID>`.
4. Customer downloads the one-time installer.
5. Installer downloads the signed/self-contained Windows agent.
6. Agent writes its device configuration under `%ProgramData%\\RemoteSupport`.
7. Agent connects to `/ws/device/<deviceId>` and authenticates with its secret.
8. Technician sees the PC online and may view/control it according to the device policy.
9. Revocation marks the device revoked and prevents future authentication.

## Important production limitation

The current agent is a user-session agent using Windows desktop capture/input APIs. It is suitable for an authorized support prototype, but a production ScreenConnect-class product should use a Windows service plus a per-user interactive helper and secure IPC for UAC/secure-desktop/session switching, signed binaries, update verification, and stronger audit controls.


## v20 installer/runtime behavior
- Customer installer uses Windows BITS (`bitsadmin.exe`) only; no curl or PowerShell downloader.
- Installer and bundled agent both use `%ProgramData%\RemoteSupport\agent.json`, matching the current agent runtime.
- Installation requires Administrator rights and verifies the executable, configuration, Task Scheduler startup task, and running agent process before reporting success.
- Startup uses the proven V7/V8 Task Scheduler mechanism rather than a Registry Run key.
- The agent reports ONLINE for active input, AWAY after more than 180 seconds idle, and OFFLINE when disconnected.

## v11 installer/runtime behavior
- Customer installer uses Windows built-in curl with --ssl-no-revoke; it downloads to a temporary file before replacing the agent, so an existing running agent cannot be mistaken for a successful download.
- The agent runs as a background Windows GUI process and persists for the current Windows user through HKCU Run. Closing the installer CMD window does not stop the agent.
- The agent itself reports Windows keyboard/mouse idle time every 5 seconds: ACTIVE at 0-180 seconds idle, AWAY above 180 seconds, and OFFLINE when the agent WebSocket disconnects.
- Remote View/Control requests can wait while an agent is temporarily disconnected and resume when it reconnects.
