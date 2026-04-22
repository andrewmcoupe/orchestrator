type ProviderStatus = "healthy" | "degraded" | "down" | "unknown";

type ProviderPillProps = {
  name: string;
  status: ProviderStatus;
  onClick?: () => void;
};

const STATUS_DOT_COLORS: Record<ProviderStatus, string> = {
  healthy: "bg-status-healthy",
  degraded: "bg-status-warning",
  down: "bg-status-danger",
  unknown: "bg-status-muted",
};

export function ProviderPill({ name, status, onClick }: ProviderPillProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-1.5 rounded-full border border-border-default px-3 py-1 text-sm text-text-primary hover:bg-bg-secondary transition-colors cursor-pointer"
    >
      <span className={`inline-block h-2 w-2 rounded-full ${STATUS_DOT_COLORS[status]}`} />
      {name}
    </button>
  );
}

export type { ProviderStatus, ProviderPillProps };
