#!/bin/bash
set -eo pipefail

SLUG="${1:-}"

# Resolve slug: use provided value, auto-select if exactly one folder, or error
if [[ -z "$SLUG" ]]; then
  folders=()
  for d in tasks/todo/*/; do
    [[ -d "$d" ]] && folders+=("$(basename "$d")")
  done

  if [[ ${#folders[@]} -eq 0 ]]; then
    echo "Error: No task folders found in tasks/todo/. Create one first (e.g. via /make-prd)."
    exit 1
  elif [[ ${#folders[@]} -eq 1 ]]; then
    SLUG="${folders[0]}"
    echo "Auto-selected task: $SLUG"
  else
    echo "Error: Multiple task folders found in tasks/todo/:"
    printf "  - %s\n" "${folders[@]}"
    echo "Please specify a slug: $0 <slug>"
    exit 1
  fi
fi

PRD_PATH="tasks/todo/$SLUG/PRD.json"
PROGRESS_PATH="tasks/todo/$SLUG/progress.md"

# Verify the task folder and PRD exist
if [[ ! -f "$PRD_PATH" ]]; then
  echo "Error: PRD not found at $PRD_PATH"
  exit 1
fi

echo "Working on task: $SLUG"
echo "  PRD:      $PRD_PATH"
echo "  Progress: $PROGRESS_PATH"

claude --permission-mode acceptEdits "@$PRD_PATH @$PROGRESS_PATH \
1. Read the PRD and progress file. \
2. Find the highest-priority incomplete task and implement it. \
3. Use TDD where relevant, check that the types check via pnpm typecheck and that the tests pass via pnpm test. \
4. Update the PRD with the work that was done. \
5. Append your progress to the progress file. \
Keep it concise: summarise what was done and which PRD items were completed. Git history covers the implementation detail. \
6. Make a git commit of that feature. \
ONLY WORK ON A SINGLE TASK."
