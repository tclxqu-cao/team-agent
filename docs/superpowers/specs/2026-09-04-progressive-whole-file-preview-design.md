# Progressive Whole-File Preview Design

## Goal

Make large artifact previews become useful immediately while preserving access to the complete file. The preview shell and loading feedback must appear as soon as a file is selected; file bytes then arrive incrementally instead of blocking the UI on a whole-file WebSocket payload.

The initial reported case is a large Markdown file. The same loading model must also cover other text formats, images, PDF, audio, and video.

## Scope

- Apply to the `/web` file preview opened from the file tree or a message artifact link.
- Keep the current full-file view as the primary preview.
- Keep Git diff and text editing as separate capabilities. They must not block the first full-file bytes from rendering.
- Keep the existing download action and its 256 MiB client-download limit.
- Preserve `HostPathPolicy` checks for every file opened through WebSocket or HTTP.
- Match all existing Web shell skins through their CSS variables.

This change does not add a rich Markdown renderer, a general-purpose code editor, or eager background loading of an entire large file.

## Architecture

The existing WebSocket file API remains the control plane. Text content continues to use bounded `fs:read` requests. Rich media uses a new same-origin HTTP streaming data plane because browser-native image, PDF, audio, and video elements cannot progressively render a Base64 value delivered only after the whole file has been read.

The boundaries are:

1. `file-preview-service.mjs` owns file metadata, bounded reads, and preview stream range semantics. It does not own React state.
2. `ws-server.mjs` applies `HostPathPolicy`, issues an opaque short-lived preview ticket for an already-authorized path, and serves ticketed HTTP `GET`/`HEAD` requests with Range support.
3. `FilePreview.tsx` owns the preview state machine, text chunk scheduling, stale-response rejection, media readiness events, progress UI, and retry actions.

A preview ticket contains no path in the browser-visible URL. It is random, scoped to one canonical file and user, expires after bounded inactivity, and is never persisted. Ticket lookup revalidates the file path before opening it. Responses use the detected MIME type, `Accept-Ranges: bytes`, `Content-Length`, `Content-Range` for partial responses, `Cache-Control: private, no-store`, and `X-Content-Type-Options: nosniff`.

## Text And Markdown Flow

Selecting a text file starts a new generation and immediately renders the stable preview header plus a centered loading indicator.

1. Request `fs:stat` and the first `fs:read` chunk concurrently. A chunk is at most the existing 256 KiB server limit.
2. Decode UTF-8 through one streaming `TextDecoder` for the active generation so a multibyte character split across chunk boundaries is not corrupted.
3. Render the first decoded chunk as soon as it arrives. The header shows total size and the body reports loaded bytes versus total bytes.
4. Place an `IntersectionObserver` sentinel near the bottom of the scroll container. When it approaches the viewport, request exactly one next chunk. Never run overlapping reads for one preview.
5. Append each chunk as a separate stable text segment instead of repeatedly rebuilding one increasingly large string. Stop when `eof=true`.
6. While the next chunk is in flight, show a compact spinner at the bottom. If it fails, retain all content already loaded and replace the spinner with a retry action.

Scrolling is the demand signal. The client does not automatically download the unread remainder while the user remains near the top, so a very large Markdown artifact cannot monopolize the shared WebSocket.

Git inspection no longer gates the file view. Diff data is loaded only when the user enters the existing change view. Editing is loaded on demand and remains limited to the current editable-size boundary. Returning from either capability restores the independently accumulated full-file preview.

When a watched file changes and the user is not editing, the generation is invalidated and the full-file preview restarts at byte zero. An active draft keeps the existing external-change warning behavior.

## Image, PDF, Audio, And Video Flow

After `fs:preview-open` returns metadata and a ticketed URL, the browser element receives that URL directly:

- Images use `<img>` and clear the loading state on `load`.
- PDF uses the existing `<iframe>` and clears loading on `load`.
- Audio and video use native controls and clear initial loading on `loadedmetadata`; native Range requests support seeking without downloading the whole file first.

The preview body displays a centered spinner until the element becomes usable. Media errors retain the header and expose a retry action. Switching files revokes the previous ticket and replaces the element, which aborts its outstanding browser request. The existing hexadecimal fallback remains for unsupported binary types and reads only the bounded head chunk.

## State And Concurrency

The component uses explicit phases: `initial-loading`, `ready`, `loading-more`, and `error`. Downloading and saving retain their independent states.

Every file selection increments a generation token. All WebSocket completions compare their captured path and generation before mutating state. Late chunks, metadata, diff results, and errors from a closed or replaced preview are ignored. Text offset advances only by the server-returned `offset + bytes`; a non-EOF response that makes no progress is treated as an error.

The initial loading indicator is delayed by approximately 120 ms to avoid flashing for tiny files, but the preview shell appears immediately. Incremental loading feedback is not delayed because it occupies the fixed bottom sentinel area and does not shift the layout.

## Visual Behavior

- Initial state: centered `LoaderCircle` plus `正在加载文件`, using current skin text and accent variables.
- Text ready state: the file content starts at the same position as today; a quiet size-progress label appears at the bottom while more data exists.
- Incremental state: a small rotating loader and `正在加载更多` appear in a stable-height footer.
- Completed state: the footer disappears without moving already rendered content.
- Error state: initial errors occupy the center; incremental errors remain at the bottom so loaded content stays readable.

No new card, modal, border layer, hard-coded dark surface, or independent color palette is introduced.

## Verification

- Service tests cover full responses, valid byte ranges, suffix/open-ended ranges, invalid ranges, MIME headers, expired or unknown tickets, directory rejection, and path-policy rejection.
- Component tests cover immediate initial loading, first-chunk rendering, streamed UTF-8 boundaries, automatic sentinel loading, progress calculation, one in-flight chunk, retry after an incremental failure, EOF, watched-file restart, and stale response rejection after switching files.
- Media tests cover ticket URL use and loading/error events without Base64 `fs:dataurl` reads.
- Regression tests preserve download, editing, external-change, diff, hex fallback, and theme behavior.
- Run focused Server tests, Server TypeScript/build checks, and production Web build.
- Publish to `:3000` with the repository release workflow, then use the default browser through `ego-browser` to verify a large Markdown file and representative image/PDF/video files on desktop and a 390 x 844 viewport. Confirm first content appears before the full file transfers, the loading UI is legible in every skin, scrolling loads the complete text, media seeking produces HTTP Range responses, and switching files stops visible work from the previous preview.
