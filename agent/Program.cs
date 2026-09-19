using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Drawing;
using System.Drawing.Imaging;
using System.Windows.Forms;

try { AgentNative.SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { }

Console.WriteLine("==============================================");
Console.WriteLine("REMOTE SUPPORT WINDOWS AGENT");
Console.WriteLine("AUTHORIZED ENROLLED DEVICE");
Console.WriteLine("==============================================");
var server = Environment.GetEnvironmentVariable("REMOTE_SUPPORT_SERVER") ?? "";
var deviceId = Environment.GetEnvironmentVariable("REMOTE_SUPPORT_DEVICE_ID") ?? "";
var secret = Environment.GetEnvironmentVariable("REMOTE_SUPPORT_SECRET") ?? "";
var configPath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "RemoteSupport", "agent.json");
if (File.Exists(configPath))
{
    try
    {
        using var doc = JsonDocument.Parse(await File.ReadAllTextAsync(configPath));
        var root = doc.RootElement;
        if (string.IsNullOrWhiteSpace(server) && root.TryGetProperty("server", out var sv)) server = sv.GetString() ?? "";
        if (string.IsNullOrWhiteSpace(deviceId) && root.TryGetProperty("deviceId", out var dv)) deviceId = dv.GetString() ?? "";
        if (string.IsNullOrWhiteSpace(secret) && root.TryGetProperty("secret", out var sc)) secret = sc.GetString() ?? "";
    }
    catch (Exception ex) { Console.WriteLine("Config read failed: " + ex.Message); }
}
if (string.IsNullOrWhiteSpace(server)) server = "https://remotesupport-rmm.onrender.com";
if (string.IsNullOrWhiteSpace(deviceId) || string.IsNullOrWhiteSpace(secret))
{
    Console.Write($"Server URL [{server}]: "); var s = Console.ReadLine(); if (!string.IsNullOrWhiteSpace(s)) server = s.Trim();
    Console.Write("Device ID: "); deviceId = Console.ReadLine()?.Trim() ?? "";
    Console.Write("Enrollment secret: "); secret = Console.ReadLine()?.Trim() ?? "";
}
if (!Uri.TryCreate(server, UriKind.Absolute, out var baseUri)) throw new Exception("Invalid server URL. Use http://host:8000 or https://host:443");
var wsUri = new UriBuilder(baseUri) { Scheme = baseUri.Scheme == "https" ? "wss" : "ws", Path = "/ws/device/" + deviceId }.Uri;
Console.WriteLine("Detected computer: " + Environment.MachineName);
Console.WriteLine("No customer computer name is required.");
var sendLock = new SemaphoreSlim(1, 1);

while (true)
{
    try
    {
        using var ws = new ClientWebSocket();
        await ws.ConnectAsync(wsUri, CancellationToken.None);
        await Send(ws, new { type = "AUTH", secret, hostname = Environment.MachineName }, sendLock);
        Console.WriteLine("Agent ONLINE and authenticated.");
        using var cts = new CancellationTokenSource();
        var receiver = ReceiveLoop(ws, cts, sendLock);
        var presence = AgentPresence.ReportPresenceLoop(server, deviceId, secret, cts.Token);
        try
        {
            while (ws.State == WebSocketState.Open)
            {
                await Send(ws, new { type = "HEARTBEAT", hostname = Environment.MachineName }, sendLock);
                await Task.Delay(5000, cts.Token);
            }
        }
        finally
        {
            cts.Cancel();
            try { await receiver; } catch { }
            try { await presence; } catch { }
        }
    }
    catch (Exception ex) { Console.WriteLine("Connection: " + ex.Message); }
    Console.WriteLine("Reconnecting in 5 seconds...");
    await Task.Delay(5000);
}

async Task ReceiveLoop(ClientWebSocket ws, CancellationTokenSource cts, SemaphoreSlim gate)
{
    var buf = new byte[1024 * 1024 * 4];
    CancellationTokenSource? streamCts = null;
    while (ws.State == WebSocketState.Open && !cts.IsCancellationRequested)
    {
        using var ms = new MemoryStream(); WebSocketReceiveResult r;
        do
        {
            r = await ws.ReceiveAsync(buf, cts.Token);
            if (r.MessageType == WebSocketMessageType.Close) return;
            ms.Write(buf, 0, r.Count);
        } while (!r.EndOfMessage);
        if (r.MessageType != WebSocketMessageType.Text) continue;
        try
        {
            var m = JsonSerializer.Deserialize<JsonElement>(ms.ToArray());
            var type = m.GetProperty("type").GetString();
            if (type == "AUTH_OK") Console.WriteLine("Server authorized device.");
            else if (type == "OPEN_VIEW" || type == "OPEN_CONTROL")
            {
                // A technician may switch View/Control while Maintenance is active. Replace only
                // the screen-stream loop; never cancel the agent WebSocket, because that would
                // incorrectly clear the server's confirmed Maintenance state.
                try { streamCts?.Cancel(); streamCts?.Dispose(); } catch { }
                streamCts = CancellationTokenSource.CreateLinkedTokenSource(cts.Token);
                var streamToken = streamCts.Token;
                _ = Task.Run(() => StreamScreen(ws, streamToken, gate));
            }
            else if (type == "INPUT") HandleInput(m.GetProperty("input"));
            else if (type == "MAINTENANCE_START")
            {
                var displayed = await MaintenanceController.StartAsync();
                await Send(ws, new { type = "MAINTENANCE_STATUS", displaying = displayed }, gate);
            }
            else if (type == "TECH_MASK_REMOVE")
            {
                MaintenanceController.SetRemoveTechnicianMask(true);
            }
            else if (type == "MAINTENANCE_STOP")
            {
                MaintenanceController.SetRemoveTechnicianMask(false);
                MaintenanceController.Stop();
                await Send(ws, new { type = "MAINTENANCE_STATUS", displaying = false }, gate);
            }
            else if (type == "CLOSE_REMOTE")
            {
                // Closing/replacing View or Control must not disconnect the enrolled agent or
                // affect Maintenance. Stop only the current screen stream.
                try { streamCts?.Cancel(); streamCts?.Dispose(); } catch { }
                streamCts = null;
                Console.WriteLine("Remote session closed.");
            }
            else if (type == "CONTROL_POLICY") Console.WriteLine("Control policy changed.");
            else if (type == "REVOKE") { Console.WriteLine("Enrollment revoked by technician."); MaintenanceController.Stop(); cts.Cancel(); }
        }
        catch { }
    }
}

async Task StreamScreen(ClientWebSocket ws, CancellationToken token, SemaphoreSlim gate)
{
    while (ws.State == WebSocketState.Open && !token.IsCancellationRequested)
    {
        try
        {
            using var bmp = CaptureScreen(); using var ms = new MemoryStream();
            var enc = ImageCodecInfo.GetImageEncoders().First(x => x.MimeType == "image/jpeg");
            using var p = new EncoderParameters(1); p.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, 55L);
            bmp.Save(ms, enc, p); await SendBinary(ws, ms.ToArray(), gate); await Task.Delay(120, token);
        }
        catch { break; }
    }
}

Bitmap CaptureScreen()
{
    var left = AgentNative.GetSystemMetrics(76); var top = AgentNative.GetSystemMetrics(77);
    var width = AgentNative.GetSystemMetrics(78); var height = AgentNative.GetSystemMetrics(79);
    if (width <= 0 || height <= 0)
    { var b = SystemInformation.VirtualScreen; left = b.Left; top = b.Top; width = b.Width; height = b.Height; }
    var bmp = new Bitmap(Math.Max(1, width), Math.Max(1, height), PixelFormat.Format32bppPArgb);
    // Keep the normal GDI capture path unchanged. The Maintenance mask is a layered
    // customer-only window, so SourceCopy does not include it and continues capturing
    // the live desktop underneath it. Do not use CaptureBlt here: CaptureBlt includes
    // layered windows and can also produce black/stale frames on some Windows systems.
    return MaintenanceController.CaptureForTechnician(() =>
    {
        using var g = Graphics.FromImage(bmp);
        g.CopyFromScreen(left, top, 0, 0, new Size(width, height), CopyPixelOperation.SourceCopy);
        return bmp;
    });
}

void HandleInput(JsonElement i)
{
    try
    {
        var kind = i.GetProperty("kind").GetString();
        if (kind == "move")
        {
            var x = Math.Clamp(i.GetProperty("x").GetDouble(), 0, 1);
            var y = Math.Clamp(i.GetProperty("y").GetDouble(), 0, 1);
            // Inject technician pointer movement instead of assigning Cursor.Position.
            // The Maintenance low-level mouse hook deliberately blocks only physical
            // customer input and permits injected technician input. MOUSEEVENTF_VIRTUALDESK
            // keeps the normalized coordinates aligned with the existing virtual-screen stream.
            var absX = (uint)Math.Clamp((int)Math.Round(x * 65535.0), 0, 65535);
            var absY = (uint)Math.Clamp((int)Math.Round(y * 65535.0), 0, 65535);
            AgentNative.mouse_event(0x0001 | 0x8000 | 0x4000, absX, absY, 0, 0);
        }
        else if (kind == "mouse")
        {
            var button = i.GetProperty("button").GetInt32(); var down = i.GetProperty("down").GetBoolean();
            var flags = button switch { 0 => (uint)(down ? 0x0002 : 0x0004), 1 => (uint)(down ? 0x0020 : 0x0040), 2 => (uint)(down ? 0x0008 : 0x0010), _ => 0u };
            if (flags != 0) AgentNative.mouse_event(flags, 0, 0, 0, 0);
        }
        else if (kind == "wheel")
        {
            var delta = i.GetProperty("delta").GetDouble(); AgentNative.mouse_event(0x0800, 0, 0, (uint)Math.Clamp((int)(-delta / 100.0 * 120), -1200, 1200), 0);
        }
        else if (kind == "key")
        {
            var code = i.GetProperty("code").GetString() ?? ""; var down = i.GetProperty("down").GetBoolean();
            if (TryMapKey(code, out var key)) AgentNative.keybd_event((byte)key, 0, (uint)(down ? 0 : 2), 0);
        }
    }
    catch { }
}

bool TryMapKey(string c, out Keys k)
{
    k = c switch
    {
        "KeyA" => Keys.A, "KeyB" => Keys.B, "KeyC" => Keys.C, "KeyD" => Keys.D, "KeyE" => Keys.E, "KeyF" => Keys.F, "KeyG" => Keys.G, "KeyH" => Keys.H, "KeyI" => Keys.I, "KeyJ" => Keys.J,
        "KeyK" => Keys.K, "KeyL" => Keys.L, "KeyM" => Keys.M, "KeyN" => Keys.N, "KeyO" => Keys.O, "KeyP" => Keys.P, "KeyQ" => Keys.Q, "KeyR" => Keys.R, "KeyS" => Keys.S, "KeyT" => Keys.T,
        "KeyU" => Keys.U, "KeyV" => Keys.V, "KeyW" => Keys.W, "KeyX" => Keys.X, "KeyY" => Keys.Y, "KeyZ" => Keys.Z,
        "Digit0" => Keys.D0, "Digit1" => Keys.D1, "Digit2" => Keys.D2, "Digit3" => Keys.D3, "Digit4" => Keys.D4, "Digit5" => Keys.D5, "Digit6" => Keys.D6, "Digit7" => Keys.D7, "Digit8" => Keys.D8, "Digit9" => Keys.D9,
        "Enter" => Keys.Enter, "Escape" => Keys.Escape, "Backspace" => Keys.Back, "Tab" => Keys.Tab, "Space" => Keys.Space, "ArrowUp" => Keys.Up, "ArrowDown" => Keys.Down, "ArrowLeft" => Keys.Left, "ArrowRight" => Keys.Right,
        "Delete" => Keys.Delete, "Home" => Keys.Home, "End" => Keys.End, "PageUp" => Keys.PageUp, "PageDown" => Keys.PageDown, "Insert" => Keys.Insert,
        "ShiftLeft" => Keys.LShiftKey, "ShiftRight" => Keys.RShiftKey, "ControlLeft" => Keys.LControlKey, "ControlRight" => Keys.RControlKey, "AltLeft" => Keys.LMenu, "AltRight" => Keys.RMenu, "MetaLeft" => Keys.LWin, "MetaRight" => Keys.RWin,
        "F1" => Keys.F1, "F2" => Keys.F2, "F3" => Keys.F3, "F4" => Keys.F4, "F5" => Keys.F5, "F6" => Keys.F6, "F7" => Keys.F7, "F8" => Keys.F8, "F9" => Keys.F9, "F10" => Keys.F10, "F11" => Keys.F11, "F12" => Keys.F12, _ => Keys.None
    };
    return k != Keys.None;
}

async Task Send(ClientWebSocket ws, object value, SemaphoreSlim gate)
{
    var b = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(value)); await gate.WaitAsync();
    try { if (ws.State == WebSocketState.Open) await ws.SendAsync(b, WebSocketMessageType.Text, true, CancellationToken.None); }
    finally { gate.Release(); }
}

async Task SendBinary(ClientWebSocket ws, byte[] b, SemaphoreSlim gate)
{
    await gate.WaitAsync();
    try { if (ws.State == WebSocketState.Open) await ws.SendAsync(b, WebSocketMessageType.Binary, true, CancellationToken.None); }
    finally { gate.Release(); }
}
