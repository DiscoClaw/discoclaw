#!/usr/bin/env bash
# pre-push-safety.sh — Reject pushes that would catastrophically delete files.
#
# Called by the pre-push hook before build+test. Reads the list of refs being
# pushed from stdin (standard git pre-push protocol) and validates each one.
#
# Escape valve: SKIP_SAFETY_CHECK=1 git push
# ---------------------------------------------------------------------------

set -euo pipefail

if [ "${SKIP_SAFETY_CHECK:-0}" = "1" ]; then
  exit 0
fi

# Minimum files threshold — only enforce ratio check on repos with >50 files
MIN_REPO_FILES=50
# If more than 50% of tracked files would be deleted, reject
MAX_DELETE_RATIO=50
# If the resulting tree has fewer than this many files, reject
MIN_TREE_FILES=10

while read -r local_ref local_sha remote_ref remote_sha; do
  # Skip branch deletions
  if [ "$local_sha" = "0000000000000000000000000000000000000000" ]; then
    continue
  fi

  # For new branches, compare against the merge-base with the default branch
  if [ "$remote_sha" = "0000000000000000000000000000000000000000" ]; then
    # Find the default branch
    default_branch=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@' || echo "main")
    remote_sha=$(git merge-base "$local_sha" "origin/$default_branch" 2>/dev/null || true)
    if [ -z "$remote_sha" ]; then
      # Can't determine merge-base — skip this ref (new repo or orphan branch)
      continue
    fi
  fi

  # Count total tracked files at the local (to-be-pushed) commit
  # Use || true to prevent pipefail from aborting if git fails (e.g. shallow clone)
  total_files=$(git ls-tree -r --name-only "$local_sha" 2>/dev/null | wc -l || true)

  # Count deleted files between remote and local
  deleted_files=$(git diff --diff-filter=D --name-only "$remote_sha".."$local_sha" 2>/dev/null | wc -l || true)

  # Skip ratio check for small repos
  total_at_remote=$(git ls-tree -r --name-only "$remote_sha" 2>/dev/null | wc -l || true)
  if [ "$total_at_remote" -le "$MIN_REPO_FILES" ]; then
    continue
  fi

  # Check 1: Deletion ratio
  if [ "$total_at_remote" -gt 0 ] && [ "$deleted_files" -gt 0 ]; then
    delete_pct=$((deleted_files * 100 / total_at_remote))
    if [ "$delete_pct" -gt "$MAX_DELETE_RATIO" ]; then
      echo ""
      echo "======================================================================"
      echo "  PRE-PUSH SAFETY CHECK FAILED"
      echo "======================================================================"
      echo ""
      echo "  Push to $remote_ref would delete $deleted_files of $total_at_remote files ($delete_pct%)."
      echo "  This exceeds the safety threshold of ${MAX_DELETE_RATIO}%."
      echo ""
      echo "  Ref:    $local_ref -> $remote_ref"
      echo "  Range:  $remote_sha..$local_sha"
      echo ""
      echo "  If this is intentional (e.g., major refactor), bypass with:"
      echo "    SKIP_SAFETY_CHECK=1 git push"
      echo ""
      echo "======================================================================"
      exit 1
    fi
  fi

  # Check 2: Resulting tree too small
  if [ "$total_files" -lt "$MIN_TREE_FILES" ] && [ "$total_at_remote" -gt "$MIN_REPO_FILES" ]; then
    echo ""
    echo "======================================================================"
    echo "  PRE-PUSH SAFETY CHECK FAILED"
    echo "======================================================================"
    echo ""
    echo "  Push to $remote_ref would result in only $total_files files in the tree."
    echo "  The remote currently has $total_at_remote files."
    echo "  This looks like the repo tree was replaced (e.g., git init)."
    echo ""
    echo "  Ref:    $local_ref -> $remote_ref"
    echo "  Range:  $remote_sha..$local_sha"
    echo ""
    echo "  If this is intentional, bypass with:"
    echo "    SKIP_SAFETY_CHECK=1 git push"
    echo ""
    echo "======================================================================"
    exit 1
  fi
done

exit 0
