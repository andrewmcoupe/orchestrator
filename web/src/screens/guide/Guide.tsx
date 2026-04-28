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

      <section className="mb-8">
        <h2 className="text-lg font-medium text-text-primary mb-3">
          Best Practices: Writing PRDs
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div>
            <h3 className="text-sm font-semibold text-green-400 mb-2">Do</h3>
            <ul className="space-y-2 text-sm text-text-secondary list-disc list-inside">
              <li>
                Use the grill-me skill (or similar structured interview process)
                before writing a PRD.
              </li>
              <li>
                Break requirements into small, atomic statements — each
                describing one change.
              </li>
              <li>Include acceptance criteria for each requirement.</li>
              <li>
                Reference specific files or modules when the change location is
                known.
              </li>
              <li>
                Specify what is out of scope to prevent over-engineering.
              </li>
              <li>
                Include context about why a change is needed, not just what.
              </li>
            </ul>
          </div>
          <div>
            <h3 className="text-sm font-semibold text-red-400 mb-2">Don't</h3>
            <ul className="space-y-2 text-sm text-text-secondary list-disc list-inside">
              <li>
                Write vague, high-level requirements that leave too much to
                interpretation.
              </li>
              <li>Bundle unrelated changes into a single PRD.</li>
              <li>
                Assume the LLM knows your project conventions — state them
                explicitly.
              </li>
              <li>Skip edge cases or error handling requirements.</li>
              <li>
                Write PRDs longer than necessary — conciseness improves
                extraction quality.
              </li>
            </ul>
          </div>
        </div>
      </section>

      <section className="mb-8">
        <h2 className="text-lg font-medium text-text-primary mb-3">Glossary</h2>
        <dl className="space-y-4 text-sm">
          <div>
            <dt className="font-bold text-text-primary">A/B Experiment</dt>
            <dd className="text-text-secondary mt-1">
              Test different prompt versions against task execution metrics to compare cost, success rate, and quality. A/B experiments help you iterate on prompts with data-driven confidence rather than guesswork.
            </dd>
          </div>
          <div>
            <dt className="font-bold text-text-primary">Attempt</dt>
            <dd className="text-text-secondary mt-1">
              A single execution run of a task. Each task can have multiple attempts with retry logic. Tracks phase summaries, gate results, audit verdict, files changed, cost, and outcome.
            </dd>
          </div>
          <div>
            <dt className="font-bold text-text-primary">Context Policy</dt>
            <dd className="text-text-secondary mt-1">
              Configuration controlling what code context is provided to the LLM during a phase — symbol graph depth, token budget, whether to include tests. Tuning context policies balances output quality against cost and latency.
            </dd>
          </div>
          <div>
            <dt className="font-bold text-text-primary">Event</dt>
            <dd className="text-text-secondary mt-1">
              An immutable fact recorded in the event store. All state changes in Orchestrator are captured as events, enabling full audit trails and reproducible projections.
            </dd>
          </div>
          <div>
            <dt className="font-bold text-text-primary">Event Store</dt>
            <dd className="text-text-secondary mt-1">
              The append-only SQLite log of all events. The single source of truth from which all projections are derived.
            </dd>
          </div>
          <div>
            <dt className="font-bold text-text-primary">Gate</dt>
            <dd className="text-text-secondary mt-1">
              A validation rule run before or after a phase. Can be built-in (from config.yaml) or library-based (custom definitions). Gates enforce quality and correctness checks.
            </dd>
          </div>
          <div>
            <dt className="font-bold text-text-primary">Phase</dt>
            <dd className="text-text-secondary mt-1">
              A stage in the task execution pipeline. Default phases are test-author (generate tests), implementer (generate code), and auditor (review quality). Each phase has its own transport, model, and context policy.
            </dd>
          </div>
          <div>
            <dt className="font-bold text-text-primary">PRD (Product Requirements Document)</dt>
            <dd className="text-text-secondary mt-1">
              The input document describing desired code changes. Ingested by Orchestrator to extract propositions and generate tasks.
            </dd>
          </div>
          <div>
            <dt className="font-bold text-text-primary">Preset</dt>
            <dd className="text-text-secondary mt-1">
              A reusable task configuration template bundling phase configs, gate definitions, retry policies, and auto-merge settings. Presets let you standardize workflows across your team.
            </dd>
          </div>
          <div>
            <dt className="font-bold text-text-primary">Projection</dt>
            <dd className="text-text-secondary mt-1">
              A derived read-model computed by replaying events from the event store. Projections provide the current state views displayed in the UI (task lists, provider health, cost dashboards).
            </dd>
          </div>
          <div>
            <dt className="font-bold text-text-primary">Proposition</dt>
            <dd className="text-text-secondary mt-1">
              An atomic requirement extracted from a PRD during ingestion. Each proposition has a confidence score and source location reference back to the original document.
            </dd>
          </div>
          <div>
            <dt className="font-bold text-text-primary">Provider</dt>
            <dd className="text-text-secondary mt-1">
              An external LLM or code tool integration (Claude Code, Codex, OpenAI API, Gemini CLI). Providers are monitored for health and latency.
            </dd>
          </div>
          <div>
            <dt className="font-bold text-text-primary">Pushback</dt>
            <dd className="text-text-secondary mt-1">
              An objection raised during PRD ingestion. Can be blocking (must resolve before proceeding), advisory (warning), or a question (needs clarification). Pushbacks must be resolved before tasks are created.
            </dd>
          </div>
          <div>
            <dt className="font-bold text-text-primary">Task</dt>
            <dd className="text-text-secondary mt-1">
              An executable unit of work created from one or more propositions. Tasks flow through a defined lifecycle and are executed by AI agents through configured phases.
            </dd>
          </div>
          <div>
            <dt className="font-bold text-text-primary">Transport</dt>
            <dd className="text-text-secondary mt-1">
              The specific CLI tool or API used to execute a phase (claude-code, codex, anthropic-api, aider, gemini-cli). The transport determines how Orchestrator communicates with the underlying model or tool.
            </dd>
          </div>
        </dl>
      </section>
    </div>
  );
}
