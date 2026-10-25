"use client";
import { useApi } from "@/hooks/useApi";
import { roleCanEdit } from "@/lib/roles";
import type { WorkspaceRole } from "@/lib/types";

interface Summary {
  personalId: string;
  activeId: string;
  workspaces: Array<{ id: string; role: WorkspaceRole | null }>;
}

/**
 * Whether the signed-in person may create and change content where they are working now: always
 * in their personal space, and in a workspace unless they are a viewer there. `null` while loading,
 * so pages do not flash a view-only state for an editor. The server enforces the same rule.
 */
export function useCanEdit(): boolean | null {
  const { data, error } = useApi<Summary>("/api/workspaces");
  if (error) return true; // The server still answers 403 if it must; never lock a page on a failed read.
  if (!data) return null;
  if (data.activeId === data.personalId) return true;
  const ws = data.workspaces.find((w) => w.id === data.activeId);
  return ws ? roleCanEdit(ws.role) : true;
}

/**
 * Where the person is working and as what: `null` while loading (or if the list fails), otherwise
 * their own user id and, in a workspace, their role there (`role` is null in a personal space).
 */
export function useWorkspaceRole(): { userId: string; workspaceId: string | null; role: WorkspaceRole | null } | null {
  const { data } = useApi<Summary>("/api/workspaces");
  if (!data) return null;
  if (data.activeId === data.personalId) return { userId: data.personalId, workspaceId: null, role: null };
  const ws = data.workspaces.find((w) => w.id === data.activeId);
  return { userId: data.personalId, workspaceId: data.activeId, role: ws?.role ?? null };
}
