param([Parameter(Mandatory=$true)][string]$Archive,[Parameter(Mandatory=$true)][string]$Manifest)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$m=Get-Content -LiteralPath $Manifest -Raw -Encoding UTF8 | ConvertFrom-Json
$zip=[IO.Compression.ZipFile]::OpenRead($Archive)
try {
  $entries=@{}; $prefix=$null
  foreach($entry in $zip.Entries) {
    if($entry.FullName.EndsWith('/')){continue}
    $parts=$entry.FullName.Split([char[]]@('/'),2,[StringSplitOptions]::None)
    if($parts.Count -ne 2 -or $parts[1] -match '(^|/)\.\.(/|$)|\\|:'){throw 'Unsafe archive path'}
    if($null -eq $prefix){$prefix=$parts[0]}
    if($prefix -ne $parts[0] -or $entries.ContainsKey($parts[1])){throw 'Ambiguous archive'}
    if($entry.Length -gt 20MB){throw 'Oversized skill source file'}
    $entries[$parts[1]]=$entry
  }
  if($entries.Count -ne $m.files.Count){throw 'Archive and GitHub tree have different file counts'}
  foreach($file in $m.files) {
    $entry=$entries[$file.path]; if(!$entry -or $entry.Length -ne $file.size){throw "Missing or changed source: $($file.path)"}
    $stream=$entry.Open(); $memory=New-Object IO.MemoryStream
    try {$stream.CopyTo($memory);$bytes=$memory.ToArray()} finally {$stream.Dispose();$memory.Dispose()}
    $sha1=[Security.Cryptography.SHA1]::Create();$sha256=[Security.Cryptography.SHA256]::Create()
    try {
      $header=[Text.Encoding]::UTF8.GetBytes("blob $($bytes.Length)`0")
      $null=$sha1.TransformBlock($header,0,$header.Length,$header,0)
      $null=$sha1.TransformFinalBlock($bytes,0,$bytes.Length)
      $gitBlob=([BitConverter]::ToString($sha1.Hash)).Replace('-','').ToLowerInvariant()
      if($gitBlob -ne $file.gitBlob){throw "Git blob mismatch: $($file.path)"}
      $sha=([BitConverter]::ToString($sha256.ComputeHash($bytes))).Replace('-','').ToLowerInvariant()
      $file | Add-Member -NotePropertyName sha256 -NotePropertyValue $sha -Force
    } finally {$sha1.Dispose();$sha256.Dispose()}
  }
  $m | Add-Member -NotePropertyName archiveVerified -NotePropertyValue $true -Force
  $archiveStream=[IO.File]::OpenRead($Archive);$archiveHasher=[Security.Cryptography.SHA256]::Create()
  try {$archiveHash=([BitConverter]::ToString($archiveHasher.ComputeHash($archiveStream))).Replace('-','').ToLowerInvariant()}
  finally {$archiveStream.Dispose();$archiveHasher.Dispose()}
  $m | Add-Member -NotePropertyName archiveSha256 -NotePropertyValue $archiveHash -Force
  $output=$m | ConvertTo-Json -Depth 12
  [IO.File]::WriteAllText($Manifest,$output,(New-Object Text.UTF8Encoding($false)))
  Write-Output "Verified $($m.files.Count) source files at $($m.commit)"
} finally {$zip.Dispose()}
