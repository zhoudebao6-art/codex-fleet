"""Isolated skill release mechanics. Models repair/review; this helper gates writes.
No installed skill, account, Codex process or active workspace is modified.
"""
import argparse, base64, hashlib, io, json, os, pathlib, re, shutil, subprocess, sys, time, urllib.request, zipfile

REPOS = {'zhoudebao6-art/software-case-batch', 'zhoudebao6-art/software-system-delivery'}
def sha(b): return hashlib.sha256(b).hexdigest()
def blob(b): return hashlib.sha1(b'blob '+str(len(b)).encode()+b'\0'+b).hexdigest()
def save(p, v):
    p=pathlib.Path(p); p.parent.mkdir(parents=True,exist_ok=True)
    q=p.with_suffix(p.suffix+'.partial'); q.write_text(json.dumps(v,ensure_ascii=False,indent=2)+'\n',encoding='utf-8'); q.replace(p)
def read(p): return json.loads(pathlib.Path(p).read_text(encoding='utf-8-sig'))
def safe(root, name):
    assert isinstance(name,str) and name and '\\' not in name and ':' not in name
    assert all(p not in ('','..','.') for p in name.split('/'))
    target=(root/name).resolve(); assert target.is_relative_to(root.resolve())
    for p in [target,*target.parents]:
        if p==root.parent: break
        assert not p.is_symlink(),'Symlink rejected'
    return target
def env():
    e=os.environ.copy(); e.update(TEMP=r'D:\codex+\temp',TMP=r'D:\codex+\temp',TMPDIR=r'D:\codex+\temp')
    # Use only the node's already-configured proxy, never change system settings.
    cfg=pathlib.Path(r'D:\CodexFleet\config\node.json')
    if cfg.exists():
        proxy=read(cfg).get('proxyUrl')
        if proxy: e['HTTPS_PROXY']=proxy; e['HTTP_PROXY']=proxy
    return e
def api(route, data=None, binary=False):
    gh=next((p for p in [r'D:\codex+\tools\gh\bin\gh.exe',shutil.which('gh')] if p and pathlib.Path(p).exists()),None)
    if not gh:
        assert data is None,'Authenticated GitHub CLI is required for publication on the controller'
        proxy=env().get('HTTPS_PROXY'); opener=urllib.request.build_opener(urllib.request.ProxyHandler({'https':proxy} if proxy else {}))
        request=urllib.request.Request('https://api.github.com/'+route,headers={'User-Agent':'Codex-Fleet'})
        with opener.open(request,timeout=90) as response: result=response.read()
        return result if binary else json.loads(result)
    cmd=[gh,'api',route]
    if data is not None: cmd+=['--method','POST','--input','-']
    for attempt in range(3):
        r=subprocess.run(cmd,input=None if data is None else json.dumps(data).encode(),capture_output=True,env=env(),timeout=90)
        if r.returncode==0: return r.stdout if binary else json.loads(r.stdout)
        # Mutations have unknown outcomes: the caller must inspect the stable ref.
        if data is not None or attempt==2: raise RuntimeError('GitHub request failed: '+r.stderr.decode(errors='replace')[-500:])
        time.sleep(2**attempt)
def unpack(data, root, strip=False):
    root.mkdir(parents=True,exist_ok=True); seen=set(); total=0
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        for i in z.infolist():
            if i.is_dir(): continue
            name=i.filename.split('/',1)[-1] if strip else i.filename
            assert name.lower() not in seen; seen.add(name.lower())
            assert (i.external_attr>>16)&0o170000!=0o120000,'Archive symlink rejected'
            total+=i.file_size; assert total<96*1024*1024 and i.file_size<24*1024*1024
            p=safe(root,name); p.parent.mkdir(parents=True,exist_ok=True); p.write_bytes(z.read(i))
def snapshot(root):
    result={}
    for p in root.rglob('*'):
        assert not p.is_symlink(),'Linked source rejected'
        if p.is_file():
            name=p.relative_to(root).as_posix()
            if any(x in ('.git','__pycache__','.pytest_cache') for x in p.relative_to(root).parts): continue
            result[name]=p.read_bytes()
    return result
def tree_hash(files,modes):
    directories={'':{}}
    for name,data in files.items():
        parts=name.split('/');prefix=''
        for part in parts[:-1]:
            child=prefix+part+'/'
            directories.setdefault(prefix,{})[part]=('40000',child,True)
            directories.setdefault(child,{})
            prefix=child
        directories[prefix][parts[-1]]=(modes.get(name,'100644'),blob(data),False)
    def build(prefix):
        raw=b''
        for name,(mode,digest,directory) in sorted(directories[prefix].items(),key=lambda x:(x[0]+('/' if x[1][2] else '')).encode()):
            if directory:digest=build(digest)
            raw+=mode.encode()+b' '+name.encode()+b'\0'+bytes.fromhex(digest)
        return hashlib.sha1(b'tree '+str(len(raw)).encode()+b'\0'+raw).hexdigest()
    return build('')
def regression(plan,root,out):
    out.mkdir(parents=True,exist_ok=True)
    if plan['mode']=='validation':
        module=safe(root,'fleet_validation/'+plan['id']+'/normalize.py')
        script="import importlib.util,sys\ns=importlib.util.spec_from_file_location('candidate',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)\nfor value,expected in [('  abc  ','abc'),('\\ufeff  abc  ','abc'),(' 中文 ','中文'),('','')]:\n assert m.normalize_name(value)==expected,(repr(value),repr(m.normalize_name(value)))\nprint('4 frozen normalization regressions passed')\n"
        check=out/'frozen-check.py'; check.write_text(script,encoding='utf-8'); commands=[[sys.executable,str(check),str(module)]]
    else:
        commands=[]
        for t in plan['tests']:
            assert t['runtime'] in ('python','node') and isinstance(t.get('args',[]),list)
            entry=safe(root,t['path']); assert entry.is_file()
            assert all(isinstance(x,str) and len(x)<500 for x in t.get('args',[]))
            commands.append(([sys.executable] if t['runtime']=='python' else ['node'])+[str(entry),*t.get('args',[])])
        for t in plan.get('frozenTests',[]):
            assert t['runtime'] in ('python','node') and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,120}',t['name'])
            entry=safe(out.parent/'frozen-tests',t['name'])
            assert entry.is_file() and entry.stat().st_size==t['size'] and sha(entry.read_bytes())==t['sha'],'Frozen acceptance script mismatch'
            assert all(isinstance(x,str) and len(x)<500 for x in t.get('args',[]))
            commands.append(([sys.executable] if t['runtime']=='python' else ['node'])+[str(entry),*t.get('args',[])])
        assert commands,'At least one frozen regression required'
    records=[]
    for index,command in enumerate(commands):
        r=subprocess.run(command,cwd=root,env={**env(),'PYTHONDONTWRITEBYTECODE':'1'},capture_output=True,timeout=180)
        log=out/f'check-{index}.log'; log.write_bytes(r.stdout+b'\n'+r.stderr)
        records.append({'exitCode':r.returncode,'logSha':sha(log.read_bytes()),'command':command})
    return {'passed':all(x['exitCode']==0 for x in records),'checks':records}
def prepare(plan,root):
    state=root/'prepared.json'; candidate=root/'candidate'
    if state.exists():
        old=read(state); assert old['planHash']==sha(json.dumps(plan,sort_keys=True).encode()); return old
    assert not candidate.exists(),'Untracked candidate exists; preserve for inspection'
    data=api('repos/'+plan['repository']+'/zipball/'+plan['baseCommit'],binary=True)
    tree=api('repos/'+plan['repository']+'/git/trees/'+plan['baseCommit']+'?recursive=1')
    assert not tree.get('truncated') and all(x['type']=='tree' or x['type']=='blob' and x['mode'] in ('100644','100755') for x in tree['tree'])
    unpack(data,candidate,True); files=snapshot(candidate); base={x['path']:x for x in tree['tree'] if x['type']=='blob'}
    assert set(files)==set(base) and all(blob(v)==base[k]['sha'] for k,v in files.items()),'Base archive differs from GitHub'
    modes={k:v['mode'] for k,v in base.items()}
    if plan['mode']=='validation':
        p=safe(candidate,'fleet_validation/'+plan['id']+'/normalize.py');p.parent.mkdir(parents=True);p.write_text('def normalize_name(value):\n    return value.strip()\n',encoding='utf-8')
        (p.parent/'SKILL.md').write_text('---\nname: fleet-normalization-validation\ndescription: Isolated regression fixture for the unattended skill release workflow.\n---\nNormalize uploaded names: remove a leading UTF-8 BOM and surrounding whitespace; preserve internal text. This fixture is not a production business skill.\n',encoding='utf-8')
    before=regression(plan,candidate,root/'reproduction')
    stateData={'planHash':sha(json.dumps(plan,sort_keys=True).encode()),'base':{k:sha(v) for k,v in files.items()},'baseBlobs':{k:blob(v) for k,v in files.items()},'modes':modes,'reproduction':before}
    save(state,stateData);return stateData
def pack(plan,root,output):
    prepared=read(root/'prepared.json');assert prepared['planHash']==sha(json.dumps(plan,sort_keys=True).encode())
    candidate=root/'candidate';files=snapshot(candidate); changed=[k for k in set(files)|set(prepared['base']) if (sha(files[k]) if k in files else None)!=prepared['base'].get(k)]
    assert changed and all(any(k==a or k.startswith(a.rstrip('/')+'/') for a in plan['allowedPaths']) for k in changed),'Change escaped approved paths'
    assert not any(t['path'] in changed for t in plan['tests']),'Frozen regression scripts cannot be edited to pass'
    tests=regression(plan,candidate,root/'regression');assert tests['passed'],'Candidate regressions failed'
    assert not prepared['reproduction']['passed'],'Failure was not reproduced'
    output.parent.mkdir(parents=True,exist_ok=True);archive=output.parent/'candidate.zip'
    with zipfile.ZipFile(archive,'w',zipfile.ZIP_DEFLATED) as z:
        for k,v in sorted(files.items()):z.writestr(k,v)
    proof={'passed':True,'candidateSha':sha(archive.read_bytes()),'treeSha':tree_hash(files,prepared['modes']),'modes':prepared['modes'],'baseBlobs':prepared['baseBlobs'],'changed':sorted(changed),'tests':tests,'reproduction':prepared['reproduction']}
    save(output,proof);return proof
def verify_candidate(plan,root,archive,repair):
    data=pathlib.Path(archive).read_bytes();assert sha(data)==repair['candidateSha'],'Candidate checksum mismatch'
    target=root/('review-'+repair['candidateSha'][:16])
    if not target.exists():unpack(data,target)
    assert tree_hash(snapshot(target),repair['modes'])==repair['treeSha'],'Candidate tree mismatch'
    return target
def publish(plan,root,archive,repair,review):
    assert review['decision']=='pass' and review['candidateSha']==repair['candidateSha'] and review['treeSha']==repair['treeSha']
    target=verify_candidate(plan,root,archive,repair);assert regression(plan,target,root/'publish-regression')['passed']
    repo='repos/'+plan['repository'];branch='fleet-repair/'+plan['id'];receipt=root/'published.json'
    if receipt.exists():
        old=read(receipt);assert old['treeSha']==repair['treeSha'];return old
    # All blobs are content addressed. Retrying these writes cannot alter a ref.
    files=snapshot(target);entries=[]
    for name in sorted(files):
        content=files[name];digest=blob(content)
        # Existing immutable objects are reused when the candidate matches base.
        base=repair.get('baseBlobs',{})
        if base.get(name)!=digest:
            obj=api(repo+'/git/blobs',{'content':base64.b64encode(content).decode(),'encoding':'base64'});assert obj['sha']==digest
        entries.append({'path':name,'mode':repair['modes'].get(name,'100644'),'type':'blob','sha':digest})
    tree=api(repo+'/git/trees',{'tree':entries});assert tree['sha']==repair['treeSha']
    saved=root/'commit.json'
    if saved.exists():commit=read(saved)
    else:
        commit=api(repo+'/git/commits',{'message':'Fleet reviewed skill repair '+plan['id'],'tree':tree['sha'],'parents':[plan['baseCommit']]});save(saved,commit)
    assert commit['tree']['sha']==repair['treeSha']
    try:ref=api(repo+'/git/ref/heads/'+branch)
    except RuntimeError:ref=None
    if ref:assert ref['object']['sha']==commit['sha'],'Existing repair branch has another commit'
    else:
        try:api(repo+'/git/refs',{'ref':'refs/heads/'+branch,'sha':commit['sha']})
        except Exception:
            assert api(repo+'/git/ref/heads/'+branch)['object']['sha']==commit['sha'],'Branch publication outcome unknown'
    if plan['mode']=='production':
        current=api(repo+'/git/ref/heads/main')['object']['sha'];assert current in (plan['baseCommit'],commit['sha']),'Main advanced; rebase and review required'
        if current!=commit['sha']:
            # GitHub accepts POST for refs update with method override via gh.
            gh=next((p for p in [r'D:\codex+\tools\gh\bin\gh.exe','gh'] if p=='gh' or pathlib.Path(p).exists()))
            r=subprocess.run([gh,'api',repo+'/git/refs/heads/main','--method','PATCH','--input','-'],input=json.dumps({'sha':commit['sha'],'force':False}).encode(),capture_output=True,env=env(),timeout=90)
            assert api(repo+'/git/ref/heads/main')['object']['sha']==commit['sha'],'Main publication not confirmed'
    result={'passed':True,'commit':commit['sha'],'treeSha':tree['sha'],'candidateSha':repair['candidateSha'],'branch':branch,'mode':plan['mode'],'url':'https://github.com/'+plan['repository']+'/commit/'+commit['sha']}
    save(receipt,result);return result
def sync(plan,root,publication):
    commit=publication['commit']; assert re.fullmatch('[a-f0-9]{40}',commit)
    versions=root/'versions';target=versions/commit;manifest=target/'fleet-version.json'
    if not manifest.exists():
        # An interrupted download is retained for diagnosis; retry in a fresh
        # sibling and activate only a fully verified directory.
        stage=versions/(commit+'.partial-'+str(time.time_ns()))
        data=api('repos/'+plan['repository']+'/zipball/'+commit,binary=True);unpack(data,stage,True)
        # Resolve the commit to its tree explicitly. A tree endpoint accepting a
        # commit-ish can echo that commit in sha; it is not the tree identity.
        commit_data=api('repos/'+plan['repository']+'/git/commits/'+commit)
        assert commit_data['sha']==commit and commit_data['tree']['sha']==publication['treeSha'],'Published commit tree mismatch'
        tree=api('repos/'+plan['repository']+'/git/trees/'+publication['treeSha']+'?recursive=1');assert not tree.get('truncated')
        entries={x['path']:x for x in tree['tree'] if x['type']=='blob'};files=snapshot(stage)
        assert set(files)==set(entries) and all(blob(v)==entries[k]['sha'] for k,v in files.items()),'Published files mismatch'
        assert tree['sha']==publication['treeSha'],'Published tree mismatch'
        tests=regression(plan,stage,root/'sync-regression');assert tests['passed'],'Canary failed; previous version retained'
        save(stage/'fleet-version.json',{'commit':commit,'treeSha':tree['sha'],'files':{k:sha(v) for k,v in files.items()},'tests':tests});stage.rename(target)
    proof=read(manifest);assert proof['commit']==commit and proof['treeSha']==publication['treeSha'],'Stored version identity mismatch'
    files=snapshot(target);files.pop('fleet-version.json',None)
    assert {k:sha(v) for k,v in files.items()}==proof['files'],'Versioned files changed'
    active=root/'active.json';previous=read(active) if active.exists() else None
    if previous and previous.get('commit')!=commit:save(root/'previous.json',previous)
    save(active,{'commit':commit,'directory':str(target),'mode':plan['mode']})
    return {'passed':True,'commit':commit,'treeSha':publication['treeSha'],'directory':str(target),'filesVerified':len(files),'tests':proof['tests'],'installedSkillsUntouched':True}
def main():
    p=argparse.ArgumentParser();p.add_argument('action',choices=['prepare','pack','review-check','publish','sync']);p.add_argument('--plan',required=True);p.add_argument('--root',required=True);p.add_argument('--output',required=True);p.add_argument('--archive');p.add_argument('--repair');p.add_argument('--review');p.add_argument('--publication');a=p.parse_args()
    plan=read(a.plan);assert re.fullmatch(r'[\w-]{1,80}',plan['id']) and plan['repository'] in REPOS and re.fullmatch('[a-f0-9]{40}',plan['baseCommit']) and plan['mode'] in ('validation','production')
    root=pathlib.Path(a.root).resolve();root.mkdir(parents=True,exist_ok=True);assert not root.is_symlink();out=pathlib.Path(a.output).resolve();out.parent.mkdir(parents=True,exist_ok=True)
    if a.action=='prepare':result=prepare(plan,root)
    elif a.action=='pack':result=pack(plan,root,out)
    elif a.action=='review-check':
        repair=read(a.repair);target=verify_candidate(plan,root,a.archive,repair);tests=regression(plan,target,root/'review-regression');result={'passed':tests['passed'],'candidateSha':repair['candidateSha'],'treeSha':repair['treeSha'],'tests':tests,'directory':str(target)}
    elif a.action=='publish':result=publish(plan,root,a.archive,read(a.repair),read(a.review))
    else:result=sync(plan,root,read(a.publication))
    result.update(cycleId=plan['id'],phase=a.action);save(out,result);print(json.dumps({'cycleId':plan['id'],'phase':a.action,'passed':result.get('passed'),'output':str(out)},ensure_ascii=False))
if __name__=='__main__':main()
