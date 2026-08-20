#!/bin/sh
#
# PreToolUse guard: refuses `git push` unless the current HEAD has been reviewed.
#
# Reads the Claude Code hook payload on stdin and answers with a permission
# decision. "Reviewed" means .git/review-marker holds the current HEAD SHA —
# written by scripts/mark-reviewed.sh after /code-review has actually run and
# its findings have been dealt with.
#
# The marker is per-commit on purpose. Amending, rebasing, or adding one more
# commit moves HEAD and invalidates it, so a review cannot be stretched to cover
# work it never saw.

payload=$(cat)
command=$(printf '%s' "$payload" | jq -r '.tool_input.command // ""' 2>/dev/null || echo "")

case "$command" in
  *"git push"*) ;;
  *) exit 0 ;;   # not a push; say nothing and let normal permissions apply
esac

head=$(git rev-parse HEAD 2>/dev/null || echo "no-head")
reviewed=$(cat .git/review-marker 2>/dev/null || echo "none")

if [ "$head" = "$reviewed" ]; then
  exit 0
fi

short_head=$(printf '%s' "$head" | cut -c1-8)
short_rev=$(printf '%s' "$reviewed" | cut -c1-8)

reason="This push has not been code reviewed.

  HEAD:     $short_head
  reviewed: $short_rev

Run /code-review high, deal with the findings, then record it:

  sh scripts/mark-reviewed.sh

See docs/CODE_REVIEW.md for what this codebase gets wrong repeatedly — every item
there is a bug that reached 'working' and was caught by running something rather
than by reading a diff."

jq -n --arg r "$reason" '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: $r
  }
}'
