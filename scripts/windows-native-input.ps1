param([Parameter(Mandatory = $true)][string]$InputFile)
$ErrorActionPreference = 'Stop'
$nativeReady = $false
try {
  if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT -or
      -not [Environment]::Is64BitProcess -or $env:GITHUB_ACTIONS -cne 'true' -or
      $env:RUNNER_ENVIRONMENT -cne 'github-hosted') {
    throw 'ENVIRONMENT_NATIVE_INPUT_GUARD: input is restricted to disposable GitHub-hosted Windows x64'
  }
  $action = Get-Content -LiteralPath $InputFile -Raw -Encoding UTF8 | ConvertFrom-Json
  if (@('move','click','wheel','drag','type','key','probe') -cnotcontains $action.kind) {
    throw 'NATIVE_INPUT_INVALID_ARGUMENT: unknown action'
  }
  Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class MouseClickNativeInput {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT {
    public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public UIntPtr dwExtraInfo;
  }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT {
    public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public UIntPtr dwExtraInfo;
  }
  [StructLayout(LayoutKind.Sequential)] public struct HARDWAREINPUT { public uint uMsg; public ushort wParamL; public ushort wParamH; }
  [StructLayout(LayoutKind.Explicit)] public struct UNION {
    [FieldOffset(0)] public MOUSEINPUT mi;
    [FieldOffset(0)] public KEYBDINPUT ki;
    [FieldOffset(0)] public HARDWAREINPUT hi;
  }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public UNION u; }
  [DllImport("user32.dll", SetLastError=true)] static extern uint SendInput(uint count, INPUT[] inputs, int size);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool GetCursorPos(out POINT point);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
  [DllImport("user32.dll", SetLastError=true)] static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
  [DllImport("user32.dll", SetLastError=true)] static extern bool CloseDesktop(IntPtr desktop);
  [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool GetUserObjectInformation(IntPtr handle, int index, StringBuilder value, int length, out int needed);
  [DllImport("user32.dll", SetLastError=true)] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  public static int Sent = 0, Expected = 0, LastError = 0, CleanupSent = 0;
  public static string DesktopName = "";
  public static int InputSize { get { return Marshal.SizeOf(typeof(INPUT)); } }
  public static int[] VirtualBounds() { return new int[] { GetSystemMetrics(76), GetSystemMetrics(77), GetSystemMetrics(78), GetSystemMetrics(79) }; }
  public static POINT Position() {
    POINT point; if (!GetCursorPos(out point)) throw new Win32Exception(Marshal.GetLastWin32Error(), "ENVIRONMENT_CURSOR_UNAVAILABLE"); return point;
  }
  public static void Prepare() {
    if (IntPtr.Size != 8 || InputSize != 40) throw new Exception("ENVIRONMENT_INPUT_LAYOUT: expected x64 INPUT size 40");
    if (SetThreadDpiAwarenessContext(new IntPtr(-4)) == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "ENVIRONMENT_DPI_CONTEXT");
    IntPtr desktop = OpenInputDesktop(0, false, 1);
    if (desktop == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "ENVIRONMENT_INPUT_DESKTOP_UNAVAILABLE");
    try {
      int needed; StringBuilder name = new StringBuilder(256);
      if (!GetUserObjectInformation(desktop, 2, name, name.Capacity * 2, out needed)) throw new Win32Exception(Marshal.GetLastWin32Error(), "ENVIRONMENT_INPUT_DESKTOP_NAME");
      DesktopName = name.ToString();
      if (!String.Equals(DesktopName, "Default", StringComparison.OrdinalIgnoreCase)) throw new Exception("ENVIRONMENT_INPUT_DESKTOP_UNAVAILABLE: input desktop is not Default");
    } finally { CloseDesktop(desktop); }
  }
  static INPUT Mouse(uint flags, int x, int y, uint data) {
    INPUT value = new INPUT(); value.type = 0; value.u.mi.dx=x; value.u.mi.dy=y; value.u.mi.mouseData=data; value.u.mi.dwFlags=flags; return value;
  }
  static INPUT Key(ushort vk, ushort scan, uint flags) {
    INPUT value = new INPUT(); value.type=1; value.u.ki.wVk=vk; value.u.ki.wScan=scan; value.u.ki.dwFlags=flags; return value;
  }
  static INPUT At(int x, int y) {
    int[] b=VirtualBounds();
    if (b[2]<2 || b[3]<2 || x<b[0] || y<b[1] || x>=b[0]+b[2] || y>=b[1]+b[3]) throw new Exception("NATIVE_INPUT_INVALID_ARGUMENT: point outside virtual desktop");
    int nx=(int)Math.Round((x-b[0])*65535.0/(b[2]-1)); int ny=(int)Math.Round((y-b[1])*65535.0/(b[3]-1));
    return Mouse(0x8000|0x4000|0x0001,nx,ny,0);
  }
  static void Send(INPUT[] values) {
    Expected+=values.Length; uint count=SendInput((uint)values.Length,values,InputSize); LastError=Marshal.GetLastWin32Error(); Sent+=(int)count;
    if (count != values.Length) throw new Exception("ENVIRONMENT_SENDINPUT_FAILED: inserted "+count+" of "+values.Length+" events; Win32 error "+LastError+" (UIPI may not identify its cause)");
  }
  public static void Move(int x,int y) { Send(new INPUT[]{At(x,y)}); }
  public static void Click(int x,int y) { Send(new INPUT[]{At(x,y),Mouse(0x0002,0,0,0),Mouse(0x0004,0,0,0)}); }
  public static void Wheel(int x,int y,int delta) { Send(new INPUT[]{At(x,y),Mouse(0x0800,0,0,unchecked((uint)delta))}); }
  public static void Drag(int x,int y,int x2,int y2) {
    At(x2,y2); Send(new INPUT[]{At(x,y),Mouse(0x0002,0,0,0)});
    for(int n=1;n<=20;n++){ Thread.Sleep(15); Move((int)Math.Round(x+(x2-x)*n/20.0),(int)Math.Round(y+(y2-y)*n/20.0)); }
    Send(new INPUT[]{Mouse(0x0004,0,0,0)});
  }
  public static void Type(string text) {
    if(text==null || text.Length>512) throw new Exception("NATIVE_INPUT_INVALID_ARGUMENT: invalid text");
    List<INPUT> values=new List<INPUT>(); foreach(char ch in text){ values.Add(Key(0,ch,0x0004)); values.Add(Key(0,ch,0x0004|0x0002)); }
    if(values.Count>0) Send(values.ToArray());
  }
  public static void Chord(string name) {
    ushort[] keys;
    switch(name){
      case "AltX": keys=new ushort[]{0x12,0x58}; break;
      case "CtrlA": keys=new ushort[]{0x11,0x41}; break;
      case "Home": keys=new ushort[]{0x24}; break;
      case "ControlHome": keys=new ushort[]{0x11,0x24}; break;
      case "Escape": keys=new ushort[]{0x1b}; break;
      case "Enter": keys=new ushort[]{0x0d}; break;
      case "Tab": keys=new ushort[]{0x09}; break;
      case "Backspace": keys=new ushort[]{0x08}; break;
      default: throw new Exception("NATIVE_INPUT_INVALID_ARGUMENT: unknown key");
    }
    List<INPUT> values=new List<INPUT>(); foreach(ushort key in keys) values.Add(Key(key,0,0));
    for(int i=keys.Length-1;i>=0;i--) values.Add(Key(keys[i],0,0x0002)); Send(values.ToArray());
  }
  public static void ReleaseAfterFailure() {
    INPUT[] values=new INPUT[]{Mouse(0x0004,0,0,0),Key(0x12,0,0x0002),Key(0x11,0,0x0002),Key(0x58,0,0x0002)};
    CleanupSent=(int)SendInput((uint)values.Length,values,InputSize);
  }
}
'@
  $nativeReady = $true
  [MouseClickNativeInput]::Prepare()
  $before = [MouseClickNativeInput]::Position()
  $foregroundBefore = [MouseClickNativeInput]::GetForegroundWindow().ToInt64().ToString()
  function PointValue([string]$name) {
    $property = $action.PSObject.Properties[$name]
    if ($null -eq $property -or $null -eq $property.Value) { throw "NATIVE_INPUT_INVALID_ARGUMENT: missing $name" }
    $number = [double]$property.Value
    if ([double]::IsNaN($number) -or [double]::IsInfinity($number) -or $number -ne [Math]::Truncate($number) -or $number -lt [int]::MinValue -or $number -gt [int]::MaxValue) { throw "NATIVE_INPUT_INVALID_ARGUMENT: invalid $name" }
    return [int]$number
  }
  switch -CaseSensitive ($action.kind) {
    'move' { [MouseClickNativeInput]::Move((PointValue 'x'),(PointValue 'y')) }
    'click' { [MouseClickNativeInput]::Click((PointValue 'x'),(PointValue 'y')) }
    'wheel' {
      $delta=PointValue 'delta'; if ([Math]::Abs([long]$delta) -gt 120000) { throw 'NATIVE_INPUT_INVALID_ARGUMENT: wheel delta outside limit' }
      [MouseClickNativeInput]::Wheel((PointValue 'x'),(PointValue 'y'),$delta)
    }
    'drag' { [MouseClickNativeInput]::Drag((PointValue 'x'),(PointValue 'y'),(PointValue 'x2'),(PointValue 'y2')) }
    'type' { if ($null -eq $action.text -or $action.text -isnot [string]) { throw 'NATIVE_INPUT_INVALID_ARGUMENT: text required' }; [MouseClickNativeInput]::Type($action.text) }
    'key' { [MouseClickNativeInput]::Chord([string]$action.key) }
    'probe' { }
  }
  $after = [MouseClickNativeInput]::Position()
  @{status='PASS';kind=$action.kind;sent=[MouseClickNativeInput]::Sent;expected=[MouseClickNativeInput]::Expected;lastError=[MouseClickNativeInput]::LastError;inputSize=[MouseClickNativeInput]::InputSize;position=@{x=$after.X;y=$after.Y};beforePosition=@{x=$before.X;y=$before.Y};foregroundHwnd=[MouseClickNativeInput]::GetForegroundWindow().ToInt64().ToString();foregroundBefore=$foregroundBefore;desktop=[MouseClickNativeInput]::DesktopName;sessionId=[Diagnostics.Process]::GetCurrentProcess().SessionId;userInteractive=[Environment]::UserInteractive;virtualBounds=[MouseClickNativeInput]::VirtualBounds()} | ConvertTo-Json -Depth 8 -Compress
} catch {
  $message = $_.Exception.Message
  $code = 'ENVIRONMENT_NATIVE_INPUT_DRIVER'
  if ($message -match '([A-Z][A-Z_]+):') { $code=$Matches[1] }
  $failure = @{status='FAIL';code=$code;error=$message;sent=0;expected=0}
  if ($nativeReady) {
    $failure.sent=[MouseClickNativeInput]::Sent; $failure.expected=[MouseClickNativeInput]::Expected
    $failure.lastError=[MouseClickNativeInput]::LastError; $failure.desktop=[MouseClickNativeInput]::DesktopName
    if ([MouseClickNativeInput]::Expected -gt 0) {
      try { [MouseClickNativeInput]::ReleaseAfterFailure(); $failure.cleanupSent=[MouseClickNativeInput]::CleanupSent } catch {}
    }
  }
  $failure | ConvertTo-Json -Depth 8 -Compress
  [Console]::Error.WriteLine($message)
  exit 1
}
