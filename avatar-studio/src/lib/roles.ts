// Workspace roles, shared by the server and the pages: no server imports here.
import { z } from "zod";
import type { WorkspaceRole } from "./types";

/** Owners manage members, billing, and the account; editors create and change content; viewers watch and comment. */
export const WORKSPACE_ROLES = ["owner", "editor", "viewer"] as const satisfies readonly WorkspaceRole[];
export const roleSchema = z.enum(WORKSPACE_ROLES);

/** Whether a member with this role may create, change, or delete content. */
export function roleCanEdit(role: WorkspaceRole | null | undefined): boolean {
  return role === "owner" || role === "editor";
}

/** The role with its article, for sentences: "an owner", "an editor", "a viewer". */
export function roleArticle(role: string | null | undefined): string {
  return role === "owner" ? "an owner" : role === "viewer" ? "a viewer" : "an editor";
}
