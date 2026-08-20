#!/bin/sh
#
# Records that the current HEAD has been through code review.
#
# Run only after /code-review has actually run AND its findings have been
# resolved or consciously accepted. Writing this without doing that defeats the
# only mechanism standing between an unreviewed change and the remote.
#
# Lives in .git/ rather than the working tree: it is a fact about this checkout,
# not about the project, and it must never be committed.

set -e
head=$(git rev-parse HEAD)
printf '%s' "$head" > .git/review-marker
printf '  reviewed: %s  (%s)\n' "$(printf '%s' "$head" | cut -c1-8)" "$(git log -1 --format=%s | cut -c1-60)"
