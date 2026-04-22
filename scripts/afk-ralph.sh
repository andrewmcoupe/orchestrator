#!/bin/bash
set -eo pipefail

# Validate that the first argument is a positive integer
if ! [[ "${1:-}" =~ ^[1-9][0-9]*$ ]]; then
  echo "Usage: $0 <iterations> [slug]"
  echo "  iterations: positive integer — number of PRD features to process"
  echo "  slug:       optional — subfolder name under tasks/todo/"
  exit 1
fi

ITERATIONS="$1"
SLUG="${2:-}"

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
    echo "Please specify a slug: $0 $ITERATIONS <slug>"
    exit 1
  fi
fi

PRD_PATH="tasks/todo/$SLUG/PRD.json"
PROGRESS_PATH="tasks/todo/$SLUG/progress.md"
DONE_PATH="tasks/done/$SLUG"

# Verify the task folder and PRD exist
if [[ ! -f "$PRD_PATH" ]]; then
  echo "Error: PRD not found at $PRD_PATH"
  exit 1
fi

echo "Working on task: $SLUG"
echo "  PRD:      $PRD_PATH"
echo "  Progress: $PROGRESS_PATH"

# jq filter: extract streamed assistant text responses, normalise newlines for terminal output
stream_text='select(.type == "assistant").message.content[]? | select(.type == "text").text // empty | gsub("\n"; "\r\n") | . + "\r\n\n"'

# jq filter: extract the final result string from the stream-json output
final_result='select(.type == "result").result // empty'

# Loop for the requested number of iterations, one PRD feature per iteration
for ((i=1; i<=ITERATIONS; i++)); do
  # Create a temp file to capture the full JSON stream for post-processing
  tmpfile=$(mktemp)
  trap "rm -f $tmpfile" EXIT

  # Run Claude in non-interactive mode with the PRD and progress context,
  # instructing it to implement the single highest-priority feature,
  # verify types/tests, update the PRD and progress log, then commit
  claude \
    --permission-mode acceptEdits \
    --verbose \
    --print \
    --output-format stream-json \
    -p "@$PRD_PATH @$PROGRESS_PATH \
    1. Find the highest-priority feature to work on and work only on that feature. \
    This should be the one YOU decide has the highest priority - not necessarily the first in the list. \
    2. Use the tdd skill if appropriate, to write tests for the feature before implementing it. \
    3. Check that the types check via pnpm typecheck and that the tests pass via pnpm test \
    4. Update the PRD with the work that was done. \
    5. Append your progress to the progress file. \
    Keep it concise: summarise what was done and which PRD items were completed. Git history covers the implementation detail. \
    6. Make a git commit of that feature. \
    ONLY WORK ON A SINGLE FEATURE. \
    If, while implementing the feature, you notice the PRD is complete, output <promise>COMPLETE</promise>" \
  | grep --line-buffered '^{' \
  | tee "$tmpfile" \
  | jq --unbuffered -rj "$stream_text"

  # Parse the final result from the captured JSON stream
  result=$(jq -r "$final_result" "$tmpfile")
  echo "$result"

  # If Claude signals the PRD is fully complete, move task to done and exit early
  if [[ "$result" == *"<promise>COMPLETE</promise>"* ]]; then
    echo "PRD complete after $i iterations."
    mkdir -p "$(dirname "$DONE_PATH")"
    mv "tasks/todo/$SLUG" "$DONE_PATH"
    echo "Moved tasks/todo/$SLUG → $DONE_PATH"
    exit 0
  fi
done
