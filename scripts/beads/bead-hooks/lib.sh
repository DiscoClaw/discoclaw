#!/usr/bin/env bash
# lib.sh — DEPRECATED: bead Discord hooks have moved in-process.
#
# All Discord sync is now triggered automatically via TaskStore events
# (src/tasks/sync-watcher.ts). No external shell hooks are required.
#
# Utility functions below are retained only for any remaining scripts that
# source this file; they carry no bd CLI dependency.
set -euo pipefail

log() {
  echo "$*" >&2
}

get_emoji() {
  case "$1" in
    "open") echo "🟢" ;;
    "in_progress") echo "🟡" ;;
    "blocked") echo "⚠️" ;;
    "closed") echo "☑️" ;;
    *) echo "🟢" ;;
  esac
}

format_priority() {
  local priority="$1"
  if [[ -z "$priority" || "$priority" == "null" ]]; then
    priority="3"
  fi
  if [[ "$priority" =~ ^P ]]; then
    priority="${priority#P}"
  fi
  echo "P${priority}"
}

short_title() {
  local title="$1"
  local max_len=80

  if [[ -z "$title" || "$title" == "null" ]]; then
    title="Untitled"
  fi

  if [[ ${#title} -gt $max_len ]]; then
    echo "${title:0:$max_len}…"
  else
    echo "$title"
  fi
}

build_thread_name() {
  local bead_id="$1"
  local title="$2"
  local status="$3"

  local emoji short name
  emoji=$(get_emoji "$status")
  short=$(short_title "$title")
  local short_id="${bead_id#*-}"
  name="$emoji [$short_id] $short"

  if [[ ${#name} -gt 100 ]]; then
    name="${name:0:99}…"
  fi

  echo "$name"
}

truncate_message() {
  local text="$1"
  local max_len="$2"

  if [[ ${#text} -gt $max_len ]]; then
    echo "${text:0:$max_len}…"
  else
    echo "$text"
  fi
}
