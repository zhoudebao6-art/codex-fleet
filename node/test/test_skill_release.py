import importlib.util, io, json, pathlib, subprocess, tempfile, time, unittest, zipfile
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('release',pathlib.Path(__file__).parents[1]/'scripts'/'Skill-Release.py')
r=importlib.util.module_from_spec(spec);spec.loader.exec_module(r)

class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(dir=r'D:\codex+\temp');self.addCleanup(self.temp.cleanup)
        self.root=pathlib.Path(self.temp.name);self.plan={'id':'isolated-check','repository':'zhoudebao6-art/software-system-delivery','baseCommit':'a'*40,'mode':'validation','allowedPaths':['fleet_validation/isolated-check'],'tests':[]}
        self.base={'SKILL.md':b'Existing production skill remains unchanged.\n'}
    def archive(self,files):
        out=io.BytesIO()
        with zipfile.ZipFile(out,'w') as z:
            for k,v in files.items():z.writestr('repo/'+k,v)
        return out.getvalue()
    def api(self,route,*args,**kwargs):
        if '/zipball/' in route:return self.archive(self.base)
        if '/git/commits/' in route:return {'sha':route.rsplit('/',1)[-1],'tree':{'sha':r.tree_hash(self.base,{})}}
        return {'sha':r.tree_hash(self.base,{}),'tree':[{'path':k,'type':'blob','mode':'100644','sha':r.blob(v)} for k,v in self.base.items()]}
    def prepared(self):
        with patch.object(r,'api',side_effect=self.api):p=r.prepare(self.plan,self.root)
        self.assertFalse(p['reproduction']['passed']);return p
    def fixed(self):
        self.prepared();(self.root/'candidate/fleet_validation/isolated-check/normalize.py').write_text("def normalize_name(value):\n    return value.lstrip('\\ufeff').strip()\n",encoding='utf-8')
        return r.pack(self.plan,self.root,self.root/'result.json')
    def test_failure_reproduction_repair_and_frozen_scope(self):
        p=self.fixed();self.assertTrue(p['tests']['passed']);self.assertEqual(p['treeSha'],r.tree_hash(r.snapshot(self.root/'candidate'),p['modes']))
        (self.root/'candidate/SKILL.md').write_text('Changed unrelated skill')
        with self.assertRaises(AssertionError):r.pack(self.plan,self.root,self.root/'result.json')
    def test_unfixed_candidate_cannot_pass(self):
        self.prepared()
        with self.assertRaises(AssertionError):r.pack(self.plan,self.root,self.root/'result.json')
    def test_changed_review_candidate_rejected(self):
        p=self.fixed();target=r.verify_candidate(self.plan,self.root/'review',self.root/'candidate.zip',p)
        (target/'SKILL.md').write_text('tampered')
        with self.assertRaises(AssertionError):r.verify_candidate(self.plan,self.root/'review',self.root/'candidate.zip',p)
    def test_archive_traversal_rejected(self):
        out=io.BytesIO()
        with zipfile.ZipFile(out,'w') as z:z.writestr('../escape','bad')
        with self.assertRaises(AssertionError):r.unpack(out.getvalue(),self.root/'bad')
    def test_interrupted_sync_resumes_without_replacing_previous(self):
        p=self.fixed();self.base=r.snapshot(self.root/'candidate');pub={'commit':'b'*40,'treeSha':p['treeSha']}
        work=self.root/'sync';r.save(work/'active.json',{'commit':'c'*40,'directory':'previous'})
        calls=0
        def interrupted(route,*a,**kw):
            if '/git/trees/' in route:raise RuntimeError('Injected read interruption')
            return self.api(route,*a,**kw)
        with patch.object(r,'api',side_effect=interrupted),self.assertRaises(RuntimeError):r.sync(self.plan,work,pub)
        self.assertEqual(r.read(work/'active.json')['commit'],'c'*40)
        with patch.object(r,'api',side_effect=self.api):result=r.sync(self.plan,work,pub)
        self.assertTrue(result['passed']);self.assertEqual(r.read(work/'previous.json')['commit'],'c'*40)
        with patch.object(r,'api',side_effect=AssertionError('No repeat download')):self.assertTrue(r.sync(self.plan,work,pub)['passed'])
    def test_git_tree_matches_git_for_nested_realistic_layout(self):
        repo=self.root/'git-check';repo.mkdir();files={f'scripts/group-{i%5}/nested/file-{i}.py':f'content {i}\n'.encode() for i in range(100)}
        for k,v in files.items():p=repo/k;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(v)
        for args in [['init','-q'],['-c','core.autocrlf=false','add','.']]:subprocess.run(['git',*args],cwd=repo,capture_output=True,check=True,env=r.env())
        expected=subprocess.check_output(['git','write-tree'],cwd=repo,env=r.env()).decode().strip()
        start=time.perf_counter();self.assertEqual(r.tree_hash(files,{}),expected);self.assertLess(time.perf_counter()-start,2)
    def test_sync_resolves_commit_before_tree_and_rejects_mismatched_identity(self):
        p=self.fixed();self.base=r.snapshot(self.root/'candidate');pub={'commit':'b'*40,'treeSha':p['treeSha']};routes=[]
        def realistic(route,*args,**kwargs):
            routes.append(route)
            if '/git/trees/' in route and route.split('/git/trees/')[1].split('?')[0]==pub['commit']:
                return {**self.api(route),'sha':pub['commit']}
            return self.api(route,*args,**kwargs)
        with patch.object(r,'api',side_effect=realistic):self.assertTrue(r.sync(self.plan,self.root/'sync',pub)['passed'])
        self.assertTrue(any('/git/trees/'+p['treeSha']+'?' in x for x in routes))
        with patch.object(r,'api',side_effect=self.api),self.assertRaises(AssertionError):r.sync(self.plan,self.root/'bad-sync',{**pub,'treeSha':'e'*40})
        self.assertFalse((self.root/'bad-sync/active.json').exists())
        with self.assertRaises(AssertionError):r.sync(self.plan,self.root/'sync',{**pub,'treeSha':'e'*40})
    def test_review_cannot_publish_another_candidate(self):
        p=self.fixed()
        with self.assertRaises(AssertionError):r.publish(self.plan,self.root/'pub',self.root/'candidate.zip',p,{'decision':'pass','candidateSha':'0'*64,'treeSha':p['treeSha']})
    def test_new_requirement_uses_frozen_external_acceptance(self):
        source=b"from pathlib import Path\nassert 'required feature' in Path('SKILL.md').read_text()\n"
        plan={**self.plan,'mode':'production','tests':[],'frozenTests':[{'name':'acceptance.py','size':len(source),'sha':r.sha(source),'runtime':'python','args':[]}]}
        check=self.root/'frozen-tests/acceptance.py';check.parent.mkdir();check.write_bytes(source)
        candidate=self.root/'candidate';candidate.mkdir();(candidate/'SKILL.md').write_text('old behavior')
        self.assertFalse(r.regression(plan,candidate,self.root/'before')['passed'])
        (candidate/'SKILL.md').write_text('required feature')
        self.assertTrue(r.regression(plan,candidate,self.root/'after')['passed'])
        check.write_text('print("faked acceptance")')
        with self.assertRaises(AssertionError):r.regression(plan,candidate,self.root/'tampered')

if __name__=='__main__':unittest.main()
