import { useEffect } from "react";
import type { Section } from "./useSection.js";

const SECTION_KEYS: Record<string, Section> = {
  "1": "tasks",
  "2": "prompts",
  "3": "providers",
  "4": "measurement",
  "5": "settings",
};

/** Register ⌘1..⌘5 shortcuts to switch sections. */
export function useHotkeys(navigate: (s: Section) => void): void {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!e.metaKey && !e.ctrlKey) return;
      const section = SECTION_KEYS[e.key];
      if (section) {
        e.preventDefault();
        navigate(section);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [navigate]);
}
