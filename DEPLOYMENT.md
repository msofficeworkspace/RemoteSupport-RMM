# Render deployment

This version bundles the Windows agent into the Node server build. The server copies
`agent/publish/RemoteSupportAgent.exe` to `server/dist/assets/RemoteSupportAgent.exe`
and `/download/RemoteSupportAgent.exe` serves that exact runtime file.

## Important: the agent is a 147+ MiB binary

GitHub blocks regular Git files larger than 100 MiB, so this project tracks the EXE
with Git LFS. Install Git LFS before the first push.

```bat
git lfs install
git add .gitattributes agent/publish/RemoteSupportAgent.exe
git add .
git commit -m "Bundle Windows support agent"
git push origin main
```

If the EXE was already committed as a normal Git object, convert it before pushing:

```bat
git lfs install
git lfs migrate import --include="agent/publish/RemoteSupportAgent.exe" --include-ref=refs/heads/main
git push --force-with-lease origin main
```

GitHub documents a 100 MiB hard limit for normal Git files and recommends Git LFS for
large binaries.

## Render settings

Use the repository root as the service source. The included `render.yaml` sets:

- Root Directory: `server`
- Build Command: `npm ci && npm run build`
- Start Command: `npm start`

The build script resolves `../agent/publish/RemoteSupportAgent.exe` from the checked-out
repository and copies it into `server/dist/assets`.

Set these environment variables in Render:

- `TECHNICIAN_TOKEN` = a long random secret
- `PUBLIC_BASE_URL` = `https://remotesupport-rmm.onrender.com`
- `AGENT_DOWNLOAD_URL` = leave blank to use the bundled route

After deployment, verify:

1. `https://remotesupport-rmm.onrender.com/health`
2. `https://remotesupport-rmm.onrender.com/download/RemoteSupportAgent.exe`
3. The second URL should return an EXE download, not the old "not bundled" message.

## Windows agent build

On Windows with .NET 8 SDK:

```bat
BUILD_AGENT.bat
```

The project is configured for a self-contained, single-file `win-x64` publish. The
result is `agent\publish\RemoteSupportAgent.exe`.

## Security

Do not publish a technician token in the repository. Each customer installation gets
a unique device ID and random device secret.

## Technician WebSocket fix

The technician dashboard now waits for the WebSocket to reach the `TECH_OK` authenticated state before allowing a remote session to open. Previously `connect()` returned immediately after creating the browser WebSocket, so a fast click on **View Desktop** or **Control PC** could see `Technician WebSocket is not connected` while the socket was still connecting.

The server also logs WebSocket upgrade requests and accepted connections. In the Render logs you should see messages similar to:

- `WebSocket upgrade requested`
- `WebSocket upgrade accepted`
- `Technician WebSocket authenticated` (in the browser console)

If the browser still cannot connect after deployment, open Chrome DevTools → Console and look for the WebSocket close code/reason emitted by the updated dashboard.


## WebSocket deployment note

The technician WebSocket no longer depends on an HTTP-issued ticket. The browser opens `/ws/technician` and authenticates immediately over the already-established TLS WebSocket with the technician token. This avoids ticket/session routing races and makes the connection flow much simpler.

The current server also keeps the live device WebSocket and remote-control session in process memory, so this deployment is intentionally configured with `numInstances: 1`. Render routes each WebSocket connection to an instance and does not guarantee that reconnects land on the same instance. For multi-instance production, move live routing/session state to shared infrastructure (for example Render Key Value/Redis) before scaling horizontally.


## FIXED BUILD CONFIGURATION

Render must use the **repository root** as the service Root Directory. The included `render.yaml` uses:

- Root Directory: blank / repository root
- Build Command: `cd server && npm ci && npm run build`
- Start Command: `cd server && npm start`

This is required because the build needs both `server/` and `agent/publish/` in the Render checkout. Do not set the Render Root Directory to `server`.

The build copies `agent/publish/RemoteSupportAgent.exe` into `server/dist/assets/RemoteSupportAgent.exe`. Keep the Windows agent executable available in the repository via Git LFS.

The technician WebSocket authenticates with the technician token immediately after the TLS WebSocket opens. Keep the service at one instance while device/session state remains process-local.

## Offline remote-session behavior (v8)

View Desktop and Control PC no longer fail immediately just because the Windows agent socket is temporarily disconnected. The technician request is held in memory and automatically starts when that same device reconnects to the current Render process. The browser also re-requests an active session after the technician WebSocket reconnects.

Important: a genuinely offline PC cannot be viewed or controlled while it has no network connection and no running agent. This feature is a reconnect/resume queue, not offline control. Keep the Render service at one instance while session state remains process-local.


## v9 customer-agent behavior

- The generated customer installer uses Windows built-in curl with --ssl-no-revoke; it does not require PowerShell or BITS for the download.
- The bundled Windows agent is built as a GUI/background application so closing a command window does not terminate the agent.
- A hidden scheduled-task presence reporter checks Windows `GetLastInputInfo` every 5 seconds and reports `ACTIVE` or `AWAY` (more than 3 minutes idle).
- `OFFLINE` is shown when the enrolled agent is no longer connected/reachable by the server.
- Remote sessions requested while the agent is temporarily disconnected are held and resumed automatically when that same device reconnects to the single Render instance.


## v11 installer/runtime behavior
- Customer installer uses Windows built-in curl with --ssl-no-revoke; it downloads to a temporary file before replacing the agent, so an existing running agent cannot be mistaken for a successful download.
- The agent runs as a background Windows GUI process and persists for the current Windows user through HKCU Run. Closing the installer CMD window does not stop the agent.
- The agent itself reports Windows keyboard/mouse idle time every 5 seconds: ACTIVE at 0-180 seconds idle, AWAY above 180 seconds, and OFFLINE when the agent WebSocket disconnects.
- Remote View/Control requests can wait while an agent is temporarily disconnected and resume when it reconnects.
