# Codex User Attachment History Display Design

## Goal

Render imported Codex user turns as the user experienced them: the actual request plus image attachments, without exposing Codex Desktop's injected attachment envelope as the primary message text.

## Source Contract

Codex `userMessage` items may contain multiple structured content entries. Text entries can contain an injected envelope beginning with `# Files mentioned by the user:`, followed by the attachment-safety sentence and a `## My request:` section. Image entries use `type: "local_image"` and carry a local filesystem `path`.

The Codex runtime adapter remains the only layer that understands this protocol. It preserves the joined source text, recognizes the envelope only when all fixed markers occur in order, and extracts the request after `## My request:`. Unrecognized or partial formats remain unchanged.

## Unified Message Contract

Add optional presentation metadata to the shared message type:

- `rawContent` contains the original Codex text only when normalization changed the visible content.
- `attachments` contains display-only image records with a filename, an optional data URL, and an unavailable flag.

The canonical `content` field contains the normalized visible request. Existing `images` semantics for model input remain unchanged, so historical display attachments cannot accidentally be resent to a model.

## Image Loading

The runtime adapter reads `local_image` files while assembling session detail and converts supported image types to data URLs. Reads are capped at 20 MiB per file. Unsupported, missing, unreadable, or oversized files produce an unavailable attachment record instead of failing the session load. Filesystem paths are not copied into attachment metadata; they remain available only inside the explicitly expanded raw text.

## Presentation

The shared user bubble renders normalized text and attachment tiles. Available images use the existing thumbnail treatment and can be opened at full size. Unavailable images use a compact non-interactive placeholder that names the attachment and states that the image is no longer available.

When `rawContent` exists, the bubble includes a native disclosure labelled `查看原始内容`. Its collapsed state is the default. Expanded content uses a bounded, scrollable monospace block so long temporary paths and injected instructions cannot dominate the conversation layout.

## Compatibility And Failure Handling

- Plain Codex user messages remain byte-for-byte equivalent after outer whitespace trimming.
- Envelope parsing is strict and fails closed to the original text.
- Empty `## My request:` content falls back to the original text.
- Multiple text entries preserve their order before normalization.
- Multiple local images preserve their source order.
- Customer Agent and Claude Code message behavior remains unchanged.

## Verification

- Unit-test envelope extraction, plain-text fallback, malformed-envelope fallback, multiple images, successful data URL loading, and missing-image placeholders.
- Add focused renderer contract coverage for attachment thumbnails, unavailable placeholders, and raw-content disclosure.
- Run the affected Vitest tests and the desktop TypeScript/build checks.

## Non-Goals

- Modifying Codex rollout files or copying external history into Customer Agent SQLite.
- Parsing arbitrary Markdown headings that merely resemble the Codex envelope.
- Persisting temporary Codex images after their source files are deleted.
- Changing how new Customer Agent messages send images to models.
