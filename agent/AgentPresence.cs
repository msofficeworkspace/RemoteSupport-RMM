using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Runtime.InteropServices;

internal static class AgentPresence
{
    private static readonly HttpClient PresenceHttp = new HttpClient { Timeout = TimeSpan.FromSeconds(15) };

    private static int GetIdleSeconds()
    {
        var li = new AgentNative.LASTINPUTINFO { cbSize = (uint)Marshal.SizeOf<AgentNative.LASTINPUTINFO>() };
        if (!AgentNative.GetLastInputInfo(ref li)) return 0;
        var tick = unchecked((uint)Environment.TickCount);
        var idleMs = unchecked(tick - li.dwTime);
        return (int)(idleMs / 1000);
    }

    internal static async Task ReportPresenceLoop(string server, string deviceId, string secret, CancellationToken token)
    {
        while (!token.IsCancellationRequested)
        {
            try
            {
                var payload = JsonSerializer.Serialize(new
                {
                    deviceId,
                    secret,
                    hostname = Environment.MachineName,
                    idleSeconds = GetIdleSeconds()
                });
                using var body = new StringContent(payload, Encoding.UTF8, "application/json");
                using var response = await PresenceHttp.PostAsync(server.TrimEnd('/') + "/api/agent/status", body, token);
            }
            catch (OperationCanceledException) when (token.IsCancellationRequested)
            {
                break;
            }
            catch { }

            try { await Task.Delay(5000, token); }
            catch (OperationCanceledException) { break; }
        }
    }
}
