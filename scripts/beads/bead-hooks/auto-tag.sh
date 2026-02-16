#!/usr/bin/env bash
# auto-tag.sh — Use Haiku to classify bead content into tags.
# Usage: auto-tag.sh <title> [description]
# Output: comma-separated tag names (e.g., "feature,ops")
# Returns empty string if classification fails.
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
MODEL="${DISCOCLAW_BEADS_AUTO_TAG_MODEL:-claude-haiku-4-5-20251001}"

title="${1:-}"
description="${2:-}"

[[ -z "$title" ]] && exit 0

# Load API key from env or Anthropic default
api_key="${ANTHROPIC_API_KEY:-}"
if [[ -z "$api_key" ]]; then
  echo "" # fail silently — tags are optional
  exit 0
fi

# Load available tags from tag-map, excluding status tags.
if [[ -n "${DISCOCLAW_DATA_DIR:-}" ]]; then
  _default_tag_map="$DISCOCLAW_DATA_DIR/beads/tag-map.json"
else
  _default_tag_map="$SCRIPT_DIR/tag-map.json"
fi
TAG_MAP="${DISCOCLAW_BEADS_TAG_MAP:-$_default_tag_map}"
content_tags_json=$(jq '{} + (to_entries | map(select(.key != "open" and .key != "in_progress" and .key != "blocked" and .key != "closed")) | from_entries)' "$TAG_MAP" 2>/dev/null) || { echo ""; exit 0; }
available_tags=$(echo "$content_tags_json" | jq -r 'keys | join(", ")') || { echo ""; exit 0; }

prompt="Classify this task into 1-3 tags from this list: $available_tags

Rules:
- feature: new capabilities, enhancements, new functionality
- bug: broken behavior, fixes, regressions
- ops: operations, monitoring, audits, cron jobs, health checks
- infra: infrastructure, Docker, services, networking, servers
- personal: personal life tasks (non-technical)
If the task is clearly personal/life stuff, use ONLY the personal tag.

Return ONLY a comma-separated list of tag names, nothing else.
Example: feature,ops

Title: $title
Description: ${description:-(none)}"

response=$(curl -s --max-time 10 "https://api.anthropic.com/v1/messages" \
  -H "x-api-key: $api_key" \
  -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d "$(jq -n \
    --arg model "$MODEL" \
    --arg prompt "$prompt" \
    '{model: $model, max_tokens: 50, messages: [{role: "user", content: $prompt}]}')" 2>/dev/null)

tags=$(echo "$response" | jq -r '.content[0].text // empty' 2>/dev/null | tr -d ' \n')

if [[ -n "$tags" ]]; then
  valid_tags=""
  IFS=',' read -ra tag_arr <<< "$tags"
  for tag in "${tag_arr[@]}"; do
    tag=$(echo "$tag" | tr -d '[:space:]')
    if echo "$content_tags_json" | jq -e --arg t "$tag" '.[$t] // empty' >/dev/null 2>&1; then
      [[ -n "$valid_tags" ]] && valid_tags="$valid_tags,$tag" || valid_tags="$tag"
    fi
  done
  echo "$valid_tags"
else
  echo ""
fi
