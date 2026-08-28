# Desktop UI Detail Polish Design

## Product Context

Customer Agent is a persistent desktop workbench for developers who repeatedly switch projects, inspect long model output, adjust runtime settings, and send voice or text instructions. This change preserves the existing sidebar, conversation canvas, and bottom composer geometry while making the controls and boundaries feel deliberate rather than assembled from individually outlined boxes.

## Design Direction: Quiet Boundaries

The interface uses structure only where structure carries meaning. Permanent borders separate major regions; interaction states use soft fills and a short accent edge instead of adding another rectangle. The memorable element is the active-edge cue: a slim indigo marker identifies the selected session or open control while surrounding surfaces remain quiet.

This deliberately avoids a generic card dashboard, a denser workbench redesign, and decorative gradients. Existing layout modes and skins remain functional.

## Visual Tokens

The pearl skin remains the baseline:

- Canvas: `#f5f6fa`
- Surface: `#ffffff`
- Primary ink: `#111827`
- Secondary ink: `#4b5563`
- Accent indigo: `#4f6ef7`
- Hairline: `rgba(17, 24, 39, 0.09)`

`Inter` remains the body and control face. `IBM Plex Mono` is reserved for token counts, model identifiers, and other machine-readable utility text. Existing sci-fi and noir token sets inherit the same component-state rules.

## Layout Contract

Do not change:

- sidebar width or resize behavior;
- project/session hierarchy;
- conversation width, alignment, or scroll behavior;
- composer position or content order;
- settings modal dimensions;
- skin and layout capabilities.

## Component Details

### Sidebar navigation

- Remove permanent borders from project/session action buttons.
- Selected sessions use a subtle accent fill plus a 2 px left active edge.
- Destructive and add actions remain icon-only and become fully visible on row hover or keyboard focus.
- Session titles retain single-line ellipsis and stable row height.
- Project counts use quiet tonal badges without a second high-contrast outline.

### Sidebar utility controls

- Keep the current bottom placement and order.
- `隐藏后台` becomes a quiet secondary action with a soft neutral fill, no resting outline, and a microphone icon.
- Appearance is a square icon button using the same height, radius, and state system.
- `导入项目` keeps a text label but replaces the dashed rectangle with a quiet hover surface and a leading plus icon.

### Settings and appearance

- Header settings uses a borderless icon button at rest; the open state receives accent fill and an active edge/ring.
- Settings tabs use a single active underline or edge instead of separate pills.
- The appearance popover keeps its location and width but uses one outer structural border only.
- Skin choices show a color swatch, name, and selected check. Choices do not carry individual resting borders.
- Layout and binary voice controls use segmented controls or toggles with one shared container boundary.

### Conversation output

- Keep message alignment and maximum width.
- Assistant output loses the persistent raised-card shadow and strong perimeter. A very subtle surface change and hairline are allowed for separation from the canvas.
- Hover reveals message actions without lifting the entire response card.
- User messages retain a restrained accent tint and asymmetrical radius.
- Markdown tables and tool cards retain their own functional boundaries.

### Composer

- Keep the current combined context/model/input container.
- Use one outer 1 px structural border; internal rows use hairline separators only.
- Attachment, microphone, image, and settings controls are borderless icon buttons with a shared hover fill.
- Focus applies one accent ring to the composer shell, not independent rings around every internal button.
- Disabled send remains tonal; enabled send is the only solid accent command in the composer.

## Interaction States

All actionable controls implement consistent resting, hover, active/open, focus-visible, and disabled states. Hover transitions use existing fast timing. Keyboard focus remains visible. Reduced-motion mode disables nonessential transforms and entrance animation.

## Responsive Behavior

The existing layout modes remain authoritative. At narrow widths, labels may truncate but icon controls keep fixed dimensions and must not overlap. Popovers stay within the viewport.

## Implementation Boundaries

- Add reusable CSS classes and state variables in `packages/desktop/renderer/styles/global.css`.
- Apply those classes in `App.tsx` and `ChatView.tsx` while preserving handlers and data flow.
- Do not add a UI library or icon dependency.
- Do not refactor unrelated voice, session, model, or settings logic.

## Verification

- Run desktop renderer tests and production build.
- Verify pearl, sci-fi, and noir skins.
- Verify standard, compact, and focus layouts.
- Inspect the sidebar controls, settings button/modal, appearance popover, assistant output, and composer at desktop and narrow viewports.
- Check hover, keyboard focus, selected/open, disabled, and reduced-motion states.
- Capture screenshots and confirm no overlap, clipping, illegible text, or accidental nested-card styling.
