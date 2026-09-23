# Empty Older History Loading Design

## Problem

When a new or short session is already at the beginning of its history, pulling down at the top can repeatedly show "正在加载更早消息". An empty page with an unchanged cursor leaves the older-history trigger eligible to run again.

## Design

Normalize the cursor returned by an older-history request before storing it. Treat the history as exhausted when the response explicitly reports `hasMore: false`, omits `nextCursor`, or returns no visible messages while repeating the requested cursor. Preserve normal pagination when a page contains messages or an empty page advances to a different cursor.

The existing prefetch cache remains unchanged. It continues to prefetch and serve pages whenever the normalized cursor is non-null. Session selection and latest-history refresh already replace or reset the cursor, so loading can resume when the session state changes.

## Verification

Add focused unit coverage for exhausted metadata, defensive repeated-cursor handling, advanced empty pages, and normal populated pages. Keep the existing source-level interaction test to verify that `ChatView` applies the normalized cursor before prefetching.
