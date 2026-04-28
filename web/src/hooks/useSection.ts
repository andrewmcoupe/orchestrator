import { useState, useEffect, useCallback } from "react";

export type Section = "tasks" | "prompts" | "providers" | "measurement" | "settings" | "guide";

const SECTIONS: Section[] = ["tasks", "prompts", "providers", "measurement", "settings", "guide"];

/** Parse section from location hash, defaulting to "tasks" */
function parseHash(hash: string): Section {
  const raw = hash.replace(/^#\/?/, "").split("/")[0];
  return SECTIONS.includes(raw as Section) ? (raw as Section) : "tasks";
}

/** Hash-based section routing. Returns current section + setter. */
export function useSection(): [Section, (s: Section) => void] {
  const [section, setSection] = useState<Section>(() => parseHash(window.location.hash));

  useEffect(() => {
    const onHashChange = () => setSection(parseHash(window.location.hash));
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const navigate = useCallback((s: Section) => {
    window.location.hash = `#/${s}`;
  }, []);

  return [section, navigate];
}

export { SECTIONS };
