import { List, FileText, Server, BarChart3, SlidersHorizontal } from "lucide-react";
import { Link } from "@tanstack/react-router";
import type { ComponentType } from "react";

type RailItem = {
  path: string;
  label: string;
  icon: ComponentType<{ size?: number; className?: string }>;
  shortcut: string;
};

const ITEMS: RailItem[] = [
  { path: "/tasks", label: "Tasks", icon: List, shortcut: "⌘1" },
  { path: "/prompts", label: "Prompts", icon: FileText, shortcut: "⌘2" },
  { path: "/providers", label: "Providers", icon: Server, shortcut: "⌘3" },
  { path: "/measurement", label: "Measurement", icon: BarChart3, shortcut: "⌘4" },
  { path: "/settings", label: "Settings", icon: SlidersHorizontal, shortcut: "⌘5" },
];

export function Rail() {
  return (
    <nav className="flex flex-col justify-between w-52 border-r border-border-default bg-rail-bg shrink-0">
      <ul className="flex flex-col gap-0.5 p-2">
        {ITEMS.map(({ path, label, icon: Icon, shortcut }) => (
          <li key={path}>
            <Link
              to={path as any}
              activeOptions={{ includeSearch: false }}
              className="flex w-full items-center gap-2.5 px-3 py-2 text-sm transition-colors cursor-pointer text-text-secondary hover:bg-rail-hover hover:text-text-primary"
              activeProps={{
                className:
                  "flex w-full items-center gap-2.5 px-3 py-2 text-sm transition-colors cursor-pointer bg-bg-tertiary text-rail-active font-medium",
              }}
            >
              <Icon size={16} className="shrink-0" />
              <span className="flex-1 text-left">{label}</span>
              <kbd className="text-xs text-text-tertiary font-sans">{shortcut}</kbd>
            </Link>
          </li>
        ))}
      </ul>

      {/* Version tag at bottom */}
      <div className="px-4 py-3 text-xs text-text-tertiary">
        v0.1.0 · dev
      </div>
    </nav>
  );
}
