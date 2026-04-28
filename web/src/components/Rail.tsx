import { List, FileText, Server, BarChart3, SlidersHorizontal } from "lucide-react";
import { Link } from "@tanstack/react-router";
import type { ComponentType } from "react";

type Section = "tasks" | "prompts" | "providers" | "measurement" | "settings" | "guide" | "ingest";

type RailItem = {
  section: Section;
  path: string;
  label: string;
  icon: ComponentType<{ size?: number; className?: string }>;
  shortcut: string;
};

const ITEMS: RailItem[] = [
  { section: "tasks", path: "/tasks", label: "Tasks", icon: List, shortcut: "⌘1" },
  { section: "prompts", path: "/prompts", label: "Prompts", icon: FileText, shortcut: "⌘2" },
  { section: "providers", path: "/providers", label: "Providers", icon: Server, shortcut: "⌘3" },
  { section: "measurement", path: "/measurement", label: "Measurement", icon: BarChart3, shortcut: "⌘4" },
  { section: "settings", path: "/settings", label: "Settings", icon: SlidersHorizontal, shortcut: "⌘5" },
];

type RailProps = {
  active: Section;
  onNavigate: (s: string) => void;
};

export function Rail({ active, onNavigate }: RailProps) {
  return (
    <nav className="flex flex-col justify-between w-52 border-r border-border-default bg-rail-bg shrink-0">
      <ul className="flex flex-col gap-0.5 p-2">
        {ITEMS.map(({ section, path, label, icon: Icon, shortcut }) => {
          const isActive = active === section;
          return (
            <li key={section}>
              <Link
                to={path as any}
                className={`flex w-full items-center gap-2.5 px-3 py-2 text-sm transition-colors cursor-pointer ${
                  isActive
                    ? "bg-bg-tertiary text-rail-active font-medium"
                    : "text-text-secondary hover:bg-rail-hover hover:text-text-primary"
                }`}
              >
                <Icon size={16} className="shrink-0" />
                <span className="flex-1 text-left">{label}</span>
                <kbd className="text-xs text-text-tertiary font-sans">{shortcut}</kbd>
              </Link>
            </li>
          );
        })}
      </ul>

      {/* Version tag at bottom */}
      <div className="px-4 py-3 text-xs text-text-tertiary">
        v0.1.0 · dev
      </div>
    </nav>
  );
}

export type { RailProps };
