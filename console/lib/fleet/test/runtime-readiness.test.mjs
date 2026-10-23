import test from 'node:test';
import assert from 'node:assert/strict';
import {runtimeIssue,desktopLaunchIssue} from '../runtime-readiness.mjs';
test('desktop readiness distinguishes online, bridge activation, capacity and maintenance',()=>{
  const node={last_seen:new Date().toISOString(),capabilities:{ready:true,desktopSessionBridge:true,conversationDispatch:true,parallelExecution:true}};
  assert.equal(runtimeIssue(node,{parallel:true}),null);
  const issue=patch=>runtimeIssue({...node,capabilities:{...node.capabilities,...patch}},{parallel:true});
  assert.match(issue({parallelExecution:false}),/升级/);
  assert.match(issue({desktopSessionBridge:false}),/未连接/);
  assert.match(issue({conversationDispatch:false}),/未激活/);
  assert.match(issue({ready:false}),/并发已满/);
  assert.match(issue({maintenance:{enabled:true}}),/维护/);
  assert.match(runtimeIssue({...node,last_seen:'2000-01-01'}),/过期/);
  assert.match(runtimeIssue({...node,capabilities:'{broken'}),/无效/);
  assert.match(runtimeIssue({...node,capabilities:{ready:true,desktopSessionBridge:true}}),/需要升级/);
  assert.equal(runtimeIssue({...node,capabilities:{ready:true,parallelExecution:true}},{parallel:true,requireDesktop:false}),null);
});

test('blocked launch shows a specific trust requirement and stale failure does not block a healthy bridge',()=>{
 const capabilities={ready:true,parallelExecution:true,desktopSessionBridge:false,conversationDispatch:false,desktopLaunch:{state:'failed',errorCode:'DESKTOP_APPLICATION_CONTROL_BLOCKED',error:'private untrusted diagnostic'}};
 const node={last_seen:new Date().toISOString(),capabilities};
 assert.match(runtimeIssue(node),/Windows 应用控制/);
 assert.equal(runtimeIssue(node).includes('private'),false);
 assert.equal(runtimeIssue(node,{requireDesktop:false}),null);
 assert.equal(desktopLaunchIssue({...capabilities,desktopSessionBridge:true}),null);
 assert.equal(runtimeIssue({...node,capabilities:{...capabilities,desktopSessionBridge:true,conversationDispatch:true}}),null);
 assert.match(desktopLaunchIssue({...capabilities,desktopLaunch:{state:'failed',errorCode:'DESKTOP_RELEASE_MISMATCH'}}),/同一版本/);
});
