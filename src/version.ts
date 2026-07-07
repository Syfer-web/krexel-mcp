import { createPatch } from "diff";
import type { FileVersionEntry, FileVersionsResponse } from "./schemas.js";

/**
 * list_file_versions helpers — generate unified diffs between consecutive
 * versions of a file. The worker may eventually return diffs itself; for
 * now we synthesize them locally from the file contents it ships back.
 */

/**
 * Compute a unified diff between two file contents. Returns undefined when
 * the contents are byte-identical (no diff to show).
 */
export function unifiedDiff(opts: {
  file: string;
  oldContent: string | null;
  newContent: string | null;
  oldLabel?: string;
  newLabel?: string;
}): string | undefined {
  const oldText = opts.oldContent ?? "";
  const newText = opts.newContent ?? "";
  if (oldText === newText) return undefined;
  const patch = createPatch(
    opts.file,
    oldText,
    newText,
    opts.oldLabel ?? "previous",
    opts.newLabel ?? "current",
  );
  return patch;
}

/**
 * Annotate a list of FileVersionEntry objects with `diff` fields comparing
 * each version to the one before it. Assumes entries are newest-first.
 * If `prevContent` is provided per entry (via a side-channel), that content
 * is used as the "old" side; otherwise the diff is left undefined.
 */
export interface VersionWithContent {
  deploy_id: string;
  parent_deploy_id: string | null;
  created_at: string;
  message?: string;
  content?: string | null;
}

export function buildHistoryWithDiffs(
  versions: VersionWithContent[],
  file: string,
): FileVersionEntry[] {
  const out: FileVersionEntry[] = [];
  for (let i = 0; i < versions.length; i++) {
    const cur = versions[i]!;
    const prev = versions[i + 1]; // next-older version
    const entry: FileVersionEntry = {
      deploy_id: cur.deploy_id,
      parent_deploy_id: cur.parent_deploy_id ?? null,
      created_at: cur.created_at,
    };
    if (cur.message !== undefined) entry.message = cur.message;
    if (prev && cur.content !== undefined && prev.content !== undefined) {
      const d = unifiedDiff({
        file,
        oldContent: prev.content,
        newContent: cur.content,
        oldLabel: prev.deploy_id,
        newLabel: cur.deploy_id,
      });
      if (d !== undefined) entry.diff = d;
    }
    out.push(entry);
  }
  return out;
}

/**
 * Construct a FileVersionsResponse from the inputs above.
 */
export function buildFileVersionsResponse(opts: {
  domain: string;
  file: string;
  versions: VersionWithContent[];
}): FileVersionsResponse {
  return {
    domain: opts.domain,
    file: opts.file,
    history: buildHistoryWithDiffs(opts.versions, opts.file),
  };
}