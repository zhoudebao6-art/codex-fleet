"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, errorText, resetReadBackoff } from "./api";
import type { Overview, User } from "./types";
import { initializeDeviceLogin } from "./device-login";

const EMPTY: Overview = { nodes: [], tasks: [], events: [], files: [], cursor: 0 };

function identityScope(user: User | null) {
  if (!user) return "anonymous";
  return JSON.stringify([user.id, user.kind, user.role, user.nodeId || null, [...(user.projects || [])].sort(), user.access?.mode || "legacy", [...(user.access?.groupIds || [])].sort()]);
}

function visibleScope(user: User, nodes: Overview["nodes"]) {
  return identityScope(user) + (user.role !== "admin" && user.access?.mode === "groups" ? ":" + nodes.map(node => node.id).sort().join(",") : "");
}

export function useFleet() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [access, setAccess] = useState("loading");
  const [data, setData] = useState<Overview>(EMPTY);
  const [error, setError] = useState("");
  const [lastSync, setLastSync] = useState<number | null>(null);
  const [sessionScope, setSessionScope] = useState("anonymous");
  const [networkOnline, setNetworkOnline] = useState(true);
  const failures = useRef(0);
  const currentUser = useRef<User | null>(null);
  const dataScope = useRef("");
  const cursor = useRef(0);
  const activeRequest = useRef<Promise<void> | null>(null);
  const alive = useRef(true);

  const refresh = useCallback(async () => {
    if (activeRequest.current) return activeRequest.current;
    const request = (async () => {
      try {
        if (!navigator.onLine) { setNetworkOnline(false); return; }
        const result = await api<Overview & { user?: User }>(`/api/console/overview?${cursor.current ? `after=${cursor.current}` : "tail=100"}&limit=100`);
        if (!alive.current) return;
        const actualUser = result.user || currentUser.current;
        if (!actualUser) throw new ApiError("请重新登录", 401);
        const scope = visibleScope(actualUser, result.nodes)+":"+(result.viewRevision||"");
        const sameScope = dataScope.current === scope;
        const hadScope = !!dataScope.current;
        // A device can move out of a permitted group without changing the user's
        // grant. Clear event history and remount all detail views in that case too.
        cursor.current = hadScope && !sameScope ? 0 : result.cursor || cursor.current;
        dataScope.current = scope; currentUser.current = actualUser;
        setUser(actualUser); setSessionScope(scope);
        setData(previous => ({ ...result, events: Array.from(new Map([...(sameScope ? previous.events : []), ...(result.events || [])].map(e => [e.seq, e])).values()).sort((a, b) => b.seq - a.seq).slice(0, 300) }));
        failures.current = 0; setNetworkOnline(true); setAccess("ready"); setError(""); setLastSync(Date.now());
      } catch (err) {
        if (!alive.current) return;
        failures.current++;
        setError(errorText(err));
        if (err instanceof ApiError && [401, 403].includes(err.status)) {
          cursor.current = 0; dataScope.current = ""; currentUser.current = null;
          setData(EMPTY); setLastSync(null); setSessionScope("anonymous");
          setAccess(err.status === 401 ? "login" : "unauthorized"); setUser(null);
        }
      }
    })();
    activeRequest.current = request;
    try { await request; } finally { activeRequest.current = null; }
  }, []);

  useEffect(() => {
    alive.current = true;
    let cancelled = false; let cycle = 0;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() { const mine=++cycle; clearTimeout(timer); await refresh(); if (!cancelled && mine===cycle && currentUser.current) timer = setTimeout(poll, Math.max(document.hidden ? 30000 : 5000, Math.min(60000, 5000 * 2 ** Math.min(failures.current, 4)))); }
    async function init() {
      try {
        const response = await initializeDeviceLogin();
        if (cancelled) return;
        currentUser.current = response.user; setUser(response.user); setSessionScope(identityScope(response.user)); setAccess(response.user ? "ready" : "login");
        if (response.user) await poll();
      } catch (err) {
        if (cancelled) return;
        setError(errorText(err));
        setAccess(err instanceof ApiError && err.status === 403 ? "unauthorized" : err instanceof ApiError && err.status === 401 ? "login" : "error");
      } finally { if (!cancelled) setLoading(false); }
    }
    void init();
    const onVisible = () => { if (!document.hidden && currentUser.current) void poll(); };
    const onOnline = () => { resetReadBackoff(); setNetworkOnline(true); if (currentUser.current) void poll(); };
    const onOffline = () => setNetworkOnline(false);
    setNetworkOnline(navigator.onLine);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onOnline); window.addEventListener("offline", onOffline);
    return () => { cancelled = true; alive.current = false; clearTimeout(timer); document.removeEventListener("visibilitychange", onVisible); window.removeEventListener("online", onOnline); window.removeEventListener("offline", onOffline); };
  }, [refresh]);

  return { user, loading, access, data, error, lastSync, refresh, sessionScope, networkOnline };
}
