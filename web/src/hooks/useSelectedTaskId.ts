import { useState, useEffect, useCallback } from "react";

/**
 * Extracts a task ID from the URL hash when on the tasks section.
 * Hash format: #/tasks/:taskId
 * Returns [taskId | null, selectTask] where selectTask updates the hash.
 */
export function useSelectedTaskId(): [string | null, (id: string | null) => void] {
  const [taskId, setTaskId] = useState<string | null>(() => parseTaskId(window.location.hash));

  useEffect(() => {
    const onHashChange = () => setTaskId(parseTaskId(window.location.hash));
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const selectTask = useCallback((id: string | null) => {
    window.location.hash = id ? `#/tasks/${id}` : "#/tasks";
  }, []);

  return [taskId, selectTask];
}

function parseTaskId(hash: string): string | null {
  // Match #/tasks/:id but NOT #/tasks/:id/config or other sub-routes
  const match = hash.match(/^#\/tasks\/([^/]+)(?:\/.*)?$/);
  return match ? match[1] : null;
}
