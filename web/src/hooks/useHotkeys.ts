import { useEffect } from "react";

const SECTION_PATHS = ["/tasks", "/prompts", "/providers", "/measurement", "/settings"] as const;

/** Register ⌘1..⌘5 shortcuts to switch sections via TanStack Router navigate. */
export function useHotkeys(navigate: (opts: { to: string }) => void): void {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!e.metaKey && !e.ctrlKey) return;
      const idx = parseInt(e.key, 10);
      if (idx >= 1 && idx <= 5) {
        e.preventDefault();
        navigate({ to: SECTION_PATHS[idx - 1] });
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [navigate]);
}
