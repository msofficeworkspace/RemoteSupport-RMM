using System.Runtime.InteropServices;

internal static class AgentNative
{
    [DllImport("user32.dll")]
    internal static extern bool SetProcessDpiAwarenessContext(IntPtr value);

    [DllImport("user32.dll")]
    internal static extern int GetSystemMetrics(int nIndex);

    // Synchronize with Desktop Window Manager before capturing an excluded
    // Maintenance overlay so the technician stream stays live underneath it.
    [DllImport("dwmapi.dll")]
    internal static extern int DwmFlush();

    [DllImport("user32.dll")]
    internal static extern void mouse_event(uint flags, uint dx, uint dy, uint data, nuint extraInfo);

    [DllImport("user32.dll")]
    internal static extern void keybd_event(byte key, byte scan, uint flags, nuint extraInfo);

    [StructLayout(LayoutKind.Sequential)]
    internal struct LASTINPUTINFO
    {
        public uint cbSize;
        public uint dwTime;
    }

    [DllImport("user32.dll")]
    internal static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);
}
