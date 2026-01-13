$source = @"
using System;
using System.Runtime.InteropServices;
using System.ComponentModel;

public class Win32 {
    [DllImport("User32.dll")]
    public static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);
}

[StructLayout(LayoutKind.Sequential)]
public struct LASTINPUTINFO {
    public uint cbSize;
    public uint dwTime;
}
"@

Add-Type -TypeDefinition $source -Language CSharp 

$lii = New-Object LASTINPUTINFO
$lii.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf($lii)

if ([Win32]::GetLastInputInfo([ref]$lii)) {
    $idleMillis = [Environment]::TickCount - $lii.dwTime
    Write-Output $idleMillis
} else {
    Write-Output 0
}
