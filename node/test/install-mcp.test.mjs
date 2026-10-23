import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

test('PowerShell 5.1 selects the Fleet MCP from multiple servers and still rejects foreign paths',{skip:process.platform!=='win32'},()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-mcp-parse-')),source=fs.readFileSync(fileURLToPath(new URL('../Install.ps1',import.meta.url)),'utf8');
  // Run the actual installer parser and path guard, without its installation side
  // effects. Keeping the production guard in this test prevents a permissive fix.
  const start=source.indexOf('        $mcpServers ='),end=source.indexOf('        } else {',start);assert.ok(start>=0&&end>start);
  fs.writeFileSync(path.join(root,'guard.ps1'),source.slice(start,end)+'\n        }\n');
  const script=String.raw`
param([string]$GuardFile)
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
if($PSVersionTable.PSVersion.Major -ne 5){throw 'Run this regression in Windows PowerShell 5.1'}
$node='D:\CodexFleet\runtime\node.exe';$app='D:\CodexFleet\app';$config='D:\CodexFleet\config\node.json'
$fleet=@{name='codex_fleet';transport=@{command=$node;args=@((Join-Path $app 'src\mcp.mjs'),'--config',$config)}}
$other=@{name='unrelated';transport=@{command='C:\Unrelated\node.exe';args=@('other.mjs')}}
$guard=[ScriptBlock]::Create([IO.File]::ReadAllText($GuardFile))
$cases=0
function Check-Registration($Servers,[int]$Expected,[bool]$Reject=$false){
 $existingText=ConvertTo-Json -InputObject @($Servers) -Depth 8
 $errorText=$null
 try{. $guard}catch{$errorText=$_.Exception.Message}
 if($Reject){if(!$errorText){throw 'Foreign or duplicate registration was accepted'}}
 else{if($errorText){throw $errorText};if(@($existing).Count -ne $Expected){throw 'Wrong MCP selection count'};if($Expected -eq 1 -and $existing.name -ne 'codex_fleet'){throw 'Selected a different MCP'}}
 $script:cases++
}
# Reproduce the old 5.1 bug with the exact original expression, then test its fix.
$existingText=ConvertTo-Json -InputObject @($other,$fleet) -Depth 8
$old=@(($existingText -join [Environment]::NewLine) | ConvertFrom-Json) | Where-Object {$_.name -eq 'codex_fleet'}
if(@($old).Count -ne 2){throw 'Regression fixture did not reproduce the 5.1 array bug'}
Check-Registration @() 0
Check-Registration @($other) 0
Check-Registration @($fleet) 1
Check-Registration @($other,$fleet) 1
Check-Registration @($fleet,$other) 1
Check-Registration @($fleet,$fleet) 0 $true
foreach($mismatch in @('command','config','script')){
 $foreign=($fleet | ConvertTo-Json -Depth 8) | ConvertFrom-Json
 if($mismatch -eq 'command'){$foreign.transport.command='C:\Other\node.exe'}
 elseif($mismatch -eq 'config'){$foreign.transport.args[2]='C:\Other\node.json'}
 else{$foreign.transport.args[0]='C:\Other\mcp.mjs'}
 Check-Registration @($other,$foreign) 0 $true
}
@{cases=$cases;powerShell=$PSVersionTable.PSVersion.ToString();oldBugReproduced=$true;pathGuardRetained=$true}|ConvertTo-Json -Compress
`;
  fs.writeFileSync(path.join(root,'test.ps1'),script);const env={...process.env,TEMP:os.tmpdir(),TMP:os.tmpdir(),TMPDIR:os.tmpdir()};for(const key of Object.keys(env))if(key.toLowerCase()==='psmodulepath')delete env[key];
  const output=execFileSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(root,'test.ps1'),'-GuardFile',path.join(root,'guard.ps1')],{encoding:'utf8',windowsHide:true,env});const result=JSON.parse(output);assert.equal(result.cases,9);assert.equal(result.oldBugReproduced,true);assert.equal(result.pathGuardRetained,true);
});
