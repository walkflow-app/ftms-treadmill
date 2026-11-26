#!/usr/bin/env bash
# The model for an agent review on GitHub: always Sonnet, one review per commit. Writes model=… and why=… to
# $GITHUB_OUTPUT. Used by agent-review.yml and, for "@claude review", by claude.yml.
set -eo pipefail
model=sonnet
why="GitHub reviews with Sonnet only"
echo "model=$model" >> "$GITHUB_OUTPUT"
echo "why=$why" >> "$GITHUB_OUTPUT"
echo "Reviewing with $model ($why)"
