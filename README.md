# RemoteSupport-RMM

Browser-based authorized Windows remote-support system using a Node/Fastify/WebSocket server and a .NET 8 Windows agent.

## New reusable customer installation link

Use one permanent public URL:

`https://remotesupport-rmm.onrender.com/install`

Every time `/install` is opened, the server creates a fresh unique PC UID and redirects to:

`/uid/XXXXXXXXXX`

The customer downloads the installer for that UID. The Windows agent reports the real Windows computer name automatically after it connects.

**Do not reuse one downloaded installer on another PC.** The installer is tied to the PC enrollment it was generated for.

## Render environment variables

Set these in Render:

- `TECHNICIAN_TOKEN` = long random secret
- `PUBLIC_BASE_URL` = `https://remotesupport-rmm.onrender.com`
- `AGENT_DOWNLOAD_URL` = optional direct HTTPS URL of `RemoteSupportAgent.exe`
  - If omitted, the server automatically serves its bundled agent at `/download/RemoteSupportAgent.exe`.

The agent download URL should be a stable HTTPS URL. A GitHub Release asset is a practical option.

## Build the Windows agent

On a Windows development machine with .NET 8 SDK:

```bat
cd agent
dotnet publish -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -o publish
```

The executable will be:

`agent\publish\RemoteSupportAgent.exe`

If you use the bundled agent route, no upload URL is required. Otherwise, upload the executable to your chosen HTTPS location and set its direct URL as `AGENT_DOWNLOAD_URL`.

## Local server

```bat
cd server
npm install
npm run build
npm start
```

## Security model

Each installation gets its own random device UID and a separate random device secret. The server stores only a SHA-256 hash of the device secret. Technician actions require `TECHNICIAN_TOKEN`. Revoked devices cannot reconnect.

## Production database note

The current project uses SQLite for simplicity. On Render's free web service, local filesystem data is not a durable production database. Before real customer use, move device/customer data to PostgreSQL or another persistent database.


### WebSocket deployment

The technician session ticket is signed with HMAC and expires after 60 seconds, so the HTTP ticket request and WebSocket upgrade do not depend on the same Render instance. The live device/technician socket maps are still process-local, so the included Render configuration intentionally uses one instance. Render assigns each incoming WebSocket connection to an instance and reconnects are not guaranteed to return to the same instance.

RemoteSupport RMM FIXED v9


## v11 installer/runtime behavior
- Customer installer uses Windows built-in curl with --ssl-no-revoke; it downloads to a temporary file before replacing the agent, so an existing running agent cannot be mistaken for a successful download.
- The agent runs as a background Windows GUI process and persists for the current Windows user through HKCU Run. Closing the installer CMD window does not stop the agent.
- The agent itself reports Windows keyboard/mouse idle time every 5 seconds: ACTIVE at 0-180 seconds idle, AWAY above 180 seconds, and OFFLINE when the agent WebSocket disconnects.
- Remote View/Control requests can wait while an agent is temporarily disconnected and resume when it reconnects.


V22 installer behavior: the customer installer automatically invokes the standard Windows UAC Administrator approval prompt when elevation is required. BITS remains the download mechanism; PowerShell is used only for the UAC ShellExecute RunAs handoff.


### V36 capture fix
The bundled Windows agent is DPI-aware and captures the physical virtual desktop bounds, preventing DPI virtualization from truncating the desktop. The technician viewer fits the complete received frame at 100% zoom.
