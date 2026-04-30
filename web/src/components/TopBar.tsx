import { BookOpen } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { ProviderPill } from "./ProviderPill.js";
import { ModeToggle } from "./mode-toggle.js";
import type { ProviderStatus } from "./ProviderPill.js";
import { Logo } from "./Logo.js";

type Section =
  | "tasks"
  | "prompts"
  | "providers"
  | "measurement"
  | "settings"
  | "guide"
  | "ingest";

type ProviderInfo = { name: string; status: ProviderStatus };

type TopBarProps = {
  section: Section;
  providers: ProviderInfo[];
};

/* Section labels with initial caps */
const SECTION_LABELS: Record<Section, string> = {
  tasks: "Tasks",
  prompts: "Prompts",
  providers: "Providers",
  measurement: "Measurement",
  settings: "Settings",
  guide: "Guide",
  ingest: "Ingest",
};

export function TopBar({ section, providers }: TopBarProps) {
  return (
    <header className="flex items-center justify-between border-b border-border-default px-4 h-12 bg-bg-primary shrink-0">
      {/* Left: logo + breadcrumb */}
      <div className="flex items-center gap-2">
        <Logo />
        <span className="font-semibold text-sm text-text-primary">
          Orchestrator
        </span>
        <span className="text-text-tertiary text-sm">/</span>
        <span className="text-text-secondary text-sm">
          {SECTION_LABELS[section]}
        </span>
      </div>

      {/* Right: help icon + theme toggle + provider pills */}
      <div className="flex items-center gap-2">
        <Link
          to="/guide"
          className={`p-1.5 rounded transition-colors cursor-pointer ${
            section === "guide"
              ? "text-text-primary bg-bg-tertiary"
              : "text-text-tertiary hover:text-text-primary hover:bg-bg-secondary"
          }`}
          aria-label="Guide"
        >
          <BookOpen size={16} />
        </Link>
        <ModeToggle />
        {providers.map((p) => (
          <Link key={p.name} to="/providers" search={{ focus: p.name }}>
            <ProviderPill name={p.name} status={p.status} />
          </Link>
        ))}
      </div>
    </header>
  );
}

export type { ProviderInfo, TopBarProps };
