import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { revisionConflict, type RevisionConflict } from "../../../api/errors";
import { emptyConfiguration, type MenuSection } from "../../../api/menu";
import { fetchLibraryDraft, libraryPayload, saveLibraryDraft, venueKeys, type LibraryDraft } from "../../../api/venues";
import { configurationError } from "../../menu/configuration";

export type SaveStatus = "loading" | "saved" | "saving" | "invalid" | "error" | "conflict";

const AUTOSAVE_MS = 900;

/** First problem of the draft that the server would refuse, or null. */
export function draftProblem(sections: MenuSection[]): string | null {
  for (const section of sections) {
    if (!section.name.trim()) return "У раздела нет названия";
    for (const item of section.items) {
      if (!item.name.trim()) return `В разделе «${section.name}» позиция без названия`;
      if (!Number.isInteger(item.price_minor) || item.price_minor < 0 || item.price_minor > 100_000_000) return `«${item.name}»: проверьте цену`;
      const error = configurationError(item.configuration ?? emptyConfiguration());
      if (error) return `«${item.name}»: ${error.toLocaleLowerCase("ru")}`;
    }
  }
  return null;
}

const snapshotOf = (sections: MenuSection[]) => JSON.stringify(libraryPayload(sections));

/**
 * Draft of one library menu with autosave.
 * Local edits live here until the server accepts them: a stale revision (409
 * `revision_conflict`) stops autosave and keeps every local change until the admin decides
 *. `seen_version` travels with each save, so the
 * conflict says what others changed since the version this device saw.
 */
export function useMenuDraft(menuId: string | null, publishedVersion: number | null) {
  const queryClient = useQueryClient();
  const [sections, setSections] = useState<MenuSection[]>([]);
  const [saved, setSaved] = useState("");
  const [revision, setRevision] = useState("");
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const [conflict, setConflict] = useState<RevisionConflict | null>(null);
  const seenVersion = useRef<number | null>(publishedVersion);
  const ownRevision = useRef("");

  const draft = useQuery({
    queryKey: venueKeys.draft(menuId ?? "none"),
    queryFn: () => fetchLibraryDraft(menuId!),
    enabled: Boolean(menuId),
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  const accept = useCallback((result: LibraryDraft, content: MenuSection[] = result.sections) => {
    ownRevision.current = result.revision;
    queryClient.setQueryData(venueKeys.draft(result.menu_id), result);
    setRevision(result.revision);
    setSaved(snapshotOf(content));
  }, [queryClient]);

  const snapshot = useMemo(() => snapshotOf(sections), [sections]);
  const loaded = Boolean(menuId && loadedFor === menuId);
  const dirty = loaded && snapshot !== saved;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  // Load (and reload after someone else's save) unless the admin has unsaved local edits.
  useEffect(() => {
    if (!draft.data || !menuId || draft.data.menu_id !== menuId) return;
    if (loadedFor === menuId && (dirtyRef.current || draft.data.revision === ownRevision.current)) return;
    setSections(draft.data.sections);
    setSaved(snapshotOf(draft.data.sections));
    setRevision(draft.data.revision);
    ownRevision.current = draft.data.revision;
    seenVersion.current = publishedVersion;
    setConflict(null);
    setLoadedFor(menuId);
  }, [draft.data, loadedFor, menuId, publishedVersion]);

  // A publication seen by this device moves the «seen» version forward.
  useEffect(() => {
    if (publishedVersion && (!seenVersion.current || publishedVersion > seenVersion.current) && !conflict) seenVersion.current = publishedVersion;
  }, [conflict, publishedVersion]);

  const save = useMutation({
    mutationFn: ({ content, expected }: { content: MenuSection[]; expected: string }) =>
      saveLibraryDraft(menuId!, content, expected, seenVersion.current),
    onSuccess: (result, { content }) => {
      accept(result, mergeKeys(content, result.sections));
      // Server keys (item_key) of new positions come back: adopt them without losing edits made meanwhile.
      setSections((current) => mergeKeys(current, result.sections));
      void queryClient.invalidateQueries({ queryKey: ["venue-menus"] });
    },
    onError: (error) => {
      const detail = revisionConflict(error);
      if (detail) setConflict(detail);
    },
  });

  const problem = useMemo(() => draftProblem(sections), [sections]);

  useEffect(() => {
    if (!loaded || !dirty || problem || save.isPending || save.isError || conflict) return;
    const timer = window.setTimeout(() => save.mutate({ content: sections, expected: revision }), AUTOSAVE_MS);
    return () => window.clearTimeout(timer);
  }, [conflict, dirty, loaded, problem, revision, save, sections]);

  // Leaving the page with unsaved edits asks first.
  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => {
      if (dirtyRef.current) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, []);

  const status: SaveStatus = !loaded
    ? "loading"
    : conflict
      ? "conflict"
      : problem
        ? "invalid"
        : save.isError
          ? "error"
          : dirty || save.isPending
            ? "saving"
            : "saved";

  /** Resolve a conflict: keep my edits on top of the current server draft, or take theirs. */
  const resolve = useMutation({
    mutationFn: async (choice: "mine" | "theirs") => {
      const fresh = await fetchLibraryDraft(menuId!);
      if (choice === "theirs") return { choice, fresh, result: fresh };
      seenVersion.current = conflict?.last_publication?.version ?? seenVersion.current;
      const result = await saveLibraryDraft(menuId!, sections, fresh.revision, seenVersion.current);
      return { choice, fresh, result };
    },
    onSuccess: ({ choice, result }) => {
      setConflict(null);
      save.reset();
      if (choice === "theirs") {
        setSections(result.sections);
      } else {
        setSections((current) => mergeKeys(current, result.sections));
      }
      accept(result, choice === "theirs" ? result.sections : mergeKeys(sections, result.sections));
      void queryClient.invalidateQueries({ queryKey: ["venue-menus"] });
    },
  });

  return {
    draft,
    sections,
    setSections,
    revision,
    status,
    problem,
    dirty,
    saving: save.isPending,
    saveError: save.isError && !conflict ? save.error : null,
    retrySave: () => save.reset(),
    conflict,
    resolve,
    seenVersion,
    /** Adopt a draft the server returned from another action (AI, copy). */
    adopt: (result: LibraryDraft) => {
      setSections(result.sections);
      accept(result);
    },
    loaded,
  };
}

/** Copies server `item_key`s onto local positions that did not have one yet (same place, same name). */
function mergeKeys(local: MenuSection[], server: MenuSection[]): MenuSection[] {
  let changed = false;
  const next = local.map((section, sectionIndex) => {
    const remote = server[sectionIndex];
    if (!remote || remote.name !== section.name) return section;
    const items = section.items.map((item, itemIndex) => {
      const match = remote.items[itemIndex];
      if (item.item_key || !match?.item_key || match.name !== item.name) return item;
      changed = true;
      return { ...item, item_key: match.item_key };
    });
    return items === section.items ? section : { ...section, items };
  });
  return changed ? next : local;
}
