import { Badge } from "@web/src/components/ui/badge";

type ProviderStatus = "healthy" | "degraded" | "down" | "unknown";

type ProviderPillProps = {
  name: string;
  status: ProviderStatus;
};

const STATUS_DOT_COLORS: Record<ProviderStatus, string> = {
  healthy: "bg-status-healthy",
  degraded: "bg-status-warning",
  down: "bg-status-danger",
  unknown: "bg-status-muted",
};

export function ProviderPill({ name, status }: ProviderPillProps) {
  return (
    <Badge
      variant="outline"
      className="cursor-pointer gap-1.5 px-3 py-1 text-xs hover:bg-bg-secondary transition-colors"
    >
      <span className={`inline-block h-2 w-2 rounded-full ${STATUS_DOT_COLORS[status]}`} />
      {name}
    </Badge>
  );
}

export type { ProviderStatus, ProviderPillProps };
