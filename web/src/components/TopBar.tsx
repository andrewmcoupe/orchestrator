import { ProviderPill } from "./ProviderPill.js";
import type { ProviderStatus } from "./ProviderPill.js";
import type { Section } from "../hooks/useSection.js";

type ProviderInfo = { name: string; status: ProviderStatus };

type TopBarProps = {
  section: Section;
  providers: ProviderInfo[];
  onProviderClick?: (name: string) => void;
};

/* Section labels with initial caps */
const SECTION_LABELS: Record<Section, string> = {
  tasks: "Tasks",
  prompts: "Prompts",
  providers: "Providers",
  measurement: "Measurement",
  settings: "Settings",
};

export function TopBar({ section, providers, onProviderClick }: TopBarProps) {
  return (
    <header className="flex items-center justify-between border-b border-border-default px-4 h-12 bg-bg-primary shrink-0">
      {/* Left: logo + breadcrumb */}
      <div className="flex items-center gap-2">
        <span className="inline-block h-3.5 w-3.5 rounded-full bg-bg-inverse" />
        <span className="font-semibold text-sm text-text-primary">Orchestrator</span>
        <span className="text-text-tertiary text-sm">/</span>
        <span className="text-text-secondary text-sm">{SECTION_LABELS[section]}</span>
      </div>

      {/* Right: ⌘K hint + provider pills */}
      <div className="flex items-center gap-2">
        <span className="hidden sm:flex items-center gap-1 border border-border-default px-2.5 py-1 text-xs text-text-tertiary">
          <kbd className="font-sans">⌘K</kbd>
          <span>command</span>
        </span>
        {providers.map((p) => (
          <ProviderPill
            key={p.name}
            name={p.name}
            status={p.status}
            onClick={() => onProviderClick?.(p.name)}
          />
        ))}
      </div>
    </header>
  );
}

export type { ProviderInfo, TopBarProps };
