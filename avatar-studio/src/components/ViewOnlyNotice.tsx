import { Eye } from "lucide-react";

/** Shown on pages that create content when the active workspace gives the person the viewer role. */
export function ViewOnlyNotice({ what }: { what: string }) {
  return (
    <div role="status" data-testid="view-only" className="mb-4 flex items-start gap-2 rounded-lg border border-slate-200 bg-slate-50 px-4 py-2.5 text-sm text-slate-700">
      <Eye className="mt-0.5 h-4 w-4 shrink-0 text-slate-500" aria-hidden />
      <span>You are a viewer in this workspace, so you can look around but not {what}. Ask an owner to make you an editor, or switch to your personal space.</span>
    </div>
  );
}
