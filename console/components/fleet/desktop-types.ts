export type DesktopActivity = { id?: string; turnId?: string; at?: string | number; type: string; text?: string; toolType?: string; tool?: string; status?: string; exitCode?: number };
export type DesktopThread = {
  nodeId: string; nodeName?: string; threadId: string; title: string; preview?: string;
  cwd?: string; workspace?: string; project?: string; archived?: boolean; source?: string;
  updatedAt?: string | number; lastActivityAt?: string | number; recentActivityAt?: string | number;
  receivedAt?: string | number; detailReceivedAt?: string | number; detailUpdatedAt?: string | number; status?: string; statusSource?: string;
  pinned?: boolean; fleetTaskId?: string; fleetTaskNative?: boolean; fleetTaskStatus?: string; freshness?: string; statusFreshness?: string; detailPending?: boolean;
  latestUserMessage?: string; latestAssistantMessage?: string;
  latestMessage?: { text: string; role: "user" | "assistant"; at?: string | number | null } | null;
  messageState?: "ready" | "pending" | "syncing" | "empty";
  messages?: { id?: string; role: string; text: string; at?: string | number }[]; activities?: DesktopActivity[];
};
export type DesktopInventory = { nodeId: string; nodeName?: string; scannedAt?: string | number; receivedAt?: string | number; complete?: boolean; error?: string; count?: number; storedCount?: number; freshness?: string };
export type DesktopPage = { threads: DesktopThread[]; nextCursor?: string | null; total: number; inventories: DesktopInventory[] };
export type DesktopSummary = { nodes: { nodeId: string; nodeName?: string; inventory?: DesktopInventory | null; threads: DesktopThread[]; latestThread?: DesktopThread | null }[] };
