$ErrorActionPreference = 'Stop'
# The one-time ticket comes through stdin, never the command line or output.
$consoleUrl = [Console]::In.ReadToEnd().Trim()
$parsed = [Uri]$consoleUrl
if (!$parsed.IsAbsoluteUri -or $parsed.UserInfo -or ($parsed.Scheme -ne 'https' -and !($parsed.Scheme -eq 'http' -and $parsed.IsLoopback))) { throw 'Invalid console address.' }
if (!$parsed.Fragment.StartsWith('#device-ticket=') -and !($parsed.Scheme -eq 'http' -and $parsed.Host -eq '127.0.0.1' -and $parsed.AbsolutePath -eq '/login' -and !$parsed.Query -and !$parsed.Fragment)) { throw 'Missing one-time sign-in ticket.' }
Start-Process -FilePath $parsed.AbsoluteUri | Out-Null
