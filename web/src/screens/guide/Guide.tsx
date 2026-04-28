import { FlowDiagram, type FlowStep } from "./FlowDiagram";

const howItWorksSteps: FlowStep[] = [
  {
    label: "Ingest PRD",
    description: "Upload or paste a product requirements document",
  },
  {
    label: "Generate Tasks",
    description: "AI breaks the PRD into discrete tasks",
  },
  { label: "Implement", description: "Agents work on tasks in parallel" },
  { label: "Review", description: "Diffs are reviewed and approved" },
  {
    label: "Merge",
    description: "Approved changes merge to your current branch",
  },
];

const taskLifecycleSteps: FlowStep[] = [
  { label: "Draft", description: "Task created from PRD" },
  { label: "Queued", description: "Waiting to be actioned" },
  { label: "Running", description: "Agent implementing" },
  { label: "Awaiting Review", description: "Implementation complete" },
  { label: "Approved", description: "Review passed" },
  { label: "Merged", description: "Changes on current branch" },
];

export function Guide() {
  return (
    <div className="h-full overflow-y-auto p-6">
      <h1 className="text-xl font-semibold text-text-primary mb-6">Guide</h1>

      <section className="mb-8">
        <h2 className="text-lg font-medium text-text-primary mb-3">
          How It Works
        </h2>
        <p className="text-sm text-text-secondary mb-4">
          The orchestrator turns a product requirements document into merged
          code through an automated pipeline.
        </p>
        <FlowDiagram steps={howItWorksSteps} />
      </section>

      <section className="mb-8">
        <h2 className="text-lg font-medium text-text-primary mb-3">
          Task Lifecycle
        </h2>
        <p className="text-sm text-text-secondary mb-4">
          Each task moves through these states from creation to merge.
        </p>
        <FlowDiagram steps={taskLifecycleSteps} cols={6} />
      </section>
    </div>
  );
}
