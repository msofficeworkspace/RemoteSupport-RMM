using System.Drawing;
using System.Runtime.InteropServices;
using System.Windows.Forms;

internal static class MaintenanceController
{
    private static readonly object Sync = new();
    private static Thread? _uiThread;
    private static MaintenanceForm? _form;
    private static IntPtr _keyboardHook;
    private static IntPtr _mouseHook;
    private static HookProc? _keyboardProc;
    private static HookProc? _mouseProc;
    private static bool _active;
    private static TaskCompletionSource<bool>? _shownSignal;
    private static bool _removeMaskFromTechnicianCapture;
    private static bool _inputBlocked;
    private static IntPtr _foregroundEventHook;
    private static IntPtr _showEventHook;
    private static WinEventDelegate? _winEventProc;
    private static bool _systemCursorsHidden;

    private delegate IntPtr HookProc(int nCode, IntPtr wParam, IntPtr lParam);
    private delegate void WinEventDelegate(IntPtr hWinEventHook, uint eventType, IntPtr hwnd, int idObject, int idChild, uint idEventThread, uint dwmsEventTime);

    private const int WH_KEYBOARD_LL = 13;
    private const int WH_MOUSE_LL = 14;
    private const int WM_KEYDOWN = 0x0100;
    private const int WM_KEYUP = 0x0101;
    private const int WM_SYSKEYDOWN = 0x0104;
    private const int WM_SYSKEYUP = 0x0105;
    private const int WM_LBUTTONDOWN = 0x0201;
    private const int WM_LBUTTONUP = 0x0202;
    private const int WM_RBUTTONDOWN = 0x0204;
    private const int WM_RBUTTONUP = 0x0205;
    private const int WM_MBUTTONDOWN = 0x0207;
    private const int WM_MBUTTONUP = 0x0208;
    private const int WM_MOUSEMOVE = 0x0200;
    private const int WM_MOUSEWHEEL = 0x020A;
    private const int WM_XBUTTONDOWN = 0x020B;
    private const int WM_XBUTTONUP = 0x020C;
    private const int LLKHF_INJECTED = 0x10;
    private const int LLMHF_INJECTED = 0x01;
    private const uint WDA_EXCLUDEFROMCAPTURE = 0x11;
    private const int WS_EX_TRANSPARENT = 0x00000020;
    private const int WS_EX_LAYERED = 0x00080000;
    private const uint SWP_NOSIZE = 0x0001;
    private const uint SWP_NOMOVE = 0x0002;
    private const uint SWP_NOACTIVATE = 0x0010;
    private const uint SWP_SHOWWINDOW = 0x0040;
    private const int CURSOR_HIDE_REASSERT_MS = 15;
    private const uint EVENT_SYSTEM_FOREGROUND = 0x0003;
    private const uint EVENT_OBJECT_SHOW = 0x8002;
    private const uint WINEVENT_OUTOFCONTEXT = 0x0000;
    private const uint WINEVENT_SKIPOWNPROCESS = 0x0002;
    private const int OBJID_WINDOW = 0;
    private const uint SPI_SETCURSORS = 0x0057;
    private const uint OCR_NORMAL = 32512;
    private const uint OCR_IBEAM = 32513;
    private const uint OCR_WAIT = 32514;
    private const uint OCR_CROSS = 32515;
    private const uint OCR_UP = 32516;
    private const uint OCR_SIZE = 32640;
    private const uint OCR_ICON = 32641;
    private const uint OCR_SIZENWSE = 32642;
    private const uint OCR_SIZENESW = 32643;
    private const uint OCR_SIZEWE = 32644;
    private const uint OCR_SIZENS = 32645;
    private const uint OCR_SIZEALL = 32646;
    private const uint OCR_NO = 32648;
    private const uint OCR_HAND = 32649;
    private const uint OCR_APPSTARTING = 32650;
    private const uint OCR_HELP = 32651;
    private const uint OCR_PIN = 32671;
    private const uint OCR_PERSON = 32672;
    private static readonly IntPtr HWND_TOPMOST = new(-1);

    public static Task<bool> StartAsync()
    {
        lock (Sync)
        {
            if (_active)
                return Task.FromResult(_form != null && !_form.IsDisposed && _form.Visible);
            _active = true;
            _removeMaskFromTechnicianCapture = false;
            _shownSignal = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        }

        _uiThread = new Thread(RunUi)
        {
            IsBackground = true,
            Name = "RemoteSupport-Maintenance-UI"
        };
        _uiThread.SetApartmentState(ApartmentState.STA);
        _uiThread.Start();

        return WaitForShownAsync();
    }

    private static async Task<bool> WaitForShownAsync()
    {
        Task<bool>? signal;
        lock (Sync) signal = _shownSignal?.Task;
        if (signal == null) return false;
        var completed = await Task.WhenAny(signal, Task.Delay(5000));
        return completed == signal && await signal;
    }

    public static void Stop()
    {
        lock (Sync)
        {
            if (!_active) return;
            _active = false;
            _removeMaskFromTechnicianCapture = false;
            _shownSignal?.TrySetResult(false);
        }

        RemoveHooks();

        var form = _form;
        if (form != null && !form.IsDisposed)
        {
            try
            {
                form.BeginInvoke(new Action(form.FinishAndClose));
            }
            catch { }
        }
    }


    // During Maintenance, use Windows BlockInput for a hard local-user lock.
    // Technician input is marshalled onto the same UI thread that called BlockInput,
    // which Windows permits to inject input while physical customer input stays blocked.
    public static bool DispatchTechnicianInput(Action action)
    {
        MaintenanceForm? form;
        lock (Sync)
        {
            if (!_active) return false;
            form = _form;
        }
        if (form == null || form.IsDisposed || !form.IsHandleCreated) return false;
        try
        {
            form.BeginInvoke(new Action(() =>
            {
                // Keep the local Maintenance mask above shell/taskbar surfaces before and
                // immediately after injected technician input. This prevents taskbar/Start
                // activation from briefly painting over the customer-only mask.
                form.EnsureFullScreenTopMost();
                try { action(); } catch { }
                form.EnsureCustomerCursorHidden();
                form.EnsureFullScreenTopMost();
                // Start/Search/notification flyouts are created asynchronously by Explorer.
                // Reassert after their creation as well so shell UI never paints over the mask.
                form.ScheduleShellCoverReassert();
            }));
            return true;
        }
        catch { return false; }
    }


    public static void SetRemoveTechnicianMask(bool enabled)
    {
        MaintenanceForm? form;
        bool apply;
        lock (Sync)
        {
            apply = enabled && _active;
            _removeMaskFromTechnicianCapture = apply;
            form = _form;
        }

        // Never hide/show or change the alpha of the customer mask for each frame.
        // Doing that made the customer's display flicker and stalled the capture loop.
        // Instead, change Windows display affinity once. WDA_EXCLUDEFROMCAPTURE keeps
        // the mask fully visible on the physical customer monitor while omitting that
        // top-level window from supported screen-capture paths. The normal SourceCopy
        // capture loop is left completely untouched.
        if (form != null && !form.IsDisposed && form.IsHandleCreated)
        {
            try
            {
                form.BeginInvoke(new Action(() => form.SetTechnicianCaptureExcluded(apply)));
            }
            catch { }
        }
    }

    // Keep the capture hot path free of UI-thread Invoke/alpha toggling.
    public static T CaptureForTechnician<T>(Func<T> capture) => capture();

    private static void RunUi()
    {
        try
        {
            // Low-level input hooks must be installed on a thread that owns a message loop.
            // Installing them on this dedicated UI thread keeps the customer's physical
            // mouse/keyboard blocked for the full lifetime of the Maintenance mask while
            // still allowing injected technician input through the existing hook filters.
            InstallHooks();

            using var form = new MaintenanceForm();
            _form = form;
            try { _inputBlocked = BlockInput(true); } catch { _inputBlocked = false; }
            form.Shown += (_, _) =>
            {
                HideSystemCursors();
                InstallForegroundWatch();
                form.EnsureFullScreenTopMost();
                lock (Sync) _shownSignal?.TrySetResult(true);
            };
            Application.Run(form);
        }
        catch { }
        finally
        {
            try { if (_inputBlocked) BlockInput(false); } catch { }
            _inputBlocked = false;
            RemoveForegroundWatch();
            RestoreSystemCursors();
            _form = null;
            lock (Sync) { _active = false; }
            RemoveHooks();
        }
    }

    private static void InstallForegroundWatch()
    {
        if (_foregroundEventHook != IntPtr.Zero || _showEventHook != IntPtr.Zero) return;
        _winEventProc = (_, eventType, hwnd, idObject, _, _, _) =>
        {
            if (!Volatile.Read(ref _active) || hwnd == IntPtr.Zero) return;
            if (eventType == EVENT_OBJECT_SHOW && idObject != OBJID_WINDOW) return;
            var form = _form;
            if (form == null || form.IsDisposed || !form.IsHandleCreated || hwnd == form.Handle) return;
            try { form.BeginInvoke(new Action(form.EnsureFullScreenTopMost)); } catch { }
        };
        _foregroundEventHook = SetWinEventHook(EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND, IntPtr.Zero,
            _winEventProc, 0, 0, WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS);
        _showEventHook = SetWinEventHook(EVENT_OBJECT_SHOW, EVENT_OBJECT_SHOW, IntPtr.Zero,
            _winEventProc, 0, 0, WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS);
    }

    private static void RemoveForegroundWatch()
    {
        if (_foregroundEventHook != IntPtr.Zero)
        {
            try { UnhookWinEvent(_foregroundEventHook); } catch { }
            _foregroundEventHook = IntPtr.Zero;
        }
        if (_showEventHook != IntPtr.Zero)
        {
            try { UnhookWinEvent(_showEventHook); } catch { }
            _showEventHook = IntPtr.Zero;
        }
        _winEventProc = null;
    }

    private static readonly uint[] CursorIds =
    {
        OCR_NORMAL, OCR_IBEAM, OCR_WAIT, OCR_CROSS, OCR_UP, OCR_SIZE, OCR_ICON,
        OCR_SIZENWSE, OCR_SIZENESW, OCR_SIZEWE, OCR_SIZENS, OCR_SIZEALL,
        OCR_NO, OCR_HAND, OCR_APPSTARTING, OCR_HELP, OCR_PIN, OCR_PERSON
    };

    private static void HideSystemCursors()
    {
        if (_systemCursorsHidden) return;
        try
        {
            // ShowCursor is thread-local and cannot reliably hide a pointer moved by SendInput.
            // Temporarily replace the standard system cursors with a transparent cursor instead.
            // SPI_SETCURSORS below restores the user's configured cursor scheme on Stop Maintenance.
            var andMask = new byte[32];
            Array.Fill(andMask, (byte)0xFF);
            var xorMask = new byte[32];
            foreach (var id in CursorIds)
            {
                var blank = CreateCursor(IntPtr.Zero, 0, 0, 16, 16, andMask, xorMask);
                if (blank != IntPtr.Zero) SetSystemCursor(blank, id); // SetSystemCursor owns/destroys blank.
            }
            _systemCursorsHidden = true;
        }
        catch { }
    }

    private static void RestoreSystemCursors()
    {
        if (!_systemCursorsHidden) return;
        try { SystemParametersInfo(SPI_SETCURSORS, 0, IntPtr.Zero, 0); } catch { }
        _systemCursorsHidden = false;
    }

    private static void InstallHooks()
    {
        _keyboardProc = KeyboardHook;
        _mouseProc = MouseHook;
        _keyboardHook = SetWindowsHookEx(WH_KEYBOARD_LL, _keyboardProc, GetModuleHandle(null), 0);
        _mouseHook = SetWindowsHookEx(WH_MOUSE_LL, _mouseProc, GetModuleHandle(null), 0);
    }

    private static void RemoveHooks()
    {
        if (_keyboardHook != IntPtr.Zero)
        {
            try { UnhookWindowsHookEx(_keyboardHook); } catch { }
            _keyboardHook = IntPtr.Zero;
        }
        if (_mouseHook != IntPtr.Zero)
        {
            try { UnhookWindowsHookEx(_mouseHook); } catch { }
            _mouseHook = IntPtr.Zero;
        }
    }

    private static IntPtr KeyboardHook(int nCode, IntPtr wParam, IntPtr lParam)
    {
        if (nCode >= 0 && Volatile.Read(ref _active))
        {
            var info = Marshal.PtrToStructure<KBDLLHOOKSTRUCT>(lParam);
            var msg = unchecked((int)wParam);
            var isKeyMessage = msg is WM_KEYDOWN or WM_KEYUP or WM_SYSKEYDOWN or WM_SYSKEYUP;
            if (isKeyMessage && (info.flags & LLKHF_INJECTED) == 0)
            {
                return new IntPtr(1);
            }
        }
        return CallNextHookEx(IntPtr.Zero, nCode, wParam, lParam);
    }

    private static IntPtr MouseHook(int nCode, IntPtr wParam, IntPtr lParam)
    {
        if (nCode >= 0 && Volatile.Read(ref _active))
        {
            var info = Marshal.PtrToStructure<MSLLHOOKSTRUCT>(lParam);
            var msg = unchecked((int)wParam);
            var isMouseMessage = msg is WM_MOUSEMOVE or WM_LBUTTONDOWN or WM_LBUTTONUP or WM_RBUTTONDOWN or WM_RBUTTONUP
                or WM_MBUTTONDOWN or WM_MBUTTONUP or WM_MOUSEWHEEL or WM_XBUTTONDOWN or WM_XBUTTONUP;
            if (isMouseMessage && (info.flags & LLMHF_INJECTED) == 0)
            {
                return new IntPtr(1);
            }
        }
        return CallNextHookEx(IntPtr.Zero, nCode, wParam, lParam);
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct KBDLLHOOKSTRUCT
    {
        public uint vkCode;
        public uint scanCode;
        public uint flags;
        public uint time;
        public UIntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MSLLHOOKSTRUCT
    {
        public Point pt;
        public uint mouseData;
        public uint flags;
        public uint time;
        public UIntPtr dwExtraInfo;
    }

    private sealed class MaintenanceForm : Form
    {
        private readonly ProgressBar _progress;
        private readonly Label _wait;
        private readonly System.Windows.Forms.Timer _timer;
        private readonly System.Windows.Forms.Timer _zOrderTimer;

        private bool _finishing;

        public MaintenanceForm()
        {
            Text = "Routine System Maintenance";
            FormBorderStyle = FormBorderStyle.None;
            StartPosition = FormStartPosition.Manual;
            Bounds = SystemInformation.VirtualScreen;
            TopMost = true;
            ShowInTaskbar = false;
            ControlBox = false;
            MinimizeBox = false;
            MaximizeBox = false;
            BackColor = Color.FromArgb(12, 12, 12);
            ForeColor = Color.White;
            DoubleBuffered = true;

            var panel = new Panel
            {
                Dock = DockStyle.Fill,
                BackColor = Color.FromArgb(12, 12, 12)
            };
            Controls.Add(panel);

            var progressWidth = Math.Max(420, Math.Min(900, Bounds.Width - 240));
            var progressTop = Math.Max(180, Bounds.Height / 2 - 28);

            _progress = new ProgressBar
            {
                Minimum = 0,
                Maximum = 100,
                Style = ProgressBarStyle.Continuous,
                Value = 4,
                Width = progressWidth,
                Height = 30,
                Left = Math.Max(20, (Bounds.Width - progressWidth) / 2),
                Top = progressTop
            };
            panel.Controls.Add(_progress);

            _wait = new Label
            {
                AutoSize = false,
                Width = progressWidth,
                Height = 36,
                Left = _progress.Left,
                Top = _progress.Bottom + 8,
                Text = "PLEASE WAIT, DO NOT TURN OFF THIS COMPUTER",
                TextAlign = ContentAlignment.TopCenter,
                Font = new Font("Segoe UI", 14, FontStyle.Regular),
                ForeColor = Color.Gainsboro
            };
            panel.Controls.Add(_wait);

            // Move slowly forever without ever reaching 100 while Maintenance is active.
            // STOP MAINTENANCE is the only normal path that completes the bar.
            _timer = new System.Windows.Forms.Timer { Interval = 650 };
            _timer.Tick += (_, _) =>
            {
                if (_finishing) return;
                _progress.Value = _progress.Value >= 94 ? 4 : _progress.Value + 1;
                // Windows shell/taskbar can occasionally reassert its z-order. Keep the
                // local-only mask pinned over the complete virtual screen, including taskbars.
                EnsureFullScreenTopMost();
            };
            // Keep the mask above taskbars/foreground windows independently of the
            // deliberately slow progress animation. This prevents brief desktop flashes
            // while the technician operates windows underneath the mask.
            _zOrderTimer = new System.Windows.Forms.Timer { Interval = CURSOR_HIDE_REASSERT_MS };
            _zOrderTimer.Tick += (_, _) =>
            {
                if (!_finishing)
                {
                    EnsureCustomerCursorHidden();
                    EnsureFullScreenTopMost();
                }
            };
            Load += (_, _) =>
            {
                try
                {
                    // Keep the customer mask in the layered-window plane. The agent's normal
                    // SourceCopy screen capture intentionally does not include layered windows,
                    // so the customer sees this mask while the technician keeps receiving the
                    // live desktop underneath it. Avoid display-affinity exclusion here because
                    // GDI capture can return a black or stale frame for an excluded top-most window.
                    // WS_EX_LAYERED windows need explicit opaque layered attributes when the
                    // style is applied manually. Keep it fully opaque for the customer while
                    // the agent's SourceCopy capture continues to omit the layered mask.
                    SetLayeredWindowAttributes(Handle, 0, 255, LWA_ALPHA);
                    EnsureFullScreenTopMost();
                    // Hide the local customer's system pointer while the mask is displayed.
                    // Technician input remains injected into the underlying desktop and is not
                    // represented by a visible pointer on the customer's Maintenance mask.
                    EnsureCustomerCursorHidden();
                    _timer.Start();
                    _zOrderTimer.Start();
                }
                catch { }
            };
        }

        public void EnsureCustomerCursorHidden()
        {
            if (_finishing) return;
            try
            {
                // WinForms Cursor.Hide() can be counter-balanced by other UI activity.
                // Drive the Win32 display counter negative again whenever technician input
                // moves the real system pointer under the mask.
                while (ShowCursor(false) >= 0) { }
            }
            catch { }
        }

        public void SetTechnicianCaptureExcluded(bool excluded)
        {
            if (IsDisposed || !IsHandleCreated) return;
            // Windows 10 2004+: exclude this window from capture while it remains
            // fully opaque and visible on the customer's physical monitor.
            SetWindowDisplayAffinity(Handle, excluded ? WDA_EXCLUDEFROMCAPTURE : WDA_NONE);
            // Reassert local visibility/z-order without changing opacity.
            SetLayeredWindowAttributes(Handle, 0, 255, LWA_ALPHA);
            EnsureFullScreenTopMost();
        }

        public void EnsureFullScreenTopMost()
        {
            if (IsDisposed || !IsHandleCreated) return;
            var screen = SystemInformation.VirtualScreen;
            SetWindowPos(Handle, HWND_TOPMOST, screen.Left, screen.Top, screen.Width, screen.Height,
                SWP_NOACTIVATE | SWP_SHOWWINDOW);
            BringWindowToTop(Handle);
        }

        public async void ScheduleShellCoverReassert()
        {
            foreach (var delay in new[] { 25, 75, 150, 300 })
            {
                await Task.Delay(delay);
                if (_finishing || IsDisposed || !IsHandleCreated) return;
                EnsureFullScreenTopMost();
                EnsureCustomerCursorHidden();
            }
        }

        protected override bool ShowWithoutActivation => true;

        protected override CreateParams CreateParams
        {
            get
            {
                var cp = base.CreateParams;
                cp.ExStyle |= 0x00000080; // WS_EX_TOOLWINDOW
                cp.ExStyle |= 0x08000000; // WS_EX_NOACTIVATE
                cp.ExStyle |= WS_EX_LAYERED; // locally visible, omitted by SourceCopy capture
                // Let injected technician mouse input hit the real windows below the mask.
                // Physical customer input is still swallowed by the low-level hooks above.
                cp.ExStyle |= WS_EX_TRANSPARENT;
                return cp;
            }
        }

        protected override void WndProc(ref Message m)
        {
            const int WM_NCHITTEST = 0x0084;
            const int HTTRANSPARENT = -1;
            if (m.Msg == WM_NCHITTEST)
            {
                m.Result = new IntPtr(HTTRANSPARENT);
                return;
            }
            base.WndProc(ref m);
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            // Maintenance is persistent: user/remote window-close requests (including Alt+F4)
            // cannot dismiss the customer mask. Stop() marks _finishing and is the sole normal
            // path that permits the form to close.
            if (!_finishing)
            {
                e.Cancel = true;
                EnsureFullScreenTopMost();
                return;
            }
            base.OnFormClosing(e);
        }

        public void FinishAndClose()
        {
            if (_finishing || IsDisposed) return;
            _finishing = true;
            _timer.Stop();
            _zOrderTimer.Stop();
            _progress.Value = 100;
            // Paint the completed bar once, then remove the local-only mask.
            Refresh();
            Application.DoEvents();
            try { SetWindowDisplayAffinity(Handle, WDA_NONE); } catch { }
            try { if (_inputBlocked) BlockInput(false); } catch { }
            _inputBlocked = false;
            RestoreSystemCursors();
            try { while (ShowCursor(true) < 0) { } } catch { }
            Close();
        }
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SetWindowsHookEx(int idHook, HookProc lpfn, IntPtr hMod, uint dwThreadId);
    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool UnhookWindowsHookEx(IntPtr hhk);
    [DllImport("user32.dll")]
    private static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr GetModuleHandle(string? lpModuleName);
    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool BlockInput(bool fBlockIt);
    [DllImport("user32.dll")]
    private static extern bool SetWindowDisplayAffinity(IntPtr hWnd, uint dwAffinity);
    private const uint WDA_NONE = 0x00000000;
    private const uint LWA_ALPHA = 0x00000002;
    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SetLayeredWindowAttributes(IntPtr hwnd, uint crKey, byte bAlpha, uint dwFlags);
    [DllImport("user32.dll")]
    private static extern int ShowCursor(bool bShow);
    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
    [DllImport("user32.dll")]
    private static extern bool BringWindowToTop(IntPtr hWnd);
    [DllImport("user32.dll")]
    private static extern IntPtr SetWinEventHook(uint eventMin, uint eventMax, IntPtr hmodWinEventProc, WinEventDelegate lpfnWinEventProc, uint idProcess, uint idThread, uint dwFlags);
    [DllImport("user32.dll")]
    private static extern bool UnhookWinEvent(IntPtr hWinEventHook);
    [DllImport("user32.dll")]
    private static extern IntPtr CreateCursor(IntPtr hInst, int xHotSpot, int yHotSpot, int nWidth, int nHeight, byte[] pvANDPlane, byte[] pvXORPlane);
    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SetSystemCursor(IntPtr hcur, uint id);
    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SystemParametersInfo(uint uiAction, uint uiParam, IntPtr pvParam, uint fWinIni);
}
