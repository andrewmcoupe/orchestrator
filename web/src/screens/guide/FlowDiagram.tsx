import { ArrowRightIcon } from "@phosphor-icons/react";
import { cn } from "@shared/lib/utils";

export type FlowStep = {
  label: string;
  description?: string;
};

type FlowDiagramProps = {
  steps: FlowStep[];
  direction?: "horizontal" | "vertical";
  cols?: 5 | 6;
};

export function FlowDiagram({
  steps,
  direction = "horizontal",
  cols = 5,
}: FlowDiagramProps) {
  const isHorizontal = direction === "horizontal";
  const _colsClassName = cn(cols === 5 ? "grid-cols-5" : "grid-cols-6");

  return (
    <div
      className={` ${isHorizontal ? `grid grid-auto-cols grid-flow-col items-center flex-wrap` : "flex-col items-stretch"}`}
    >
      {steps.map((step, i) => (
        <>
          <div
            key={i}
            className={`flex ${isHorizontal ? "flex-row items-center" : "flex-col items-center"}`}
          >
            <div
              className={`
              border border-border-default rounded-md bg-secondary
              px-4 py-3 text-center
              ${isHorizontal ? "min-w-[120px] max-w-[180px]" : "w-full"}
            `}
            >
              <div className="text-sm font-medium text-text-primary">
                {step.label}
              </div>
              {step.description && (
                <div className="text-xs text-text-tertiary mt-1">
                  {step.description}
                </div>
              )}
            </div>
          </div>
          <div className="last:hidden">
            <ArrowRightIcon />
          </div>
        </>
      ))}
    </div>
  );
}
