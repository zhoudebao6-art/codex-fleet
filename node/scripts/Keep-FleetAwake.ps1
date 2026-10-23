param([Parameter(Mandatory)][string]$LeaseFile,[Parameter(Mandatory)][string]$StatusFile,[Parameter(Mandatory)][int]$OwnerProcessId)
. (Join-Path $PSScriptRoot 'Windows-Common.ps1')
Set-FleetCache
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class FleetAwake {
 [DllImport("kernel32.dll", SetLastError=true)] public static extern uint SetThreadExecutionState(uint flags);
 [StructLayout(LayoutKind.Sequential)] public struct PowerStatus { public byte ACLineStatus,BatteryFlag,BatteryLifePercent,SystemStatusFlag; public uint BatteryLifeTime,BatteryFullLifeTime; }
 [DllImport("kernel32.dll")] public static extern bool GetSystemPowerStatus(out PowerStatus value);
 public static int AC() { PowerStatus p; return GetSystemPowerStatus(out p)?p.ACLineStatus:255; }
}
'@
try{
 while(Get-Process -Id $OwnerProcessId -ErrorAction SilentlyContinue){
  $hold=$false;$reason='lease_expired';$ac=[FleetAwake]::AC()
  try{
   $lease=Read-FleetJson $LeaseFile
   if([datetime]::Parse($lease.expires).ToUniversalTime() -gt [datetime]::UtcNow){
    $hold=($lease.mode -ne 'off') -and ($lease.busy -eq $true -or ($lease.mode -eq 'available' -and $ac -ne 0))
    $reason=if($hold){if($lease.busy){'working'}else{'available_on_ac'}}else{'released'}
   }
  }catch{}
  $flags=[uint32]2147483648
  if($hold){$flags=[uint32]2147483649}
  $result=[FleetAwake]::SetThreadExecutionState($flags)
  Write-FleetJson $StatusFile @{at=[datetime]::UtcNow.ToString('o');active=($hold -and $result -ne 0);apiOk=($result -ne 0);reason=$reason;acLineStatus=$ac;pid=$PID}
  Start-Sleep -Seconds 5
 }
}finally{[FleetAwake]::SetThreadExecutionState([uint32]2147483648)|Out-Null}
