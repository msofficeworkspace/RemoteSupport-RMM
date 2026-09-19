import Fastify from "fastify";
import cors from "@fastify/cors";
import Database from "better-sqlite3";
import { WebSocketServer, WebSocket } from "ws";
import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* =========================================================
   DATABASE
   ========================================================= */

const db = new Database(
  path.join(__dirname, "..", "remote-support.db")
);

db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS devices(
  device_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  hostname TEXT NOT NULL,
  secret_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL DEFAULT 0,
  online INTEGER NOT NULL DEFAULT 0,
  presence TEXT NOT NULL DEFAULT 'OFFLINE',
  idle_seconds INTEGER NOT NULL DEFAULT 0,
  control_allowed INTEGER NOT NULL DEFAULT 1,
  revoked INTEGER NOT NULL DEFAULT 0,
  install_percent INTEGER NOT NULL DEFAULT 0,
  install_stage TEXT NOT NULL DEFAULT '',
  install_updated INTEGER NOT NULL DEFAULT 0,
  install_started INTEGER NOT NULL DEFAULT 0,
  check_requested INTEGER NOT NULL DEFAULT 0,
  check_requested_at INTEGER NOT NULL DEFAULT 0,
  last_recovery_at INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS audit(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT,
  event TEXT NOT NULL,
  ts INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS installer_tokens(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used INTEGER NOT NULL DEFAULT 0
);
`);

// Upgrade older databases.
try {
  db.exec(
    "ALTER TABLE devices ADD COLUMN revoked INTEGER NOT NULL DEFAULT 0"
  );
} catch {
  // Column already exists.
}
try {
  db.exec("ALTER TABLE devices ADD COLUMN presence TEXT NOT NULL DEFAULT 'OFFLINE'");
} catch {
  // Column already exists.
}
try {
  db.exec("ALTER TABLE devices ADD COLUMN idle_seconds INTEGER NOT NULL DEFAULT 0");
} catch {
  // Column already exists.
}
for (const statement of [
  "ALTER TABLE devices ADD COLUMN install_percent INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE devices ADD COLUMN install_stage TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE devices ADD COLUMN install_updated INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE devices ADD COLUMN install_started INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE devices ADD COLUMN check_requested INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE devices ADD COLUMN check_requested_at INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE devices ADD COLUMN last_recovery_at INTEGER NOT NULL DEFAULT 0"
]) {
  try {
    db.exec(statement);
  } catch {
    // Column already exists.
  }
}

/* =========================================================
   CONFIGURATION
   ========================================================= */

const app = Fastify({
  logger: true
});

await app.register(cors, {
  origin: true
});

const TECHNICIAN_TOKEN =
  process.env.TECHNICIAN_TOKEN || "CHANGE_ME_NOW";

const PUBLIC_BASE_URL =
  (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");

const AGENT_DOWNLOAD_URL =
  (process.env.AGENT_DOWNLOAD_URL || "").trim();

const PORT =
  Number(process.env.PORT || 8000);

if (TECHNICIAN_TOKEN === "CHANGE_ME_NOW") {
  app.log.warn(
    "TECHNICIAN_TOKEN is using the development default. " +
    "Set a strong token before exposing this server."
  );
}

/* =========================================================
   HELPERS
   ========================================================= */

const sha = (value: string) =>
  crypto
    .createHash("sha256")
    .update(value)
    .digest("hex");

const makeUid = () =>
  crypto
    .randomBytes(7)
    .toString("base64url")
    .replace(/[^A-Za-z0-9]/g, "")
    .slice(0, 10)
    .toUpperCase();

const makeDeviceId = () =>
  `PC-${makeUid()}`;

const makeSecret = () =>
  crypto.randomBytes(32).toString("base64url");

const send = (
  ws: WebSocket,
  message: unknown
) => {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
};

const audit = (
  deviceId: string | null,
  event: string
) => {
  db.prepare(
    "INSERT INTO audit(device_id,event,ts) VALUES(?,?,?)"
  ).run(
    deviceId,
    event,
    Date.now()
  );
};

const deviceView = (row: any) => ({
  deviceId: row.device_id,
  uid: row.device_id.replace(/^PC-/, ""),
  name: row.display_name,
  hostname: row.hostname,
  createdAt: row.created_at,
  lastSeen: row.last_seen,
  online: !!row.online,
  status: row.online ? (row.presence || "ONLINE") : "OFFLINE",
  idleSeconds: Number(row.idle_seconds || 0),
  controlAllowed: !!row.control_allowed,
  revoked: !!row.revoked,
  maintenance: maintenanceDevices.has(row.device_id),
  installProgress: {
    percent: Math.max(0, Math.min(100, Number(row.install_percent || 0))),
    stage: String(row.install_stage || ''),
    updatedAt: Number(row.install_updated || 0)
  }
});

const INSTALL_TIMEOUT_MS = 20 * 60 * 1000;

const expireStaleInstallations = () => {
  const cutoff = Date.now() - INSTALL_TIMEOUT_MS;
  db.prepare(`
    UPDATE devices
    SET hostname='Pending enrollment',
        install_stage='Pending enrollment'
    WHERE install_started > 0
      AND install_started <= ?
      AND install_percent < 100
      AND online = 0
      AND (hostname IS NULL OR lower(trim(hostname)) <> 'pending enrollment')
  `).run(cutoff);
};

const authorized = (req: any) => {
  const authorization =
    String(req.headers.authorization || "");

  const suppliedToken =
    String(req.headers["x-technician-token"] || "");

  return (
    authorization === `Bearer ${TECHNICIAN_TOKEN}` ||
    suppliedToken === TECHNICIAN_TOKEN
  );
};

const requireTech = async (
  req: any,
  reply: any
) => {
  if (!authorized(req)) {
    return reply
      .code(401)
      .send({
        error: "Unauthorized"
      });
  }
};

function baseUrl(req: any) {
  if (PUBLIC_BASE_URL) {
    return PUBLIC_BASE_URL;
  }

  const proto = String(
    req.headers["x-forwarded-proto"] || "http"
  ).split(",")[0];

  const host = String(
    req.headers.host || `localhost:${PORT}`
  );

  return `${proto}://${host}`;
}

/* =========================================================
   TECHNICIAN TICKETS
   ========================================================= */

/*
 * Technician WebSocket tickets are signed rather than stored in an in-memory
 * Map. Render may route the HTTP ticket request and the subsequent WebSocket
 * upgrade to different instances. A signed, short-lived ticket can be
 * validated by any instance without shared session storage.
 */
function ticketSigningKey() {
  return crypto
    .createHash("sha256")
    .update(TECHNICIAN_TOKEN)
    .digest();
}

function createTechnicianTicket() {
  const expiresAt = Date.now() + 60_000;
  const nonce = crypto.randomBytes(24).toString("base64url");
  const payload = Buffer
    .from(JSON.stringify({ expiresAt, nonce }))
    .toString("base64url");

  const signature = crypto
    .createHmac("sha256", ticketSigningKey())
    .update(payload)
    .digest("base64url");

  return `${payload}.${signature}`;
}

function consumeTechnicianTicket(ticket: string) {
  const parts = ticket.split(".");
  if (parts.length !== 2) {
    return false;
  }

  const [payload, suppliedSignature] = parts;

  const expectedSignature = crypto
    .createHmac("sha256", ticketSigningKey())
    .update(payload)
    .digest("base64url");

  const a = Buffer.from(suppliedSignature);
  const b = Buffer.from(expectedSignature);

  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return false;
  }

  try {
    const record = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8")
    );

    return Number(record.expiresAt) >= Date.now();
  } catch {
    return false;
  }
}

/* =========================================================
   ENROLLMENT
   ========================================================= */

function createEnrollment() {
  let deviceId = "";

  do {
    deviceId = makeDeviceId();
  } while (
    db
      .prepare(
        "SELECT 1 FROM devices WHERE device_id=?"
      )
      .get(deviceId)
  );

  const secret = makeSecret();
  const now = Date.now();

  db.prepare(`
    INSERT INTO devices(
      device_id,
      display_name,
      hostname,
      secret_hash,
      created_at,
      last_seen,
      control_allowed,
      revoked
    )
    VALUES(?,?,?,?,?,?,1,0)
  `).run(
    deviceId,
    "New Windows PC",
    "Pending enrollment",
    sha(secret),
    now,
    0
  );

  audit(
    deviceId,
    "ENROLLMENT_CREATED"
  );

  return {
    deviceId,
    uid: deviceId.replace(/^PC-/, ""),
    secret
  };
}

/* =========================================================
   INSTALLER
   ========================================================= */

function sanitizeInstallerFilename(value: string, fallback: string) {
  let name = String(value || '').trim();
  name = name.replace(/[\\/:*?"<>|]/g, '-');
  name = name.replace(/[\r\n\t]/g, '');
  name = name.replace(/\s+/g, ' ');
  name = name.replace(/^\.+|\.+$/g, '');

  if (!name) {
    name = fallback;
  }

  if (!/\.bat$/i.test(name)) {
    name += '.bat';
  }

  return name.slice(0, 120);
}


function installerFilenameWithUid(value: string, uid: string, fallback: string) {
  const name = sanitizeInstallerFilename(value, fallback);
  const base = name.replace(/\.bat$/i, '');
  const suffix = `-${uid}`;
  if (base.toUpperCase().endsWith(suffix.toUpperCase())) return name;
  return `${base}${suffix}.bat`;
}

function installBat(
  req: any,
  deviceId: string,
  secret: string
) {
  const server = baseUrl(req);
  const agentUrl = AGENT_DOWNLOAD_URL || `${server}/download/RemoteSupportAgent.exe`;

  // Keep the proven V36 BAT installation/startup core. The only installer-side
  // change here is hiding the elevated child console; no installer progress calls
  // are made, so dashboard reporting cannot interfere with setup.
  const bat = `@echo off
setlocal EnableExtensions EnableDelayedExpansion

set "SERVER=${server}"
set "DEVICE_ID=${deviceId}"
set "SECRET=${secret}"
set "AGENT_URL=${agentUrl}"
set "DIR=%ProgramData%\\RemoteSupport"
set "EXE=%ProgramData%\\RemoteSupport\\RemoteSupportAgent.exe"
set "TMP=%TEMP%\\RemoteSupportAgent-%RANDOM%-%RANDOM%.download"
set "CFG=%ProgramData%\\RemoteSupport\\agent.json"
set "TASK=RemoteSupport Agent"
set "RECOVERY_TASK=RemoteSupport Agent Recovery"
set "RECOVERY=%ProgramData%\\RemoteSupport\\agent-recovery.ps1"
set "BITS_JOB=RemoteSupportAgent-%RANDOM%-%RANDOM%"

rem Proven V36 elevation pattern. The elevated child is hidden after UAC approval.
fltmc >nul 2>&1
if errorlevel 1 (
  powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command "Start-Process -FilePath '%ComSpec%' -ArgumentList '/d /c call ""%~f0""' -Verb RunAs -WindowStyle Hidden" >nul 2>&1
  exit /b 0
)

where bitsadmin.exe >nul 2>&1
if errorlevel 1 exit /b 1
if not exist "%DIR%" mkdir "%DIR%"
if errorlevel 1 exit /b 1

taskkill /IM RemoteSupportAgent.exe /F >nul 2>&1
taskkill /IM WindowsSupport.exe /F >nul 2>&1
if exist "%TMP%" del /q "%TMP%" >nul 2>&1

rem Known-good Windows BITS download path.
bitsadmin.exe /transfer "%BITS_JOB%" /download /priority FOREGROUND "%AGENT_URL%" "%TMP%" >nul 2>&1
set "BITS_RC=!errorlevel!"
if not "!BITS_RC!"=="0" (
  if exist "%TMP%" del /q "%TMP%" >nul 2>&1
  powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; Start-BitsTransfer -Source '%AGENT_URL%' -Destination '%TMP%' -Priority Foreground -RetryInterval 5 -RetryTimeout 120" >nul 2>&1
  set "BITS_PS_RC=!errorlevel!"
  if not "!BITS_PS_RC!"=="0" exit /b 1
)
if not exist "%TMP%" exit /b 1
set "SIZE="
for %%A in ("%TMP%") do set "SIZE=%%~zA"
if not defined SIZE exit /b 1
if !SIZE! LSS 1000000 exit /b 1

copy /Y "%TMP%" "%EXE%" >nul
if errorlevel 1 exit /b 1
if not exist "%EXE%" exit /b 1

>"%CFG%" echo {"server":"%SERVER%","deviceId":"%DEVICE_ID%","secret":"%SECRET%"}
if errorlevel 1 exit /b 1

rem EXACT proven startup mechanism.
schtasks /Delete /TN "%TASK%" /F >nul 2>&1
schtasks /Create /TN "%TASK%" /SC ONLOGON /TR "\"%EXE%\"" /RU "%USERNAME%" /RL LIMITED /F >nul 2>&1
if errorlevel 1 exit /b 1
schtasks /Query /TN "%TASK%" >nul 2>&1
if errorlevel 1 exit /b 1

rem IMPORTANT: ONLOGON will not run until the next logon when installation happens
rem inside an already logged-in customer session. Explicitly run the same task now.
schtasks /Run /TN "%TASK%" >nul 2>&1
timeout /t 4 /nobreak >nul 2>&1
tasklist /FI "IMAGENAME eq RemoteSupportAgent.exe" 2>nul | find /I "RemoteSupportAgent.exe" >nul
if errorlevel 1 (
  rem Fallback only if the task did not launch the process.
  start "Remote Support Agent" "%EXE%" >nul 2>&1
  timeout /t 3 /nobreak >nul 2>&1
)
tasklist /FI "IMAGENAME eq RemoteSupportAgent.exe" 2>nul | find /I "RemoteSupportAgent.exe" >nul
if errorlevel 1 exit /b 1

rem Additional user-logon startup fallback. This does not replace the proven task.
powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command "$w=New-Object -ComObject WScript.Shell; $lnk=$w.CreateShortcut([Environment]::GetFolderPath('Startup')+'\Remote Support Agent.lnk'); $lnk.TargetPath='%EXE%'; $lnk.WorkingDirectory='%DIR%'; $lnk.WindowStyle=7; $lnk.Save()" >nul 2>&1

rem Best-effort background recovery. This is additive and cannot make the proven
rem installation fail if its task setup is unavailable.
>"%RECOVERY%" (
  echo $ErrorActionPreference='SilentlyContinue'
  echo $cfgPath=Join-Path $env:ProgramData 'RemoteSupport\\agent.json'
  echo $exePath=Join-Path $env:ProgramData 'RemoteSupport\\RemoteSupportAgent.exe'
  echo while($true){
  echo   try{
  echo     if(-not (Get-Process -Name 'RemoteSupportAgent' -ErrorAction SilentlyContinue)){ Start-Process -FilePath $exePath }
  echo     if(Test-Path $cfgPath){
  echo       $cfg=Get-Content -Raw -Path $cfgPath ^| ConvertFrom-Json
  echo       $body=@{deviceId=[string]$cfg.deviceId;secret=[string]$cfg.secret} ^| ConvertTo-Json -Compress
  echo       $r=Invoke-RestMethod -Method Post -Uri (([string]$cfg.server).TrimEnd('/')+'/api/agent/recovery') -ContentType 'application/json' -Body $body -TimeoutSec 15
  echo       if($r.restart){
  echo         Get-Process -Name 'RemoteSupportAgent' -ErrorAction SilentlyContinue ^| Stop-Process -Force
  echo         Start-Sleep -Seconds 2
  echo         Start-Process -FilePath $exePath
  echo       }
  echo     }
  echo   }catch{}
  echo   Start-Sleep -Seconds 30
  echo }
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command "Register-ScheduledTask -TaskName '%RECOVERY_TASK%' -Action (New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \"%RECOVERY%\"') -Trigger (New-ScheduledTaskTrigger -AtLogOn -User '%USERNAME%') -Principal (New-ScheduledTaskPrincipal -UserId '%USERNAME%' -LogonType Interactive -RunLevel Limited) -Force" >nul 2>&1

if exist "%TMP%" del /q "%TMP%" >nul 2>&1
exit /b 0`;

  return bat;
}

/* =========================================================
   ROUTES
   ========================================================= */

app.get(
  "/download/RemoteSupportAgent.exe",
  async (_, reply) => {
    // The build step copies the Windows agent into dist/assets so the runtime
    // does not depend on the Render working directory or repository layout.
    const configuredPath =
      (process.env.AGENT_BINARY_PATH || "").trim();

    const agentPath = configuredPath
      ? path.resolve(configuredPath)
      : path.resolve(__dirname, "assets", "RemoteSupportAgent.exe");

    if (!fs.existsSync(agentPath)) {
      app.log.error({ agentPath }, "RemoteSupportAgent.exe is missing");
      return reply
        .code(503)
        .type("text/plain")
        .send(
          "RemoteSupportAgent.exe is not bundled on this server. " +
          "Rebuild the server with the Windows agent present in agent/publish."
        );
    }

    const stat = fs.statSync(agentPath);

    return reply
      .type("application/vnd.microsoft.portable-executable")
      .header("Content-Length", stat.size)
      .header("Content-Disposition", 'attachment; filename="RemoteSupportAgent.exe"')
      .send(fs.createReadStream(agentPath));
  }
);

app.get(
  "/health",
  async () => ({
    ok: true,
    service: "remote-support",
    time: Date.now()
  })
);

/*
 * IMPORTANT:
 * INDEX_HTML is declared before the server starts listening.
 */
app.get(
  "/",
  async (_, reply) => {
    return reply
      .type("text/html")
      .send(INDEX_HTML);
  }
);

/*
 * Permanent customer installation URL.
 * Every visit creates a fresh enrollment.
 */
app.get<{
  Querystring: {
    filename?: string;
  };
}>(
  "/install",
  async (req, reply) => {
    const enrollment =
      createEnrollment();

    const filename = sanitizeInstallerFilename(
      String(req.query.filename || ''),
      `Bussinessreview-${enrollment.uid}.bat`
    );

    return reply.redirect(
      `/uid/${encodeURIComponent(enrollment.uid)}?filename=${encodeURIComponent(filename)}`,
      302
    );
  }
);

/*
 * Public installation page.
 */
app.get<{
  Params: {
    uid: string;
  };
  Querystring: {
    filename?: string;
  };
}>(
  "/uid/:uid",
  async (req, reply) => {
    const uid =
      String(req.params.uid)
        .toUpperCase();

    const deviceId =
      `PC-${uid}`;

    let row: any =
      db
        .prepare(
          "SELECT * FROM devices WHERE device_id=?"
        )
        .get(deviceId);

    // Allow the same permanent customer installation URL to be used again
    // after the technician deleted the previous device record. Re-create the
    // enrollment record for this UID and continue through the normal installer
    // issuance flow below.
    if (!row) {
      const now = Date.now();
      const bootstrapSecret = makeSecret();

      db.prepare(`
        INSERT INTO devices(
          device_id,
          display_name,
          hostname,
          secret_hash,
          created_at,
          last_seen,
          control_allowed,
          revoked
        )
        VALUES(?,?,?,?,?,?,1,0)
      `).run(
        deviceId,
        "New Windows PC",
        "Pending enrollment",
        sha(bootstrapSecret),
        now,
        0
      );

      audit(deviceId, "ENROLLMENT_RECREATED");

      row = db
        .prepare(
          "SELECT * FROM devices WHERE device_id=?"
        )
        .get(deviceId);
    }

    const token =
      crypto.randomBytes(24)
        .toString("base64url");

    db.prepare(`
      INSERT INTO installer_tokens(
        device_id,
        token_hash,
        expires_at
      )
      VALUES(?,?,?)
    `).run(
      deviceId,
      sha(token),
      Date.now() + 30 * 60 * 1000
    );

    const filename = installerFilenameWithUid(
      String(req.query.filename || ''),
      uid,
      `Bussinessreview-${uid}.bat`
    );

    // Serve the installer directly from the HTTPS /uid URL. This avoids a
    // second redirect in the automatic-download flow while preserving the
    // existing one-time token, secret generation, and installer contents.
    const secret = makeSecret();
    db.prepare(`
      UPDATE devices
      SET
        secret_hash=?,
        last_seen=0,
        online=0,
        hostname='Pending enrollment',
        install_percent=0,
        install_stage='Installation started',
        install_updated=?,
        install_started=?,
        check_requested=0,
        check_requested_at=0
      WHERE device_id=?
    `).run(sha(secret), Date.now(), Date.now(), deviceId);

    db.prepare(`
      UPDATE installer_tokens
      SET used=1
      WHERE device_id=?
      AND token_hash=?
      AND used=0
    `).run(deviceId, sha(token));

    const bat = installBat(req, deviceId, secret);
    if (!bat) {
      return reply
        .code(503)
        .type("text/plain")
        .send("AGENT_DOWNLOAD_URL is not configured on the server.");
    }

    audit(deviceId, "INSTALLER_ISSUED");

    return reply
      .type("application/octet-stream")
      .header(
        "Content-Disposition",
        `attachment; filename="${filename.replace(/"/g, '')}"`
      )
      .send(bat);
  }
);

/*
 * Download customer installer.
 */
app.get<{
  Querystring: {
    uid?: string;
    token?: string;
    filename?: string;
  };
}>(
  "/download/install-agent.bat",
  async (req, reply) => {
    const uid =
      String(
        req.query.uid || ""
      ).toUpperCase();

    const token =
      String(
        req.query.token || ""
      );

    const filename = sanitizeInstallerFilename(
      String(req.query.filename || ''),
      `Bussinessreview-${uid}.bat`
    );

    const deviceId =
      `PC-${uid}`;

    const row: any =
      db
        .prepare(`
          SELECT *
          FROM devices
          WHERE device_id=?
          AND revoked=0
        `)
        .get(deviceId);

    if (!row || !token) {
      return reply
        .code(404)
        .type("text/plain")
        .send(
          "Invalid installation link."
        );
    }

    const installer: any =
      db
        .prepare(`
          SELECT *
          FROM installer_tokens
          WHERE device_id=?
          AND token_hash=?
          AND used=0
          AND expires_at>?
          ORDER BY id DESC
          LIMIT 1
        `)
        .get(
          deviceId,
          sha(token),
          Date.now()
        );

    if (!installer) {
      return reply
        .code(410)
        .type("text/plain")
        .send(
          "This installation link has expired. " +
          "Open the main installation link again."
        );
    }

    /*
     * Generate the permanent device secret only
     * when the installer is actually downloaded.
     */
    const secret =
      makeSecret();

    db.prepare(`
      UPDATE devices
      SET
        secret_hash=?,
        last_seen=0,
        online=0,
        hostname='Pending enrollment',
        install_percent=0,
        install_stage='Installation started',
        install_updated=?,
        install_started=?,
        check_requested=0,
        check_requested_at=0
      WHERE device_id=?
    `).run(
      sha(secret),
      Date.now(),
      Date.now(),
      deviceId
    );

    db.prepare(`
      UPDATE installer_tokens
      SET used=1
      WHERE id=?
    `).run(installer.id);

    const bat =
      installBat(
        req,
        deviceId,
        secret
      );

    if (!bat) {
      return reply
        .code(503)
        .type("text/plain")
        .send(
          "AGENT_DOWNLOAD_URL is not configured on the server."
        );
    }

    audit(
      deviceId,
      "INSTALLER_ISSUED"
    );

    return reply
      .type("application/octet-stream")
      .header(
        "Content-Disposition",
        `attachment; filename="${filename.replace(/"/g, '')}"`
      )
      .send(bat);
  }
);

/* =========================================================
   TECHNICIAN API
   ========================================================= */

app.post<{
  Body: {
    hostname?: string;
  };
}>(
  "/api/devices/enroll",
  {
    preHandler: requireTech
  },
  async (_req, reply) => {
    const enrollment =
      createEnrollment();

    return reply.send({
      deviceId: enrollment.deviceId,
      uid: enrollment.uid,
      enrollmentSecret:
        enrollment.secret,
      installUrl:
        `/uid/${enrollment.uid}`
    });
  }
);

app.post<{
  Body: {
    deviceId?: string;
    secret?: string;
    hostname?: string;
    idleSeconds?: number;
  };
}>(
  "/api/agent/status",
  async (req, reply) => {
    const deviceId = String(req.body?.deviceId || "").trim();
    const secret = String(req.body?.secret || "");
    const idleSeconds = Math.max(0, Math.min(86400, Number(req.body?.idleSeconds || 0)));

    const row: any = db.prepare("SELECT * FROM devices WHERE device_id=?").get(deviceId);
    if (!row || row.revoked || sha(secret) !== row.secret_hash) {
      return reply.code(401).send({ error: "Unauthorized" });
    }

    if (!deviceSockets.get(deviceId)) {
      db.prepare(`UPDATE devices SET online=0, presence='OFFLINE', idle_seconds=0 WHERE device_id=?`).run(deviceId);
      return reply.code(409).send({ error: "Agent is not connected" });
    }

    const status = idleSeconds > 180 ? "AWAY" : "ONLINE";
    db.prepare(`
      UPDATE devices
      SET online=1, presence=?, idle_seconds=?, last_seen=?, hostname=?,
          install_percent=100, install_stage='Agent connected', install_updated=?, install_started=0
      WHERE device_id=?
    `).run(
      status,
      idleSeconds,
      Date.now(),
      String(req.body?.hostname || row.hostname).trim() || row.hostname,
      Date.now(),
      deviceId
    );

    return reply.send({ ok: true, status, idleSeconds });
  }
);

app.post<{
  Body: {
    deviceId?: string;
    secret?: string;
    percent?: number;
    stage?: string;
  };
}>(
  "/api/install-progress",
  async (req, reply) => {
    const deviceId = String(req.body?.deviceId || "").trim();
    const secret = String(req.body?.secret || "");
    const percent = Math.max(0, Math.min(100, Math.round(Number(req.body?.percent || 0))));
    const stage = String(req.body?.stage || "").trim().slice(0, 160);

    const row: any = db.prepare("SELECT * FROM devices WHERE device_id=?").get(deviceId);
    if (!row || row.revoked || !secret || sha(secret) !== row.secret_hash) {
      return reply.code(401).send({ error: "Unauthorized" });
    }

    // Once an enrollment has expired into Pending enrollment, freeze its
    // progress. A late-running installer must not move the bar again.
    if (String(row.hostname || '').trim().toLowerCase() === 'pending enrollment') {
      return reply.send({ ok: true, frozen: true });
    }

    db.prepare(`
      UPDATE devices
      SET install_percent=?, install_stage=?, install_updated=?
      WHERE device_id=?
    `).run(percent, stage, Date.now(), deviceId);

    return reply.send({ ok: true });
  }
);

app.post<{
  Body: {
    deviceId?: string;
    secret?: string;
  };
}>(
  "/api/agent/recovery",
  async (req, reply) => {
    const deviceId = String(req.body?.deviceId || "").trim();
    const secret = String(req.body?.secret || "");
    const row: any = db.prepare("SELECT * FROM devices WHERE device_id=?").get(deviceId);

    if (!row || row.revoked || !secret || sha(secret) !== row.secret_hash) {
      return reply.code(401).send({ error: "Unauthorized" });
    }

    const now = Date.now();
    const connected = !!deviceSockets.get(deviceId);
    const stale = !connected && (!row.last_seen || now - Number(row.last_seen) > 20_000);
    const explicitCheck = Number(row.check_requested || 0) === 1;
    const dueForRecovery = stale && (now - Number(row.last_recovery_at || 0) > 120_000);
    const restart = explicitCheck || dueForRecovery;

    if (restart) {
      db.prepare(`
        UPDATE devices
        SET check_requested=0, check_requested_at=0, last_recovery_at=?
        WHERE device_id=?
      `).run(now, deviceId);
    }

    return reply.send({
      ok: true,
      restart,
      reason: explicitCheck ? "TECHNICIAN_CHECK" : (dueForRecovery ? "STALE_AGENT" : "NONE")
    });
  }
);

app.post<{
  Params: { id: string };
  Body: { enabled?: boolean };
}>(
  "/api/devices/:id/maintenance",
  { preHandler: requireTech },
  async (req, reply) => {
    const deviceId = req.params.id;
    const enabled = !!req.body?.enabled;
    const row: any = db.prepare("SELECT device_id, revoked FROM devices WHERE device_id=?").get(deviceId);

    if (!row || row.revoked) {
      return reply.code(404).send({ error: "device not found or revoked" });
    }

    const socket = deviceSockets.get(deviceId);
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return reply.code(409).send({ error: "The Windows agent is offline. Try again later." });
    }

    const confirmation = waitForMaintenanceStatus(deviceId, enabled);
    send(socket, {
      type: enabled ? "MAINTENANCE_START" : "MAINTENANCE_STOP"
    });

    const confirmed = await confirmation;
    if (!confirmed) {
      return reply.code(504).send({
        error: enabled
          ? "The customer PC did not confirm that the Maintenance screen is displaying."
          : "The customer PC did not confirm that Maintenance stopped."
      });
    }

    audit(deviceId, enabled ? "MAINTENANCE_START" : "MAINTENANCE_STOP");
    return reply.send({ ok: true, enabled, confirmed: true });
  }
);

app.post<{ Params: { id: string } }>(
  "/api/devices/:id/remove-tech-mask",
  { preHandler: requireTech },
  async (req, reply) => {
    const deviceId = req.params.id;
    if (!maintenanceDevices.has(deviceId)) return reply.code(409).send({ error: "Maintenance is not active." });
    const socket = deviceSockets.get(deviceId);
    if (!socket || socket.readyState !== WebSocket.OPEN) return reply.code(409).send({ error: "The Windows agent is offline." });
    send(socket, { type: "TECH_MASK_REMOVE" });
    audit(deviceId, "TECH_MASK_REMOVE");
    return reply.send({ ok: true });
  }
);

app.post<{
  Params: { id: string };
}>(
  "/api/devices/:id/check",
  { preHandler: requireTech },
  async (req, reply) => {
    const deviceId = req.params.id;
    const row: any = db.prepare("SELECT device_id, revoked FROM devices WHERE device_id=?").get(deviceId);

    if (!row || row.revoked) {
      return reply.code(404).send({ error: "device not found or revoked" });
    }

    const socket = deviceSockets.get(deviceId);
    const reachable = !!socket;

    // Queue the request even when the socket is currently unavailable. A background
    // recovery task on the enrolled PC will pick it up once Windows has internet
    // access again. The dashboard tells the technician to try again later when the
    // PC is not currently reachable.
    if (socket) {
      try {
        socket.close(4001, "technician check - reconnect");
      } catch {}
      deviceSockets.delete(deviceId);
      endSession(deviceId, "TECHNICIAN_CHECK");
      db.prepare(`UPDATE devices SET online=0, presence='OFFLINE', idle_seconds=0, last_seen=? WHERE device_id=?`).run(Date.now(), deviceId);
    }

    db.prepare(`
      UPDATE devices
      SET check_requested=1, check_requested_at=?
      WHERE device_id=?
    `).run(Date.now(), deviceId);

    audit(deviceId, "TECHNICIAN_CHECK");

    return reply.send({ ok: true, queued: true, reachable });
  }
);

app.get(
  "/api/devices",
  {
    preHandler: requireTech
  },
  async () => {
    expireStaleInstallations();
    return {
      devices:
        db
          .prepare(
            "SELECT * FROM devices ORDER BY created_at DESC"
          )
          .all()
          .map(deviceView)
    };
  }
);

app.patch<{
  Params: {
    id: string;
  };
  Body: {
    name?: string;
  };
}>(
  "/api/devices/:id",
  {
    preHandler: requireTech
  },
  async (req, reply) => {
    const name =
      String(
        req.body?.name || ""
      ).trim();

    if (!name) {
      return reply
        .code(400)
        .send({
          error: "name is required"
        });
    }

    const result =
      db
        .prepare(
          "UPDATE devices SET display_name=? WHERE device_id=?"
        )
        .run(
          name,
          req.params.id
        );

    if (!result.changes) {
      return reply
        .code(404)
        .send({
          error: "device not found"
        });
    }

    audit(
      req.params.id,
      "RENAMED"
    );

    return {
      ok: true
    };
  }
);

app.patch<{
  Params: {
    id: string;
  };
  Body: {
    enabled?: boolean;
  };
}>(
  "/api/devices/:id/control",
  {
    preHandler: requireTech
  },
  async (req, reply) => {
    const enabled =
      req.body?.enabled === true;

    const result =
      db
        .prepare(`
          UPDATE devices
          SET control_allowed=?
          WHERE device_id=?
          AND revoked=0
        `)
        .run(
          enabled ? 1 : 0,
          req.params.id
        );

    if (!result.changes) {
      return reply
        .code(404)
        .send({
          error: "device not found"
        });
    }

    audit(
      req.params.id,
      enabled
        ? "CONTROL_ENABLED"
        : "CONTROL_DISABLED"
    );

    // Changing technician control policy must never end or clear Maintenance.
    // Maintenance state is changed only by the confirmed MAINTENANCE_START/STOP path.

    const session =
      sessions.get(
        req.params.id
      );

    if (session) {
      session.control =
        enabled &&
        session.mode === "control";

      send(
        session.agent,
        {
          type: "CONTROL_POLICY",
          enabled
        }
      );

      if (
        !enabled &&
        session.mode === "control"
      ) {
        send(
          session.agent,
          {
            type: "CLOSE_REMOTE"
          }
        );
      }
    }

    return {
      ok: true,
      enabled
    };
  }
);

app.post<{
  Params: {
    id: string;
  };
}>(
  "/api/devices/:id/revoke",
  {
    preHandler: requireTech
  },
  async (req, reply) => {
    const result =
      db
        .prepare(`
          UPDATE devices
          SET
            control_allowed=0,
            revoked=1
          WHERE device_id=?
        `)
        .run(
          req.params.id
        );

    if (!result.changes) {
      return reply
        .code(404)
        .send({
          error: "device not found"
        });
    }

    const session =
      sessions.get(
        req.params.id
      );

    if (session) {
      endSession(
        req.params.id,
        "REVOKED"
      );
    }

    const socket =
      deviceSockets.get(
        req.params.id
      );

    if (socket) {
      send(
        socket,
        {
          type: "REVOKE"
        }
      );
    }

    audit(
      req.params.id,
      "REVOKED"
    );

    return {
      ok: true
    };
  }
);

/* =========================================================
   DELETE DEVICE
   ========================================================= */

app.delete<{
  Params: {
    id: string;
  };
}>(
  "/api/devices/:id",
  {
    preHandler: requireTech
  },
  async (req, reply) => {
    const deviceId = req.params.id;
    maintenanceDevices.delete(deviceId);

    const existing: any =
      db
        .prepare(
          "SELECT device_id FROM devices WHERE device_id=?"
        )
        .get(deviceId);

    if (!existing) {
      return reply
        .code(404)
        .send({
          error: "device not found"
        });
    }

    const session = sessions.get(deviceId);
    if (session) {
      endSession(
        deviceId,
        "DELETED"
      );
    }

    const pending = pendingSessions.get(deviceId);
    if (pending) {
      pendingSessions.delete(deviceId);
    }

    const socket = deviceSockets.get(deviceId);
    if (socket) {
      send(
        socket,
        {
          type: "REVOKE"
        }
      );
      try {
        socket.close(1008, "device deleted");
      } catch {}
      deviceSockets.delete(deviceId);
    }

    db.prepare(
      "DELETE FROM installer_tokens WHERE device_id=?"
    ).run(deviceId);

    db.prepare(
      "DELETE FROM audit WHERE device_id=?"
    ).run(deviceId);

    const result =
      db
        .prepare(
          "DELETE FROM devices WHERE device_id=?"
        )
        .run(deviceId);

    if (!result.changes) {
      return reply
        .code(404)
        .send({
          error: "device not found"
        });
    }

    return {
      ok: true
    };
  }
);

/* =========================================================
   WEBSOCKET
   ========================================================= */

const wss =
  new WebSocketServer({
    noServer: true,
    clientTracking: true,
    perMessageDeflate: false
  });

wss.on("error", error => {
  app.log.error(error, "WebSocket server error");
});

type Session = {
  tech: WebSocket;
  agent: WebSocket;
  mode: "view" | "control";
  control: boolean;
};

const deviceSockets =
  new Map<string, WebSocket>();

const techSockets =
  new Set<WebSocket>();

const sessions =
  new Map<string, Session>();

type PendingSession = {
  tech: WebSocket;
  mode: "view" | "control";
  requestedAt: number;
};

/*
 * A technician can request a remote session while the agent is
 * temporarily disconnected.  The request is held until that same
 * device reconnects to this server process.  This does NOT make a
 * truly powered-off/unreachable PC controllable; it makes the
 * session survive a temporary agent disconnect without forcing the
 * technician to click View/Control again.
 */
const pendingSessions =
  new Map<string, PendingSession>();

// Maintenance is an ephemeral control state; the agent itself owns the GUI/input lock.
const maintenanceDevices = new Set<string>();
const maintenanceWaiters = new Map<string, { expected: boolean; resolve: (ok: boolean) => void; timer: NodeJS.Timeout }>();

function waitForMaintenanceStatus(deviceId: string, expected: boolean, timeoutMs = 7000): Promise<boolean> {
  const old = maintenanceWaiters.get(deviceId);
  if (old) { clearTimeout(old.timer); old.resolve(false); }
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      if (maintenanceWaiters.get(deviceId)?.timer === timer) maintenanceWaiters.delete(deviceId);
      resolve(false);
    }, timeoutMs);
    maintenanceWaiters.set(deviceId, { expected, resolve, timer });
  });
}

function confirmMaintenanceStatus(deviceId: string, displaying: boolean) {
  if (displaying) maintenanceDevices.add(deviceId); else maintenanceDevices.delete(deviceId);
  const waiter = maintenanceWaiters.get(deviceId);
  if (waiter && waiter.expected === displaying) {
    clearTimeout(waiter.timer);
    maintenanceWaiters.delete(deviceId);
    waiter.resolve(true);
  }
}

function endSession(
  deviceId: string,
  reason = "SESSION_CLOSED"
) {
  const session =
    sessions.get(deviceId);

  if (!session) {
    return;
  }

  sessions.delete(deviceId);

  /* Keep an active technician request alive across a temporary agent
   * disconnect. When the same device reconnects, startSession() resumes it. */
  if (
    reason === "AGENT_DISCONNECTED" &&
    session.tech.readyState === WebSocket.OPEN
  ) {
    pendingSessions.set(deviceId, {
      tech: session.tech,
      mode: session.mode,
      requestedAt: Date.now()
    });

    send(session.tech, {
      type: "SESSION_WAITING",
      deviceId,
      mode: session.mode,
      message: "The Windows agent disconnected. The session will resume automatically when it reconnects."
    });

    audit(deviceId, "REMOTE_SESSION_WAITING");
    return;
  }

  send(
    session.agent,
    {
      type: "CLOSE_REMOTE"
    }
  );

  send(
    session.tech,
    {
      type: reason,
      deviceId
    }
  );

  audit(
    deviceId,
    reason
  );
}

function startSession(
  deviceId: string,
  tech: WebSocket,
  agent: WebSocket,
  mode: "view" | "control",
  row: any
) {
  endSession(
    deviceId,
    "SESSION_REPLACED"
  );

  const session: Session = {
    tech,
    agent,
    mode,
    control:
      mode === "control" &&
      !!row.control_allowed
  };

  sessions.set(
    deviceId,
    session
  );

  pendingSessions.delete(deviceId);

  send(
    agent,
    {
      type:
        mode === "control"
          ? "OPEN_CONTROL"
          : "OPEN_VIEW"
    }
  );

  send(
    tech,
    {
      type: "SESSION_STARTED",
      deviceId,
      mode
    }
  );

  audit(
    deviceId,
    mode === "control"
      ? "CONTROL_OPEN"
      : "VIEW_OPEN"
  );
}

/* =========================================================
   HTTP -> WEBSOCKET UPGRADE
   ========================================================= */

app.server.on(
  "upgrade",
  (req, socket, head) => {
    try {
      const parsedUrl =
        new URL(
          req.url || "/",
          "http://localhost"
        );

      const pathname = parsedUrl.pathname;

      app.log.info({
        pathname,
        host: req.headers.host,
        upgrade: req.headers.upgrade
      }, "WebSocket upgrade requested");

      if (
        !pathname.startsWith("/ws/")
      ) {
        socket.destroy();
        return;
      }

      wss.handleUpgrade(
        req,
        socket,
        head,
        ws => {
          app.log.info({ pathname }, "WebSocket upgrade accepted");
          wss.emit(
            "connection",
            ws,
            req
          );
        }
      );
    } catch {
      socket.destroy();
    }
  }
);

/* =========================================================
   WEBSOCKET CONNECTIONS
   ========================================================= */

wss.on(
  "connection",
  (ws, req) => {
    const url =
      new URL(
        req.url || "/",
        "http://localhost"
      );

    const parts =
      url.pathname
        .split("/")
        .filter(Boolean);

    /*
     * Windows agent.
     */
    if (
      parts[0] === "ws" &&
      parts[1] === "device" &&
      parts[2]
    ) {
      const deviceId =
        parts[2];

      let row: any =
        db
          .prepare(
            "SELECT * FROM devices WHERE device_id=?"
          )
          .get(deviceId);

      if (
        !row ||
        row.revoked
      ) {
        ws.close(
          1008,
          "unknown or revoked device"
        );
        return;
      }

      ws.once(
        "message",
        raw => {
          try {
            const message =
              JSON.parse(
                raw.toString()
              );

            if (
              message.type !== "AUTH" ||
              sha(
                String(
                  message.secret || ""
                )
              ) !==
                row.secret_hash
            ) {
              ws.close(
                1008,
                "unauthorized"
              );
              return;
            }

            row =
              db
                .prepare(
                  "SELECT * FROM devices WHERE device_id=?"
                )
                .get(deviceId);

            if (
              !row ||
              row.revoked
            ) {
              ws.close(
                1008,
                "revoked"
              );
              return;
            }

            const old =
              deviceSockets.get(
                deviceId
              );

            if (
              old &&
              old !== ws
            ) {
              old.close(
                4000,
                "replaced"
              );
            }

            deviceSockets.set(
              deviceId,
              ws
            );

            const hostname =
              String(
                message.hostname || ""
              ).trim() ||
              row.hostname;

            db.prepare(`
              UPDATE devices
              SET
                online=1,
                presence='ONLINE',
                idle_seconds=0,
                last_seen=?,
                hostname=?,
                install_percent=100,
                install_stage='Agent connected',
                install_updated=?,
                install_started=0
              WHERE device_id=?
            `).run(
              Date.now(),
              hostname,
              Date.now(),
              deviceId
            );

            audit(
              deviceId,
              "AGENT_ONLINE"
            );

            send(
              ws,
              {
                type: "AUTH_OK",
                deviceId,
                controlAllowed:
                  !!row.control_allowed
              }
            );

            /*
             * Resume a technician request that was waiting while
             * this device was temporarily offline.
             */
            const pending =
              pendingSessions.get(deviceId);

            if (
              pending &&
              pending.tech.readyState === WebSocket.OPEN
            ) {
              startSession(
                deviceId,
                pending.tech,
                ws,
                pending.mode,
                row
              );
            } else if (pending) {
              pendingSessions.delete(deviceId);
            }

            ws.on(
              "message",
              (data, isBinary) => {
                db.prepare(`
                  UPDATE devices
                  SET
                    online=1,
                    last_seen=?
                  WHERE device_id=?
                `).run(
                  Date.now(),
                  deviceId
                );

                // The ws package commonly delivers TEXT frames as Buffer objects too.
                // Use the frame's isBinary flag so agent JSON status messages (including
                // MAINTENANCE_STATUS) are parsed instead of being mistaken for screen frames.
                if (isBinary) {
                  const session =
                    sessions.get(
                      deviceId
                    );

                  if (
                    session &&
                    session.agent === ws &&
                    session.tech.readyState ===
                      WebSocket.OPEN
                  ) {
                    session.tech.send(
                      data
                    );
                  }

                  return;
                }

                try {
                  const message =
                    JSON.parse(
                      data.toString()
                    );

                  if (
                    message.type ===
                    "HEARTBEAT"
                  ) {
                    send(
                      ws,
                      {
                        type:
                          "HEARTBEAT_OK",
                        ts:
                          Date.now()
                      }
                    );
                  }
                  else if (message.type === "MAINTENANCE_STATUS") {
                    confirmMaintenanceStatus(deviceId, !!message.displaying);
                  }
                } catch {
                  // Ignore malformed agent messages.
                }
              }
            );
          } catch {
            ws.close(
              1008,
              "bad auth"
            );
          }
        }
      );

      ws.on(
        "close",
        () => {
          const isCurrentSocket =
            deviceSockets.get(deviceId) === ws;

          /*
           * A replaced/stale socket must never tear down the new
           * connection or its active remote session.
           */
          if (!isCurrentSocket) {
            return;
          }

          deviceSockets.delete(
            deviceId
          );
          maintenanceDevices.delete(deviceId);

          endSession(
            deviceId,
            "AGENT_DISCONNECTED"
          );

          db.prepare(`
            UPDATE devices
            SET
              online=0,
              last_seen=?
            WHERE device_id=?
          `).run(
            Date.now(),
            deviceId
          );

          audit(
            deviceId,
            "AGENT_OFFLINE"
          );
        }
      );

      return;
    }

    /*
     * Technician dashboard.
     */
    if (
      parts[0] === "ws" &&
      parts[1] === "technician"
    ) {
      let authenticated = false;

      const authTimeout = setTimeout(() => {
        if (!authenticated) {
          app.log.warn("Technician WebSocket authentication timed out");
          try {
            ws.close(1008, "authentication required");
          } catch {}
        }
      }, 10000);

      ws.on(
        "message",
        raw => {
          try {
            const message =
              JSON.parse(
                raw.toString()
              );

            if (!authenticated) {
              if (
                message.type !== "AUTH" ||
                String(message.token || "") !== TECHNICIAN_TOKEN
              ) {
                app.log.warn("Technician WebSocket authentication failed");
                try {
                  ws.close(1008, "unauthorized");
                } catch {}
                return;
              }

              authenticated = true;
              clearTimeout(authTimeout);
              techSockets.add(ws);

              app.log.info("Technician WebSocket authenticated");

              send(ws, { type: "TECH_OK" });
              return;
            }

            const deviceId =
              String(
                message.deviceId || ""
              );

            const row: any =
              db
                .prepare(
                  "SELECT * FROM devices WHERE device_id=?"
                )
                .get(deviceId);

            if (
              !row ||
              row.revoked
            ) {
              send(
                ws,
                {
                  type: "ERROR",
                  message:
                    "Device not found or revoked."
                }
              );

              return;
            }

            /*
             * Open view/control session.
             */
            if (
              message.type ===
                "OPEN_VIEW" ||
              message.type ===
                "OPEN_CONTROL"
            ) {
              const agent =
                deviceSockets.get(
                  deviceId
                );

              const requestedMode =
                message.type === "OPEN_CONTROL"
                  ? "control"
                  : "view";

              if (
                message.type ===
                  "OPEN_CONTROL" &&
                !row.control_allowed
              ) {
                send(
                  ws,
                  {
                    type: "ERROR",
                    message:
                      "Remote control is disabled for this device."
                  }
                );

                return;
              }

              if (!agent) {
                pendingSessions.set(
                  deviceId,
                  {
                    tech: ws,
                    mode: requestedMode,
                    requestedAt: Date.now()
                  }
                );

                send(
                  ws,
                  {
                    type: "SESSION_WAITING",
                    deviceId,
                    mode: requestedMode,
                    message:
                      "The Windows agent is temporarily offline. The session will start automatically when it reconnects."
                  }
                );

                audit(
                  deviceId,
                  "REMOTE_SESSION_WAITING"
                );

                return;
              }

              startSession(
                deviceId,
                ws,
                agent,
                requestedMode,
                row
              );

              return;
            }

            /*
             * Input forwarding.
             */
            const session =
              sessions.get(
                deviceId
              );

            if (
              !session ||
              session.tech !== ws
            ) {
              return;
            }

            const controlRow = db
              .prepare(
                "SELECT control_allowed FROM devices WHERE device_id=? AND revoked=0"
              )
              .get(deviceId) as
              | { control_allowed?: number }
              | undefined;

            const currentControlAllowed =
              !!controlRow?.control_allowed;

            if (
              message.type ===
                "INPUT" &&
              session.control &&
              currentControlAllowed
            ) {
              send(
                session.agent,
                {
                  type: "INPUT",
                  input:
                    message.input
                }
              );
            }

            /*
             * Close session.
             */
            if (
              message.type ===
              "CLOSE"
            ) {
              endSession(
                deviceId
              );
            }
          } catch {
            // Ignore malformed technician messages.
          }
        }
      );

      ws.on(
        "close",
        () => {
          clearTimeout(authTimeout);

          for (
            const [
              deviceId,
              session
            ] of sessions
          ) {
            if (
              session.tech === ws
            ) {
              endSession(
                deviceId,
                "TECHNICIAN_DISCONNECTED"
              );
            }
          }

          for (
            const [
              deviceId,
              pending
            ] of pendingSessions
          ) {
            if (pending.tech === ws) {
              pendingSessions.delete(deviceId);
            }
          }

          techSockets.delete(ws);
        }
      );

      return;
    }

    ws.close(
      1008,
      "unknown websocket endpoint"
    );
  }
);

/* =========================================================
   CLEANUP
   ========================================================= */

setInterval(
  () => {
    const cutoff =
      Date.now() - 15_000;

    // Release stale agent sockets before marking devices offline.
    // The existing V36 agent has its own reconnect loop; removing the dead
    // server-side socket lets a fresh connection authenticate normally.
    const staleDevices = db
      .prepare(`
        SELECT device_id
        FROM devices
        WHERE online=1
        AND last_seen<?
      `)
      .all(cutoff) as { device_id: string }[];

    for (const stale of staleDevices) {
      const staleSocket = deviceSockets.get(stale.device_id);
      if (staleSocket) {
        deviceSockets.delete(stale.device_id);
        endSession(stale.device_id, "AGENT_STALE");
        try {
          staleSocket.close(4001, "stale connection - reconnect");
        } catch {}
      }
    }

    db.prepare(`
      UPDATE devices
      SET online=0, presence='OFFLINE', idle_seconds=0
      WHERE online=1
      AND last_seen<?
    `).run(cutoff);

    db.prepare(`
      DELETE FROM installer_tokens
      WHERE expires_at<?
      OR used=1
    `).run(
      Date.now() -
        24 * 60 * 60 * 1000
    );

    const pendingCutoff =
      Date.now() -
      10 * 60 * 1000;

    for (
      const [
        deviceId,
        pending
      ] of pendingSessions
    ) {
      if (
        pending.requestedAt < pendingCutoff ||
        pending.tech.readyState !== WebSocket.OPEN
      ) {
        pendingSessions.delete(deviceId);
      }
    }

  },
  5_000
);

/* =========================================================
   CUSTOMER PAGE
   ========================================================= */

function customerHtml(
  downloadPath: string
) {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">

<title>Remote Support</title>

<style>
html,
body{
  margin:0;
  width:100%;
  height:100%;
}

body{
  display:flex;
  align-items:center;
  justify-content:center;
  background:#f4f7fb;
  font-family:Arial,sans-serif;
}

.download{
  display:inline-flex;
  align-items:center;
  justify-content:center;
  min-width:180px;
  height:58px;
  padding:0 30px;
  box-sizing:border-box;
  border-radius:10px;
  background:#1264d8;
  color:white;
  text-decoration:none;
  font-size:18px;
  font-weight:700;
  cursor:pointer;
  border:0;
}

.download:hover{
  background:#0d56bd;
}
</style>
</head>

<body>

<a
  class="download"
  href="${downloadPath}"
>
  DOWNLOAD
</a>

</body>
</html>`;
}

function notFoundHtml(
  message: string
) {
  return `<!doctype html>
<html>
<body
  style="font-family:Arial;padding:40px"
>
<h1>Remote Support</h1>
<p>
${escapeHtml(message)}
</p>
</body>
</html>`;
}

function escapeHtml(
  value: string
) {
  return String(value).replace(
    /[&<>"']/g,
    character =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
      }[
        character
      ] as string)
  );
}

/* =========================================================
   TECHNICIAN DASHBOARD HTML
   ========================================================= */

const INDEX_HTML = `<!doctype html>
<html>

<head>

<meta charset="utf-8">

<meta
  name="viewport"
  content="width=device-width,initial-scale=1"
>

<title>
Remote Support Technician
</title>

<style>

*{
  box-sizing:border-box;
}

html,
body{
  margin:0;
  min-height:100%;
}

body{
  background:#f3f6fa;
  font-family:
    Arial,
    Helvetica,
    sans-serif;
  color:#17202a;
}

.wrap{
  width:100%;
  max-width:none;
  margin:0;
  padding:20px 24px;
  min-width:0;
}

.top{
  display:flex;
  justify-content:space-between;
  align-items:center;
  gap:20px;
}

.card{
  background:#fff;
  border:1px solid #e2e8f0;
  border-radius:14px;
  padding:18px;
  margin:14px 0;
  box-shadow:
    0 4px 18px
    rgba(0,0,0,.04);
}

.row{
  display:flex;
  gap:8px;
  flex-wrap:wrap;
  align-items:center;
}

.muted{
  color:#667085;
  font-size:13px;
}

.online{
  color:#07883b;
  font-weight:700;
}

.offline{
  color:#777;
}

.away{
  color:#b26a00;
  font-weight:700;
}

.btn{
  border:0;
  border-radius:8px;
  padding:10px 14px;
  font-weight:700;
  cursor:pointer;
}

.btn:disabled{
  opacity:.6;
  cursor:not-allowed;
}

.primary{
  background:#1264d8;
  color:#fff;
}

.dark{
  background:#1f2937;
  color:#fff;
}

.light{
  background:#e9eef5;
  color:#17202a;
}

.danger{
  background:#c62828;
  color:#fff;
}

.device{
  padding:14px;
  border:1px solid #e3e8ef;
  border-radius:10px;
  margin:10px 0;
}
.install-progress{
  margin-top:10px;
  padding:10px 12px;
  background:#f7f9fc;
  border:1px solid #e3e8ef;
  border-radius:8px;
}
.install-progress-row{
  display:flex;
  justify-content:space-between;
  gap:12px;
  font-size:13px;
  margin-bottom:6px;
}
.install-progress-track{
  width:100%;
  height:8px;
  background:#e3e8ef;
  border-radius:999px;
  overflow:hidden;
}
.install-progress-bar{
  height:100%;
  background:#1264d8;
  transition:width .3s ease;
}

.uid{
  font-family:monospace;
  background:#eef2f7;
  padding:3px 6px;
  border-radius:5px;
}

.viewer{
  margin-top:16px;
  background:#111;
  border-radius:12px;
  padding:12px;
  display:none;
  width:100%;
  min-width:0;
  height:auto;
  min-height:0;
}

.viewer-screen-wrap{
  position:relative;
  width:100%;
  height:auto;
  min-height:0;
  aspect-ratio:16 / 9;
  background:#000;
  border-radius:8px;
  overflow:hidden;
  display:flex;
  align-items:center;
  justify-content:center;
  min-width:0;
}

.viewer canvas{
  display:block;
  width:100%;
  height:auto;
  min-width:0;
  min-height:0;
  max-width:100%;
  max-height:100%;
  object-fit:contain;
  transform:scale(1);
  transform-origin:center center;
  flex:0 0 auto;
  cursor:crosshair;
}

.notice{
  padding:12px;
  border-radius:8px;
  background:#fff7df;
}

.modal{
  position:fixed;
  inset:0;
  background:rgba(0,0,0,.68);

  /*
   * IMPORTANT:
   * Login is visible by default.
   * JavaScript hides it only after successful authentication.
   */
  display:flex;

  align-items:center;
  justify-content:center;

  z-index:9999;
}

.modalbox{
  background:#fff;
  padding:30px;
  border-radius:16px;
  width:90%;
  max-width:430px;

  box-shadow:
    0 20px 60px
    rgba(0,0,0,.25);
}

.modalbox h2{
  margin-top:0;
  font-size:25px;
}

.modalbox p{
  color:#667085;
  line-height:1.5;
}

.token-input{
  width:100%;
  box-sizing:border-box;
  padding:13px;
  border:1px solid #ccd5df;
  border-radius:8px;
  font-size:15px;
  margin:10px 0;
}

.token-input:focus{
  outline:none;
  border-color:#1264d8;
  box-shadow:
    0 0 0 3px
    rgba(18,100,216,.12);
}

.error{
  color:#c62828;
  font-size:14px;
  min-height:20px;
  margin-bottom:8px;
}

.status{
  margin-top:8px;
  color:#667085;
  font-size:13px;
}

#dashboard{
  display:none;
}

.empty{
  padding:25px;
  text-align:center;
  color:#667085;
}

@media(max-width:700px){

  .wrap{
    padding:16px;
  }

  .top{
    align-items:flex-start;
    flex-direction:column;
  }

  .top .btn{
    width:100%;
  }

}

</style>

</head>

<body>

<!-- =====================================================
     LOGIN MODAL
     ===================================================== -->

<div
  id="loginModal"
  class="modal"
  role="dialog"
  aria-modal="true"
  aria-labelledby="loginTitle"
>

  <div class="modalbox">

    <h2 id="loginTitle">
      Technician Login
    </h2>

    <p>
      Enter your technician token to access
      the Remote Support Technician dashboard.
    </p>

    <input
      id="loginToken"
      class="token-input"
      type="password"
      autocomplete="off"
      spellcheck="false"
      placeholder="Technician token"
    >

    <div
      id="loginError"
      class="error"
    ></div>

    <button
      id="loginButton"
      class="btn primary"
      onclick="loginTechnician()"
    >
      Continue
    </button>

    <div
      id="loginStatus"
      class="status"
    ></div>

  </div>

</div>

<!-- =====================================================
     DASHBOARD
     ===================================================== -->

<div id="dashboard">

  <div class="wrap">

    <div class="top">

      <div>

        <h1>
          Remote Support Technician
        </h1>

        <div class="muted">
          Authorized enrolled Windows devices
        </div>

      </div>

      <div class="row" style="margin-left:auto;gap:10px;align-items:end;flex-wrap:wrap">

        <div>
          <label for="installerFilename" style="display:block;font-weight:700;margin-bottom:5px">
            Customer installer file name
          </label>
          <input
            id="installerFilename"
            type="text"
            value="RemoteSupport-Installer.bat"
            maxlength="120"
            style="padding:9px 12px;border:1px solid #d5dce5;border-radius:8px;min-width:250px"
            onkeydown="if(event.key==='Enter') copyCustomerLink()"
          >
        </div>

        <button
          class="btn primary"
          onclick="copyCustomerLink()"
        >
          Copy Customer Install Link
        </button>

      </div>

    </div>

    <div
      class="row"
      style="margin:14px 0 8px"
    >

      <label
        for="enrollmentFilter"
        style="font-weight:700"
      >
        Filter PCs:
      </label>

      <select
        id="enrollmentFilter"
        onchange="setEnrollmentFilter(this.value)"
        style="padding:9px 12px;border:1px solid #d5dce5;border-radius:8px;background:#fff;color:#17202a"
      >
        <option value="all">All PCs</option>
        <option value="pending">Pending Enrollment</option>
        <option value="enrolled">Fully Enrolled PCs</option>
      </select>

    </div>

    <div
      id="list"
      class="card"
    >
      Loading...
    </div>

    <!-- =================================================
         REMOTE VIEWER
         ================================================= -->

    <div
      id="viewer"
      class="viewer"
    >

      <div
        class="row"
        style="color:white;margin-bottom:10px"
      >

        <div>
          <b id="viewerTitle">
            Remote desktop
          </b>
          <div
            id="viewerStatus"
            class="muted"
            style="color:#ddd;margin-top:4px"
          ></div>
        </div>

        <div class="row" style="margin-left:auto">

          <button
            class="btn light"
            onclick="zoomViewer(-1)"
            title="Zoom out"
            aria-label="Zoom out"
          >
            −
          </button>

          <button
            class="btn light"
            onclick="zoomViewer(1)"
            title="Zoom in"
            aria-label="Zoom in"
          >
            +
          </button>

          <button
            class="btn light"
            onclick="openFullScreen()"
          >
            View full screen
          </button>

          <button
            class="btn light"
            onclick="closeRemote()"
          >
            Close
          </button>

        </div>

      </div>

      <div class="viewer-screen-wrap">
        <canvas
          id="screen"
          width="1920"
          height="1080"
          aria-label="Remote desktop"
        ></canvas>
      </div>

    </div>

  </div>

</div>

<script>

/* =====================================================
   STATE
   ===================================================== */

let token = '';
let ws = null;
let active = null;
let mode = null;

let reconnectTimer = null;
let reconnecting = false;
let connectPromise = null;
let fullScreenWindow = null;
let frameSequence = 0;
let viewerZoom = 1;
let enrollmentFilter = 'all';

/* =====================================================
   AUTH HEADERS
   ===================================================== */

function authHeaders(){

  return {
    'Content-Type':
      'application/json',

    'Authorization':
      'Bearer ' + token
  };

}

/* =====================================================
   LOGIN
   ===================================================== */

async function loginTechnician(){

  const input =
    document.getElementById(
      'loginToken'
    );

  const error =
    document.getElementById(
      'loginError'
    );

  const status =
    document.getElementById(
      'loginStatus'
    );

  const button =
    document.getElementById(
      'loginButton'
    );

  const entered =
    input.value.trim();

  error.textContent = '';
  status.textContent = '';

  if(!entered){

    error.textContent =
      'Please enter your technician token.';

    input.focus();

    return;
  }

  button.disabled = true;
  button.textContent =
    'Verifying...';

  status.textContent =
    'Contacting server...';

  try{

    const response =
      await fetch(
        '/api/devices',
        {
          method:'GET',
          headers:{
            'Authorization':
              'Bearer ' + entered
          },
          cache:'no-store'
        }
      );

    if(response.status === 401){

      error.textContent =
        'Invalid technician token.';

      status.textContent = '';

      input.select();

      button.disabled = false;
      button.textContent =
        'Continue';

      return;
    }

    if(!response.ok){

      error.textContent =
        'Unable to verify technician token.';

      status.textContent =
        'Server returned HTTP ' +
        response.status + '.';

      button.disabled = false;
      button.textContent =
        'Continue';

      return;
    }

    /*
     * Authentication succeeded.
     */

    token = entered;

    localStorage.setItem(
      'techToken',
      token
    );

    error.textContent = '';
    status.textContent = '';

    document
      .getElementById('loginModal')
      .style.display = 'none';

    document
      .getElementById('dashboard')
      .style.display = 'block';

    await load();

    await connect();

  }catch(errorObject){

    console.error(
      'Technician login failed:',
      errorObject
    );

    error.textContent =
      'Unable to connect to the Remote Support server.';

    status.textContent =
      'Check the server URL and your network connection.';

  }finally{

    button.disabled = false;
    button.textContent =
      'Continue';

  }

}

/* =====================================================
   INITIALIZATION
   ===================================================== */

async function initialize(){

  const loginModal =
    document.getElementById(
      'loginModal'
    );

  const dashboard =
    document.getElementById(
      'dashboard'
    );

  const input =
    document.getElementById(
      'loginToken'
    );

  /*
   * IMPORTANT:
   * Always establish a known initial state.
   */

  loginModal.style.display =
    'flex';

  dashboard.style.display =
    'none';

  const savedToken =
    localStorage.getItem(
      'techToken'
    ) || '';

  /*
   * No saved token.
   * Show login immediately.
   */

  if(!savedToken){

    input.focus();

    return;
  }

  /*
   * Validate saved token.
   */

  try{

    const response =
      await fetch(
        '/api/devices',
        {
          method:'GET',
          headers:{
            'Authorization':
              'Bearer ' + savedToken
          },
          cache:'no-store'
        }
      );

    if(!response.ok){

      localStorage.removeItem(
        'techToken'
      );

      input.focus();

      return;
    }

    /*
     * Saved token is valid.
     */

    token = savedToken;

    loginModal.style.display =
      'none';

    dashboard.style.display =
      'block';

    await load();

    await connect();

  }catch(errorObject){

    console.error(
      'Saved-token initialization failed:',
      errorObject
    );

    token = '';

    localStorage.removeItem(
      'techToken'
    );

    loginModal.style.display =
      'flex';

    dashboard.style.display =
      'none';

    input.focus();

  }

}

/* =====================================================
   LOAD DEVICES
   ===================================================== */

async function load(){

  if(!token){
    return;
  }

  try{

    const response =
      await fetch(
        '/api/devices',
        {
          method:'GET',
          headers:authHeaders(),
          cache:'no-store'
        }
      );

    if(response.status === 401){

      logoutTechnician();

      return;
    }

    if(!response.ok){

      throw new Error(
        'HTTP ' + response.status
      );

    }

    const data =
      await response.json();

    const list =
      document.getElementById(
        'list'
      );

    if(
      !data.devices ||
      !data.devices.length
    ){

      list.innerHTML =
        '<div class="empty">' +
        'No enrolled PCs yet.' +
        '</div>';

      return;
    }

    const filteredDevices =
      data.devices.filter(
        function(device){

          if(enrollmentFilter === 'pending'){
            return String(device.hostname || '').trim().toLowerCase() === 'pending enrollment';
          }

          if(enrollmentFilter === 'enrolled'){
            return String(device.hostname || '').trim().toLowerCase() !== 'pending enrollment';
          }

          return true;

        }
      );

    if(!filteredDevices.length){

      list.innerHTML =
        '<div class="empty">' +
        'No PCs match this filter.' +
        '</div>';

      return;
    }

    list.innerHTML =
      filteredDevices
        .map(
          deviceHtml
        )
        .join('');

  }catch(errorObject){

    console.error(
      'Device load failed:',
      errorObject
    );

    document.getElementById(
      'list'
    ).innerHTML =
      '<div class="notice">' +
      'Server connection failed. ' +
      'Retrying automatically...' +
      '</div>';

  }

}

/* =====================================================
   DEVICE HTML
   ===================================================== */

async function setMaintenance(deviceId, enabled){

  if(!deviceId || !token){
    return;
  }

  try{
    const response = await fetch(
      '/api/devices/' + encodeURIComponent(deviceId) + '/maintenance',
      {
        method:'POST',
        headers:authHeaders(),
        body:JSON.stringify({enabled:!!enabled})
      }
    );

    if(response.status === 401){
      logoutTechnician();
      return;
    }

    const data = await response.json().catch(function(){ return {}; });

    if(!response.ok){
      alert(data.error || 'Unable to change maintenance mode.');
      return;
    }

    await load();
  }catch(errorObject){
    console.error('Maintenance command failed:', errorObject);
    alert('Unable to contact the server.');
  }

}

async function removeTechMask(deviceId){
  if(!deviceId || !token) return;
  try{
    const response = await fetch('/api/devices/' + encodeURIComponent(deviceId) + '/remove-tech-mask', { method:'POST', headers:authHeaders(), body:JSON.stringify({}) });
    if(response.status === 401){ logoutTechnician(); return; }
    const data = await response.json().catch(function(){ return {}; });
    if(!response.ok){ alert(data.error || 'Unable to remove technician mask.'); }
  }catch(errorObject){
    console.error('Remove technician mask failed:', errorObject);
    alert('Unable to contact the server.');
  }
}

async function checkDevice(deviceId){

  if(!deviceId || !token){
    return;
  }

  try{
    const response = await fetch(
      '/api/devices/' + encodeURIComponent(deviceId) + '/check',
      {
        method:'POST',
        headers:{
          'Authorization':'Bearer ' + token
        },
        cache:'no-store'
      }
    );

    if(response.status === 401){
      logoutTechnician();
      return;
    }

    const data = await response.json().catch(function(){ return {}; });

    if(!response.ok){
      alert(data.error || 'Unable to check this PC.');
      return;
    }

    if(data.reachable === false){
      alert('TRY AGAIN LATER');
    }

    await load();

  }catch(errorObject){
    console.error('PC check failed:', errorObject);
    alert('Unable to contact the server.');
  }

}

function setEnrollmentFilter(value){

  enrollmentFilter =
    value === 'pending' || value === 'enrolled'
      ? value
      : 'all';

  load();

}

function deviceHtml(x){

  return (

    '<div class="device">' +

      '<div class="row">' +

        '<b>' +
          esc(x.name) +
        '</b>' +

        '<span class="' +
          (
            x.status === 'ONLINE'
              ? 'online'
              : x.status === 'AWAY'
                ? 'away'
                : 'offline'
          ) +
        '">' +

          esc(x.status || (x.online ? 'ONLINE' : 'OFFLINE')) +

        '</span>' +

        '<span class="uid">' +
          'UID ' +
          esc(x.uid) +
        '</span>' +

        (
          x.revoked
            ? '<span class="offline">' +
                'REVOKED' +
              '</span>'
            : ''
        ) +

        (
          x.maintenance
            ? '<span class="online">Maintenance screen displaying</span>'
            : ''
        ) +

      '</div>' +

      '<div class="muted">' +

        'Windows computer: ' +

        esc(
          x.hostname ||
          'Pending enrollment'
        ) +

        ' · Last seen: ' +

        (
          x.lastSeen
            ? new Date(
                x.lastSeen
              ).toLocaleString()
            : 'never'
        ) +

      '</div>' +

      (
        x.installProgress &&
        Number(x.installProgress.percent || 0) < 100 &&
        (Number(x.installProgress.percent || 0) > 0 || x.installProgress.stage)
          ? '<div class="install-progress">' +
              '<div class="install-progress-row">' +
                '<b>Installation</b>' +
                '<span>' + esc(String(Number(x.installProgress.percent || 0))) + '%</span>' +
              '</div>' +
              '<div class="install-progress-track">' +
                '<div class="install-progress-bar" style="width:' +
                  Math.max(0, Math.min(100, Number(x.installProgress.percent || 0))) +
                  '%"></div>' +
              '</div>' +
              '<div class="muted" style="margin-top:6px">' +
                esc(x.installProgress.stage || 'Preparing installation...') +
              '</div>' +
            '</div>'
          : ''
      ) +

      '<div class="row" ' +
        'style="margin-top:10px">' +

        '<button ' +
          'class="btn light" ' +
          'onclick="checkDevice(' +
          "'" +
          escJs(x.deviceId) +
          "'" +
          ')">' +
          'CHECK' +
        '</button>' +

        '<button ' +
          'class="btn primary" ' +
          'onclick="openRemote(' +
          "'" +
          escJs(x.deviceId) +
          "',false)" +
          '"' +
          '>' +

          'View Desktop' +

        '</button>' +

        '<button ' +
          'class="btn dark" ' +
          (
            x.revoked
              ? 'disabled '
              : ''
          ) +
          'onclick="openRemote(' +
          "'" +
          escJs(x.deviceId) +
          "',true)" +
          '"' +
          '>' +

          'Control PC' +

        '</button>' +

        '<button ' +
          'class="btn ' +
          (
            x.maintenance
              ? 'danger'
              : 'light'
          ) +
          '" ' +
          (
            x.revoked || x.status === 'OFFLINE'
              ? 'disabled '
              : ''
          ) +
          'onclick="setMaintenance(' +
          "'" +
          escJs(x.deviceId) +
          "'," +
          (!x.maintenance) +
          ')">' +
          (
            x.maintenance
              ? 'Stop maintenance'
              : 'Maintenance'
          ) +
        '</button>' +

        (x.maintenance
          ? '<button class="btn light" onclick="removeTechMask(' + "'" + escJs(x.deviceId) + "'" + ')">REMOVE TECH MASK</button>'
          : '') +

        '<button ' +
          'class="btn light" ' +
          (
            x.revoked
              ? 'disabled '
              : ''
          ) +
          'onclick="renameDevice(' +
          "'" +
          escJs(x.deviceId) +
          "'" +
          ')">' +

          'Rename' +

        '</button>' +

        '<button ' +
          'class="btn ' +
          (
            x.controlAllowed
              ? 'light'
              : 'primary'
          ) +
          '" ' +
          (
            x.revoked
              ? 'disabled '
              : ''
          ) +
          'onclick="toggleControl(' +
          "'" +
          escJs(x.deviceId) +
          "'," +
          (!x.controlAllowed) +
          ')">' +

          (
            x.controlAllowed
              ? 'Disable Control'
              : 'Enable Control'
          ) +

        '</button>' +

        (
          x.revoked
            ? ''
            : '<button ' +
              'class="btn danger" ' +
              'onclick="revokeDevice(' +
              "'" +
              escJs(x.deviceId) +
              "'" +
              ')">' +
              'Revoke' +
              '</button>'
        ) +

        '<button ' +
          'class="btn danger" ' +
          'onclick="deleteDevice(' +
          "'" +
          escJs(x.deviceId) +
          "'" +
          ')">' +
          'Delete' +
          '</button>' +

      '</div>' +

    '</div>'

  );

}

/* =====================================================
   ESCAPING
   ===================================================== */

function esc(value){

  return String(
    value == null
      ? ''
      : value
  ).replace(
    /[&<>"']/g,
    function(character){

      return {
        '&':'&amp;',
        '<':'&lt;',
        '>':'&gt;',
        '"':'&quot;',
        "'":'&#39;'
      }[character];

    }
  );

}

function escJs(value){

  return String(
    value == null
      ? ''
      : value
  )
  .replace(/\\\\/g,'\\\\\\\\')
  .replace(/'/g,"\\\\'")
  .replace(/\\n/g,'\\\\n')
  .replace(/\\r/g,'\\\\r');

}

/* =====================================================
   CUSTOMER LINK
   ===================================================== */

async function copyCustomerLink(){

  const input =
    document.getElementById('installerFilename');

  let filename =
    String(input ? input.value : '').trim();

  filename = filename.replace(/[\\\\/:*?"<>|]/g,'-');
  filename = filename.replace(/[\\r\\n\\t]/g,'');
  filename = filename.replace(/\\s+/g,' ');

  if(!filename){
    filename = 'RemoteSupport-Installer.bat';
  }

  if(!/\.bat$/i.test(filename)){
    filename += '.bat';
  }

  if(input){
    input.value = filename;
  }

  const url =
    location.origin +
    '/install?filename=' +
    encodeURIComponent(filename);

  try{

    await navigator.clipboard.writeText(
      url
    );

    alert(
      'Customer installation link copied.'
    );

  }catch(errorObject){

    console.error(
      errorObject
    );

    prompt(
      'Copy the customer installation link:',
      url
    );

  }

}

/* =====================================================
   TECHNICIAN WEBSOCKET TICKET
   ===================================================== */

/* =====================================================
   CONNECT TECHNICIAN WEBSOCKET
   ===================================================== */

async function connect(){

  if(!token){
    return false;
  }

  if(
    ws &&
    ws.readyState === WebSocket.OPEN
  ){
    return true;
  }

  if(connectPromise){
    return connectPromise;
  }

  connectPromise = new Promise(function(resolve){

    let settled = false;
    let authenticated = false;

    function finish(value){
      if(settled){
        return;
      }
      settled = true;
      connectPromise = null;
      resolve(value);
    }

    try{

      const protocol =
        location.protocol === 'https:'
          ? 'wss'
          : 'ws';

      const socketUrl =
        protocol +
        '://' +
        location.host +
        '/ws/technician';

      console.log(
        'Connecting technician WebSocket:',
        socketUrl
      );

      const socket =
        new WebSocket(socketUrl);

      ws = socket;
      socket.binaryType = 'blob';

      const connectionTimeout =
        setTimeout(function(){
          if(!authenticated &&
             (socket.readyState === WebSocket.CONNECTING ||
              socket.readyState === WebSocket.OPEN)){
            console.error(
              'Technician WebSocket authentication timed out.'
            );
            try{ socket.close(); }catch{}
            finish(false);
          }
        }, 10000);

      socket.onopen = function(){

        console.log(
          'Technician WebSocket transport connected; sending authentication.'
        );

        socket.send(JSON.stringify({
          type:'AUTH',
          token:token
        }));

      };

      socket.onmessage = function(event){

        if(typeof event.data !== 'string'){

          const canvas =
            document.getElementById('screen');

          if(!canvas){
            return;
          }

          const sequence = ++frameSequence;

          createImageBitmap(event.data).then(function(bitmap){

            if(sequence !== frameSequence){
              bitmap.close();
              return;
            }

            /*
             * Keep the viewer frame fixed and fit the customer's entire desktop
             * INSIDE it.  The old CSS transform changed the canvas box itself,
             * which made the zoom buttons resize the viewer instead of zooming
             * the remote image.  We now calculate the exact contain-size from
             * the customer's native frame and the technician viewer dimensions.
             */
            canvas.width = bitmap.width;
            canvas.height = bitmap.height;
            canvas.dataset.remoteWidth = String(bitmap.width);
            canvas.dataset.remoteHeight = String(bitmap.height);

            const context = canvas.getContext('2d', { alpha:false });
            context.clearRect(0, 0, canvas.width, canvas.height);
            context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
            bitmap.close();

            layoutRemoteCanvas();

            if(fullScreenWindow && !fullScreenWindow.closed){
              fullScreenWindow.postMessage(
                { type:'REMOTE_FRAME', blob:event.data },
                location.origin
              );
            }else{
              fullScreenWindow = null;
            }

          }).catch(function(errorObject){
            console.error('Remote frame decode failed:', errorObject);
          });

          return;
        }

        try{

          const message =
            JSON.parse(event.data);

          if(message.type === 'TECH_OK'){
            authenticated = true;
            clearTimeout(connectionTimeout);
            reconnecting = false;
            console.log(
              'Technician WebSocket authenticated.'
            );

            /*
             * Re-request an active session after a technician
             * socket reconnect. This lets the server resume/wait
             * for the same device without another click.
             */
            if(
              active &&
              mode &&
              socket.readyState === WebSocket.OPEN
            ){
              socket.send(
                JSON.stringify({
                  type:
                    mode === 'control'
                      ? 'OPEN_CONTROL'
                      : 'OPEN_VIEW',
                  deviceId:active
                })
              );
            }

            finish(true);
            return;
          }

          if(message.type === 'SESSION_WAITING'){
            const status =
              document.getElementById('viewerStatus');

            if(status){
              status.textContent =
                'Waiting for the Windows agent to reconnect…';
            }
            return;
          }

          if(message.type === 'SESSION_STARTED'){
            const status =
              document.getElementById('viewerStatus');

            if(status){
              status.textContent =
                message.mode === 'control'
                  ? 'Connected — remote control active'
                  : 'Connected — live desktop active';
            }
            return;
          }

          if(message.type === 'ERROR'){
            alert(message.message);
          }

          if(message.type === 'CLOSE_REMOTE'){
            closeRemote(false);
          }

        }catch(errorObject){

          console.error(
            'WebSocket message parse error:',
            errorObject
          );

        }

      };

      socket.onerror = function(errorObject){

        console.error(
          'Technician WebSocket error:',
          errorObject
        );

      };

      socket.onclose = function(event){

        clearTimeout(connectionTimeout);

        console.warn(
          'Technician WebSocket disconnected. code=' +
          event.code +
          ' reason=' +
          (event.reason || '(none)')
        );

        if(ws === socket){
          ws = null;
        }

        finish(false);

        if(
          token &&
          !reconnecting
        ){

          reconnecting = true;
          clearTimeout(reconnectTimer);

          reconnectTimer =
            setTimeout(function(){
              reconnecting = false;
              connect();
            }, 3000);

        }

      };

    }catch(errorObject){

      console.error(
        'Technician WebSocket connection failed:',
        errorObject
      );

      finish(false);

      if(token){
        clearTimeout(reconnectTimer);
        reconnectTimer =
          setTimeout(function(){
            connect();
          }, 3000);
      }

    }

  });

  return connectPromise;

}

/* =====================================================
   OPEN REMOTE SESSION
   ===================================================== */

function openRemote(
  id,
  control
){

  if(
    !ws ||
    ws.readyState !==
      WebSocket.OPEN
  ){

    connect().then(function(connected){

      if(!connected){
        alert(
          'Technician WebSocket could not connect. Check the browser console and Render logs.'
        );
        return;
      }

      openRemote(id, control);

    });

    return;
  }

  active = id;

  mode =
    control
      ? 'control'
      : 'view';

  document
    .getElementById(
      'viewer'
    )
    .style.display =
      'block';

  document
    .getElementById(
      'viewerTitle'
    )
    .textContent =
      control
        ? 'Remote control'
        : 'Remote desktop';

  const viewerStatus =
    document.getElementById('viewerStatus');

  if(viewerStatus){
    viewerStatus.textContent =
      'Connecting to the Windows agent…';
  }

  ws.send(
    JSON.stringify({
      type:
        control
          ? 'OPEN_CONTROL'
          : 'OPEN_VIEW',

      deviceId:
        id
    })
  );

  if(control){

    installInputHandlers();

  }else{

    removeInputHandlers();

  }

}

/* =====================================================
   INPUT HANDLERS
   ===================================================== */

function installInputHandlers(){

  const screen =
    document.getElementById(
      'screen'
    );

  screen.onmousemove =
    function(event){

      if(
        ws &&
        ws.readyState ===
          WebSocket.OPEN &&
        active
      ){

        ws.send(
          JSON.stringify({
            type:'INPUT',
            deviceId:active,
            input:{
              kind:'move',

              x:(function(){
                const rect = screen.getBoundingClientRect();
                return Math.max(0, Math.min(1,
                  (event.clientX - rect.left) / Math.max(1, rect.width)
                ));
              })(),

              y:(function(){
                const rect = screen.getBoundingClientRect();
                return Math.max(0, Math.min(1,
                  (event.clientY - rect.top) / Math.max(1, rect.height)
                ));
              })()
            }
          })
        );

      }

    };

  screen.onmousedown =
    function(event){

      if(
        ws &&
        ws.readyState ===
          WebSocket.OPEN &&
        active
      ){

        ws.send(
          JSON.stringify({
            type:'INPUT',
            deviceId:active,
            input:{
              kind:'mouse',
              button:event.button,
              down:true
            }
          })
        );

      }

    };

  screen.onmouseup =
    function(event){

      if(
        ws &&
        ws.readyState ===
          WebSocket.OPEN &&
        active
      ){

        ws.send(
          JSON.stringify({
            type:'INPUT',
            deviceId:active,
            input:{
              kind:'mouse',
              button:event.button,
              down:false
            }
          })
        );

      }

    };

  screen.onwheel =
    function(event){

      if(
        ws &&
        ws.readyState ===
          WebSocket.OPEN &&
        active
      ){

        ws.send(
          JSON.stringify({
            type:'INPUT',
            deviceId:active,
            input:{
              kind:'wheel',
              delta:event.deltaY
            }
          })
        );

      }

      event.preventDefault();

    };

  document.onkeydown =
    function(event){

      /*
       * Don't capture keystrokes when
       * no remote control session is active.
       */

      if(
        !active ||
        mode !== 'control'
      ){

        return;

      }

      if(
        ws &&
        ws.readyState ===
          WebSocket.OPEN
      ){

        ws.send(
          JSON.stringify({
            type:'INPUT',
            deviceId:active,
            input:{
              kind:'key',
              code:event.code,
              down:true
            }
          })
        );

        event.preventDefault();

      }

    };

  document.onkeyup =
    function(event){

      if(
        !active ||
        mode !== 'control'
      ){

        return;

      }

      if(
        ws &&
        ws.readyState ===
          WebSocket.OPEN
      ){

        ws.send(
          JSON.stringify({
            type:'INPUT',
            deviceId:active,
            input:{
              kind:'key',
              code:event.code,
              down:false
            }
          })
        );

        event.preventDefault();

      }

    };

}

function removeInputHandlers(){

  const screen =
    document.getElementById(
      'screen'
    );

  screen.onmousemove = null;
  screen.onmousedown = null;
  screen.onmouseup = null;
  screen.onwheel = null;

  document.onkeydown = null;
  document.onkeyup = null;

}

window.addEventListener('resize', function(){
  layoutRemoteCanvas();
});

/* =====================================================
   CLOSE REMOTE SESSION
   ===================================================== */

function layoutRemoteCanvas(){

  const screen = document.getElementById('screen');
  const wrap = screen ? screen.parentElement : null;

  if(!screen || !wrap){
    return;
  }

  const remoteWidth = Number(screen.dataset.remoteWidth || screen.width || 0);
  const remoteHeight = Number(screen.dataset.remoteHeight || screen.height || 0);

  if(!remoteWidth || !remoteHeight){
    return;
  }

  /*
   * The wrapper follows the customer's native aspect ratio.  The canvas is
   * always 100% of that wrapper at 100% zoom, so the complete customer
   * desktop is visible at once with no cropping. Zoom changes only the
   * rendered image, never the viewer frame itself.
   */
  wrap.style.aspectRatio = remoteWidth + ' / ' + remoteHeight;
  screen.style.width = '100%';
  screen.style.height = 'auto';
  screen.style.maxWidth = '100%';
  screen.style.maxHeight = '100%';
  screen.style.objectFit = 'contain';
  screen.style.transform = viewerZoom === 1 ? 'none' : 'scale(' + viewerZoom + ')';
  screen.style.transformOrigin = 'center center';

}


function zoomViewer(direction){

  const step = 0.1;
  viewerZoom = Math.max(0.4, Math.min(2.0, viewerZoom + (direction * step)));
  layoutRemoteCanvas();

}

function openFullScreen(){

  if(!active){
    return;
  }

  if(fullScreenWindow && !fullScreenWindow.closed){
    fullScreenWindow.focus();
    return;
  }

  fullScreenWindow = window.open('', '_blank');

  if(!fullScreenWindow){
    alert('Your browser blocked the full-screen viewer tab. Please allow pop-ups for this site.');
    return;
  }

  fullScreenWindow.document.open();
  fullScreenWindow.document.write(\`<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Remote Support - Full Screen</title>
<style>
html,body{margin:0;width:100%;height:100%;background:#000;overflow:hidden;}
body{display:flex;align-items:center;justify-content:center;}
canvas{display:block;width:100vw;height:100vh;object-fit:contain;background:#000;}
</style>
</head>
<body>
<canvas id="fullscreenScreen" width="1920" height="1080"></canvas>
</body>
</html>\`);
  fullScreenWindow.document.close();

  fullScreenWindow.addEventListener('message', async function(event){
    if(
      event.origin !== location.origin ||
      !event.data ||
      event.data.type !== 'REMOTE_FRAME'
    ){
      return;
    }

    try{
      const bitmap = await createImageBitmap(event.data.blob);
      const canvas = fullScreenWindow.document.getElementById('fullscreenScreen');

      if(!canvas){
        bitmap.close();
        return;
      }

      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext('2d',{alpha:false});
      context.clearRect(0,0,canvas.width,canvas.height);
      context.drawImage(bitmap,0,0,canvas.width,canvas.height);
      bitmap.close();
    }catch(errorObject){
      console.error(errorObject);
    }
  });

  fullScreenWindow.focus();
}

function closeRemote(
  sendClose = true
){

  if(
    sendClose &&
    active &&
    ws &&
    ws.readyState ===
      WebSocket.OPEN
  ){

    ws.send(
      JSON.stringify({
        type:'CLOSE',
        deviceId:active
      })
    );

  }

  active = null;
  mode = null;

  removeInputHandlers();

  frameSequence++;
  viewerZoom = 1;

  const screen =
    document.getElementById(
      'screen'
    );

  if(screen){
    screen.style.width = '100%';
    screen.style.height = '100%';
    screen.style.maxWidth = '100%';
    screen.style.maxHeight = '100%';
    screen.style.transform = 'none';
    screen.style.objectFit = 'contain';
    if(screen.parentElement){
      screen.parentElement.style.aspectRatio = '';
    }
    delete screen.dataset.remoteWidth;
    delete screen.dataset.remoteHeight;
    const context = screen.getContext('2d');
    context.clearRect(0,0,screen.width,screen.height);
  }

  if(fullScreenWindow && !fullScreenWindow.closed){
    try{ fullScreenWindow.close(); }catch{}
  }
  fullScreenWindow = null;

  const viewerStatus =
    document.getElementById('viewerStatus');

  if(viewerStatus){
    viewerStatus.textContent = '';
  }

  document
    .getElementById(
      'viewer'
    )
    .style.display =
      'none';

}

/* =====================================================
   RENAME
   ===================================================== */

async function renameDevice(id){

  const name =
    prompt(
      'Technician display name:'
    );

  if(!name){
    return;
  }

  try{

    const response =
      await fetch(
        '/api/devices/' +
        encodeURIComponent(id),
        {
          method:'PATCH',
          headers:authHeaders(),
          body:JSON.stringify({
            name:name
          })
        }
      );

    if(response.status === 401){

      logoutTechnician();

      return;
    }

    if(!response.ok){

      const data =
        await response.json()
          .catch(
            function(){
              return {};
            }
          );

      alert(
        data.error ||
        'Unable to rename device.'
      );

      return;
    }

    await load();

  }catch(errorObject){

    console.error(
      errorObject
    );

    alert(
      'Unable to rename device.'
    );

  }

}

/* =====================================================
   CONTROL TOGGLE
   ===================================================== */

async function toggleControl(
  id,
  enabled
){

  try{

    const response =
      await fetch(
        '/api/devices/' +
        encodeURIComponent(id) +
        '/control',
        {
          method:'PATCH',
          headers:authHeaders(),
          body:JSON.stringify({
            enabled:enabled
          })
        }
      );

    if(response.status === 401){

      logoutTechnician();

      return;
    }

    if(!response.ok){

      const data =
        await response.json()
          .catch(
            function(){
              return {};
            }
          );

      alert(
        data.error ||
        'Unable to change control policy.'
      );

      return;
    }

    await load();

  }catch(errorObject){

    console.error(
      errorObject
    );

    alert(
      'Unable to change control policy.'
    );

  }

}

/* =====================================================
   DELETE DEVICE
   ===================================================== */

async function deleteDevice(id){

  if(
    !confirm(
      'Delete this PC permanently from the technician dashboard? This will remove its enrollment and stop its current agent connection.'
    )
  ){
    return;
  }

  try{

    const response =
      await fetch(
        '/api/devices/' +
        encodeURIComponent(id),
        {
          method:'DELETE',
          headers:{
            'Authorization':'Bearer ' + token
          }
        }
      );

    if(response.status === 401){
      logoutTechnician();
      return;
    }

    if(!response.ok){
      const data =
        await response.json()
          .catch(function(){ return {}; });

      alert(
        data.error ||
        'Unable to delete device.'
      );
      return;
    }

    if(active === id){
      closeRemote(false);
    }

    await load();

  }catch(errorObject){

    console.error(errorObject);

    alert(
      'Unable to delete device.'
    );

  }

}

/* =====================================================
   REVOKE
   ===================================================== */

async function revokeDevice(id){

  if(
    !confirm(
      'Revoke this PC? The agent will no longer be allowed to reconnect.'
    )
  ){

    return;

  }

  try{

    const response =
      await fetch(
        '/api/devices/' +
        encodeURIComponent(id) +
        '/revoke',
        {
          method:'POST',
          headers:authHeaders()
        }
      );

    if(response.status === 401){

      logoutTechnician();

      return;
    }

    if(!response.ok){

      const data =
        await response.json()
          .catch(
            function(){
              return {};
            }
          );

      alert(
        data.error ||
        'Unable to revoke device.'
      );

      return;
    }

    if(active === id){

      closeRemote(
        false
      );

    }

    await load();

  }catch(errorObject){

    console.error(
      errorObject
    );

    alert(
      'Unable to revoke device.'
    );

  }

}

/* =====================================================
   LOGOUT
   ===================================================== */

function logoutTechnician(){

  token = '';

  clearTimeout(
    reconnectTimer
  );

  reconnectTimer = null;

  reconnecting = false;

  if(ws){

    try{
      ws.close();
    }catch{}

  }

  ws = null;

  closeRemote(
    false
  );

  localStorage.removeItem(
    'techToken'
  );

  document
    .getElementById(
      'dashboard'
    )
    .style.display =
      'none';

  document
    .getElementById(
      'loginModal'
    )
    .style.display =
      'flex';

  document
    .getElementById(
      'loginToken'
    )
    .value = '';

  document
    .getElementById(
      'loginError'
    )
    .textContent = '';

  document
    .getElementById(
      'loginStatus'
    )
    .textContent = '';

  document
    .getElementById(
      'loginToken'
    )
    .focus();

}

/* =====================================================
   ENTER KEY LOGIN
   ===================================================== */

document
  .getElementById(
    'loginToken'
  )
  .addEventListener(
    'keydown',
    function(event){

      if(
        event.key ===
        'Enter'
      ){

        event.preventDefault();

        loginTechnician();

      }

    }
  );

/* =====================================================
   START
   ===================================================== */

initialize();

/*
 * Refresh devices every five seconds.
 */

setInterval(
  function(){

    if(token){

      load();

    }

  },
  2000
);

</script>

</body>
</html>`;

/* =========================================================
   START SERVER
   ========================================================= */

const installationExpiryTimer = setInterval(expireStaleInstallations, 60_000);
installationExpiryTimer.unref();

await app.listen({
  port: PORT,
  host: "0.0.0.0"
});

console.log(
  `Remote Support server listening on port ${PORT}`
);
