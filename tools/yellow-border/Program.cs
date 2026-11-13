using System.Drawing;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

namespace YellowBorder;

internal static class Program
{
    private const string MutexName = "Local\\IT-Avenue-YellowBorder";
    private const string ShowEventName = "Local\\IT-Avenue-YellowBorder-Show";

    [STAThread]
    private static void Main()
    {
        using var mutex = new Mutex(true, MutexName, out var firstInstance);
        using var showEvent = new EventWaitHandle(false, EventResetMode.AutoReset, ShowEventName);

        if (!firstInstance)
        {
            showEvent.Set();
            return;
        }

        ApplicationConfiguration.Initialize();
        using var context = new BorderContext(showEvent);
        Application.Run(context);
    }
}

internal sealed class BorderContext : ApplicationContext
{
    private const int Thickness = 2;
    private static readonly string SettingsPath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "YellowBorder",
        "settings.json");
    private readonly List<Form> borders = [];
    private readonly NotifyIcon tray;
    private readonly ToolStripMenuItem toggleItem;
    private readonly RegisteredWaitHandle toggleWait;
    private bool visible = true;
    private Color borderColor = LoadColor();

    public BorderContext(EventWaitHandle showEvent)
    {
        toggleItem = new ToolStripMenuItem("Hide border", null, (_, _) => Toggle());
        var menu = new ContextMenuStrip();
        menu.Items.Add(toggleItem);
        menu.Items.Add(CreateColorMenu());
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Exit", null, (_, _) => ExitThread());

        tray = new NotifyIcon
        {
            Icon = SystemIcons.Warning,
            Text = "Yellow Border - click to toggle",
            ContextMenuStrip = menu,
            Visible = true,
        };
        tray.MouseClick += (_, e) => { if (e.Button == MouseButtons.Left) Toggle(); };

        CreateBorders();
        SystemEvents.DisplaySettingsChanged += OnDisplaySettingsChanged;
        // RegisterWait runs on a worker, so retain the UI context explicitly.
        var uiContext = SynchronizationContext.Current ?? new WindowsFormsSynchronizationContext();
        toggleWait = ThreadPool.RegisterWaitForSingleObject(
            showEvent,
            (_, _) => uiContext.Post(_ => ShowBorder(), null),
            null,
            Timeout.Infinite,
            false);
    }

    private void CreateBorders()
    {
        foreach (var border in borders) border.Dispose();
        borders.Clear();

        foreach (var screen in Screen.AllScreens)
        {
            var area = screen.Bounds;
            borders.Add(CreateStrip(new Rectangle(area.Left, area.Top, area.Width, Thickness)));
            borders.Add(CreateStrip(new Rectangle(area.Left, area.Bottom - Thickness, area.Width, Thickness)));
            borders.Add(CreateStrip(new Rectangle(area.Left, area.Top, Thickness, area.Height)));
            borders.Add(CreateStrip(new Rectangle(area.Right - Thickness, area.Top, Thickness, area.Height)));
        }
    }

    private Form CreateStrip(Rectangle bounds)
    {
        var form = new ClickThroughForm
        {
            BackColor = borderColor,
            Bounds = bounds,
            FormBorderStyle = FormBorderStyle.None,
            ShowInTaskbar = false,
            StartPosition = FormStartPosition.Manual,
            TopMost = true,
        };
        form.Show();
        return form;
    }

    private ToolStripMenuItem CreateColorMenu()
    {
        var colorMenu = new ToolStripMenuItem("Color");
        AddColorChoice(colorMenu, "Yellow", Color.FromArgb(255, 214, 0));
        AddColorChoice(colorMenu, "Green", Color.LimeGreen);
        AddColorChoice(colorMenu, "Blue", Color.DodgerBlue);
        AddColorChoice(colorMenu, "Red", Color.Red);
        AddColorChoice(colorMenu, "Purple", Color.MediumPurple);
        colorMenu.DropDownItems.Add(new ToolStripSeparator());
        colorMenu.DropDownItems.Add("Custom…", null, (_, _) => ChooseCustomColor());
        return colorMenu;
    }

    private void AddColorChoice(ToolStripMenuItem parent, string name, Color color)
    {
        var swatch = new Bitmap(16, 16);
        using (var graphics = Graphics.FromImage(swatch)) graphics.Clear(color);
        parent.DropDownItems.Add(name, swatch, (_, _) => SetColor(color));
    }

    private void ChooseCustomColor()
    {
        using var picker = new ColorDialog { Color = borderColor, FullOpen = true };
        if (picker.ShowDialog() == DialogResult.OK) SetColor(picker.Color);
    }

    private void SetColor(Color color)
    {
        borderColor = color;
        foreach (var border in borders) border.BackColor = color;
        SaveColor(color);
    }

    private static Color LoadColor()
    {
        try
        {
            var settings = JsonSerializer.Deserialize<ColorSettings>(File.ReadAllText(SettingsPath));
            if (settings is not null) return Color.FromArgb(settings.Argb);
        }
        catch { }
        return Color.FromArgb(255, 214, 0);
    }

    private static void SaveColor(Color color)
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(SettingsPath)!);
            File.WriteAllText(SettingsPath, JsonSerializer.Serialize(new ColorSettings(color.ToArgb())));
        }
        catch { }
    }

    private void Toggle()
    {
        visible = !visible;
        foreach (var border in borders) border.Visible = visible;
        toggleItem.Text = visible ? "Hide border" : "Show border";
    }

    private void ShowBorder()
    {
        visible = true;
        foreach (var border in borders) border.Visible = true;
        toggleItem.Text = "Hide border";
    }

    private void OnDisplaySettingsChanged(object? sender, EventArgs e)
    {
        CreateBorders();
        foreach (var border in borders) border.Visible = visible;
    }

    protected override void ExitThreadCore()
    {
        SystemEvents.DisplaySettingsChanged -= OnDisplaySettingsChanged;
        toggleWait.Unregister(null);
        tray.Visible = false;
        tray.Dispose();
        foreach (var border in borders) border.Dispose();
        base.ExitThreadCore();
    }
}

internal sealed record ColorSettings(int Argb);

internal sealed class ClickThroughForm : Form
{
    private const int WsExTransparent = 0x20;
    private const int WsExToolWindow = 0x80;
    private const int WsExNoActivate = 0x08000000;

    protected override CreateParams CreateParams
    {
        get
        {
            var cp = base.CreateParams;
            cp.ExStyle |= WsExTransparent | WsExToolWindow | WsExNoActivate;
            return cp;
        }
    }

    protected override bool ShowWithoutActivation => true;
}
