param([switch]$Configure,[string]$BackupDirectory='D:\codex+\backups\fleet-power')
. (Join-Path $PSScriptRoot 'Windows-Common.ps1')
Set-FleetCache
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$OutputEncoding=[Console]::OutputEncoding
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class FleetPowerCapabilities {
 [DllImport("powrprof.dll")] public static extern bool GetPwrCapabilities(IntPtr buffer);
 public static bool[] Read() {
  IntPtr p=Marshal.AllocHGlobal(256);
  try { if(!GetPwrCapabilities(p)) throw new Exception("GetPwrCapabilities failed");
   // SYSTEM_POWER_CAPABILITIES starts with BOOLEAN PowerButton, SleepButton,
   // LidPresent, SystemS1, SystemS2, SystemS3, SystemS4, SystemS5, HiberFilePresent.
   bool[] a=new bool[9];for(int i=0;i<a.Length;i++)a[i]=Marshal.ReadByte(p,i)!=0;return a;
  } finally {Marshal.FreeHGlobal(p);}
 }
}
'@
$errors=@();$adapters=@();$caps=$null
try{$caps=[FleetPowerCapabilities]::Read()}catch{$errors+=$_.Exception.Message}
$sleepText=(& powercfg.exe /a 2>&1 | Out-String).Trim()
$armed=@(& powercfg.exe /devicequery wake_armed 2>$null)
try{$physical=@(Get-NetAdapter -Physical -ErrorAction Stop)}catch{$physical=@();$errors+=$_.Exception.Message}
foreach($nic in $physical){
 $pm=$null;$setting='not_changed';$adapterFailure=$null;$magic='Unknown'
 try{
  $pm=Get-NetAdapterPowerManagement -Name $nic.Name -ErrorAction Stop
  $magic=[string]$pm.WakeOnMagicPacket
  # -NoRestart is essential: never bounce an active network adapter.
  if($Configure -and [string]$pm.WakeOnMagicPacket -eq 'Disabled'){
   New-Item -ItemType Directory -Path $BackupDirectory -Force|Out-Null
   Write-FleetJson (Join-Path $BackupDirectory ('adapter-'+$nic.ifIndex+'-'+(Get-Date -Format 'yyyyMMdd-HHmmss')+'.json')) @{name=$nic.Name;wakeOnMagicPacket=[string]$pm.WakeOnMagicPacket;wakeArmed=($armed -contains $nic.InterfaceDescription)}
   Set-NetAdapterPowerManagement -Name $nic.Name -WakeOnMagicPacket Enabled -NoRestart -ErrorAction Stop | Out-Null
   $setting='configured_pending_driver_apply'
   $pm=Get-NetAdapterPowerManagement -Name $nic.Name -ErrorAction Stop
   $magic=[string]$pm.WakeOnMagicPacket
  }
 }catch{
  $adapterFailure=$_.Exception.Message;$setting='driver_query_failed'
  try{
   $advanced=Get-NetAdapterAdvancedProperty -Name $nic.Name -RegistryKeyword '*WakeOnMagicPacket' -ErrorAction Stop
   if(@($advanced.RegistryValue)[0] -eq '1'){$magic='Enabled';$setting='driver_setting_enabled'}
   elseif(@($advanced.RegistryValue)[0] -eq '0'){$magic='Disabled'}
  }catch{}
 }
 if($Configure -and $magic -eq 'Enabled' -and !($armed -contains $nic.InterfaceDescription)){
  try{
   New-Item -ItemType Directory -Path $BackupDirectory -Force|Out-Null
   Write-FleetJson (Join-Path $BackupDirectory ('wake-armed-'+$nic.ifIndex+'-'+(Get-Date -Format 'yyyyMMdd-HHmmss')+'.json')) @{device=$nic.InterfaceDescription;wakeArmed=$false}
   & powercfg.exe /deviceenablewake $nic.InterfaceDescription 2>&1|Out-Null
   if($LASTEXITCODE -ne 0){throw 'Enabling adapter wake needs local Windows permission.'}
   $armed=@(& powercfg.exe /devicequery wake_armed 2>$null)
  }catch{$adapterFailure=$_.Exception.Message;$setting='needs_local_permission'}
 }
 $addresses=@()
 try{
  $gateway=Get-NetRoute -InterfaceIndex $nic.ifIndex -DestinationPrefix '0.0.0.0/0' -ErrorAction Stop | Sort-Object RouteMetric | Select-Object -First 1
  $neighbor=$null
  if($gateway){$neighbor=Get-NetNeighbor -InterfaceIndex $nic.ifIndex -IPAddress $gateway.NextHop -ErrorAction SilentlyContinue | Select-Object -First 1}
  foreach($ip in @(Get-NetIPAddress -InterfaceIndex $nic.ifIndex -AddressFamily IPv4 -ErrorAction Stop)){
   $addresses+=@{address=$ip.IPAddress;prefix=[int]$ip.PrefixLength;gateway=$(if($gateway){$gateway.NextHop}else{$null});gatewayMac=$(if($neighbor){$neighbor.LinkLayerAddress}else{$null})}
  }
 }catch{$errors+=$_.Exception.Message}
 $adapters+=@{name=$nic.Name;description=$nic.InterfaceDescription;mac=$nic.MacAddress;status=[string]$nic.Status;interfaceIndex=[int]$nic.ifIndex;wakeOnMagicPacket=$magic;wakeArmed=($armed -contains $nic.InterfaceDescription);configuration=$setting;error=$adapterFailure;addresses=$addresses}
}
@{at=(Get-Date).ToUniversalTime().ToString('o');sleep=@{s1=($caps -and $caps[3]);s2=($caps -and $caps[4]);s3=($caps -and $caps[5]);s4=($caps -and $caps[6]);hibernateEnabled=($caps -and $caps[8]);summary=$sleepText};adapters=$adapters;errors=$errors} | ConvertTo-Json -Depth 9 -Compress
