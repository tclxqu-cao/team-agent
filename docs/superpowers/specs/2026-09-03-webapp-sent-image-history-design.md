# WebApp Sent Image History Design

## Problem

Images pasted into the WebApp are passed to the active runtime, but images chosen through the visible "Attachment / image" picker are only added to the inert `attachedFiles` name list. They never enter `pendingImages`, the optimistic message, or the run request. Images that do enter the request can also disappear as soon as session history refreshes. Customer Agent history does not persist the image, while Codex records a temporary local path whose file is removed when the turn ends.

## Chosen Approach

Fix the display lifecycle at all four boundaries:

1. Route supported image files selected by the shared picker through `FileReader` into `pendingImages`; keep non-image files in `attachedFiles`. Disable send while image conversion is pending so a fast click cannot send text without the selected image.
2. Keep optimistic `ChatMessage.images` while refreshed history has not yet supplied a display attachment for the matching user message.
3. Persist Customer Agent images as display-only `Message.presentation.attachments`; continue attaching `Message.images` only to the current model request.
4. Store Codex input images under a durable AgentRoam attachment directory. Remove the directory only when `turn/start` fails before Codex accepts the turn; once accepted, the path is part of native history and must remain readable.

The renderer continues using the existing `images` and `presentation.attachments` views. Reconciliation drops the optimistic image once equivalent persisted attachments arrive so an image is never rendered twice.

## Alternatives Rejected

- Only preserve optimistic images: fixes the current screen but still loses images after reload.
- Render the selected file-name pill as an image attachment: changes only presentation and still omits the image from the run request.
- Persist semantic `Message.images` in Customer Agent history: risks replaying old image payloads into later model turns.
- Add a cross-runtime attachment sidecar database: gives centralized ownership but adds message matching and migration complexity that existing native history paths do not need.

## Error Handling

- Existing MIME, signature, and 20 MB validation remains authoritative.
- File read failures keep the composer open, report an error, and do not silently downgrade a selected image to a file-name-only attachment.
- Customer Agent stores only valid incoming data URLs already accepted by the run endpoint.
- Codex cleans up files when image writing or `turn/start` fails. Files referenced by an accepted turn remain available for history rendering.
- Missing legacy Codex files continue rendering the existing unavailable-attachment state.

## Verification

- History reconciliation retains optimistic images before persistence and switches to persisted attachments without duplication.
- The visible file picker converts selected images into pending image previews and the eventual run payload.
- Sending remains disabled until every selected image has finished converting.
- Customer Agent history returns display attachments without replaying historical images to the model.
- Codex accepted turns retain image files and restore them as attachments; rejected starts clean up unreferenced files.
- Existing Claude image-history behavior remains unchanged.
- Run focused unit tests, relevant type checks/build, then rebuild and restart the WebApp production instance on port 3000.
