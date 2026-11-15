#!/usr/bin/env bash
# Chooses the model for an agent review of pull request $PR: another model than the one that wrote the change. Written with
# Opus, Sonnet reviews, and the other way round; Haiku, Sonnet. The writer comes from the Co-Authored-By lines of the commits;
# a branch claude/… was written by claude.yml with the action's default model (Sonnet). Unclear (no or several writers): Opus
# for safety code, or more than 400 changed lines, else Sonnet.
# Writes model=… and why=… to $GITHUB_OUTPUT. Used by agent-review.yml and, for "@claude review", by claude.yml.
set -eo pipefail
COMPLEX='^src/(safety|protocol)/|^src/device/(treadmill|belt-commands|ble|reports|belt-state)\.ts$'
IGNORE='^package-lock\.json$'
pr=$(gh pr view "$PR" --json headRefName,commits,files)
writers=$( { jq -r '.commits[] | .messageHeadline + "\n" + .messageBody' <<<"$pr" |
               grep -io 'co-authored-by: claude [a-z]*' | awk '{print tolower($3)}' || true
             jq -r .headRefName <<<"$pr" | grep -q '^claude/' && echo sonnet || true; } | sort -u | paste -sd' ' -)
case "$writers" in
  opus) model=sonnet why="written with Opus" ;;
  sonnet) model=opus why="written with Sonnet" ;;
  haiku) model=sonnet why="written with Haiku" ;;
  *)
    complex=$(jq -r '.files[].path' <<<"$pr" | grep -E "$COMPLEX" | head -1 || true)
    lines=$(jq -r --arg ig "$IGNORE" '[.files[] | select(.path | test($ig) | not) | .additions + .deletions] | add // 0' <<<"$pr")
    if [ -n "$complex" ] || [ "$lines" -gt 400 ]; then model=opus; else model=sonnet; fi
    why="written by ${writers:-someone without a Co-Authored-By line}; ${complex:+touches $complex, }$lines changed lines" ;;
esac
echo "model=$model" >> "$GITHUB_OUTPUT"
echo "why=$why" >> "$GITHUB_OUTPUT"
echo "Reviewing with $model ($why)"
