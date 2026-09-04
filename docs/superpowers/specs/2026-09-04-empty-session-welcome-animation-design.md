# Empty Session Welcome Animation Design

## Goal

Replace the generic empty chat state with a brief, personable welcome moment that helps the user start useful work. It must appear when the app first resolves to an empty chat and whenever a newly created empty session becomes active, without replaying over sessions that already contain messages.

## Experience

The empty state opens with a 1.2-second "core wake" sequence. The existing diamond motif grows from a point, two thin orbital strokes sweep around it, and one low-opacity accent glow expands and settles. The surrounding interface stays quiet so this single motion remains the signature element.

Copy appears in a short stagger after the core begins:

- Heading: `嗨，我在。`
- Prompt: `今天想一起做点什么？`
- Runtime status: `<Agent name> · 已准备好`
- Starter actions: `带我熟悉这个项目`, `帮我排查一个问题`, and `一起实现一个新想法`

Starter actions are real buttons. Selecting one fills the composer with the same text and focuses it; it never submits automatically. The user can edit the prompt before sending. When the runtime is not ready, the existing configuration guidance replaces the ready status and starter actions are disabled.

## Visual Direction

The component uses the current theme tokens rather than introducing a separate palette: `--accent`, `--accent-dim`, `--text-primary`, `--text-secondary`, `--text-muted`, `--bg-surface`, and border tokens. The existing display and body fonts remain authoritative.

The core is an inline SVG/CSS composition, not Canvas, Lottie, or a remote asset. This keeps startup deterministic and inexpensive on mobile. Starter actions use compact 8px-radius buttons with a small familiar icon, clear text, visible focus, and stable dimensions. They stack vertically on phones and may form a three-column row when space allows.

## Architecture

Add a focused `EmptySessionWelcome` presentation component under `packages/desktop/renderer/components`. It owns only welcome markup and presentation. Its inputs are:

- the selected runtime type, used to produce the display label;
- whether composing is available;
- the runtime/configuration state;
- an `onSelectPrompt(prompt)` callback.

`ChatView` remains the owner of session and composer state. It renders the component only after initial history loading has completed and the active session has no messages, no run, and no error. The component is keyed by the active session identity so each newly selected empty session receives its own entrance sequence. Existing or non-empty sessions never render it.

The callback uses the existing composer state update path, closes any mention/skill picker state if necessary, and focuses the textarea on the next frame. It does not create a session or send a message.

Styles live in the shared renderer stylesheet so Electron and `packages/webapp`, which imports the renderer styles and mounts the same `App`, receive identical behavior. Web-only CSS may adjust spacing but must not duplicate the animation.

## Motion And Accessibility

The entrance uses transform and opacity only for the larger elements. The glow is bounded to the welcome core and does not create a full-screen flash. Once the 1.2-second sequence completes, all decorative motion stops.

Under `prefers-reduced-motion: reduce`, orbital and scale animations are removed and the complete state appears with a short opacity transition. Decorative SVG elements are hidden from assistive technology. Starter actions remain keyboard reachable, have visible focus states, and expose their visible labels as accessible names.

## Edge Cases

- History loading: keep the current loading state; do not render the welcome until the empty result is authoritative.
- Empty session switch: remount and replay for that empty session.
- Existing session switch: render messages directly with no welcome flash.
- Runtime unavailable or API key missing: retain the personable heading, show configuration guidance, and disable starters.
- Running empty session: retain the existing running/progress state rather than covering it with the welcome.
- Composer draft: selecting a starter replaces the current draft only after the explicit button click.

## Verification

- Add focused component tests for copy, runtime labels, enabled/disabled starter actions, and prompt selection.
- Add a source/style contract test for the shared animation, session key, and reduced-motion branch.
- Run Desktop and WebApp typechecks and the focused test files.
- Build the WebApp and inspect both desktop and phone viewports in the actual `/web` shell.
- Verify first empty load, new empty session, existing populated session, starter-to-composer focus, theme contrast, and reduced motion.

## Non-Goals

- No random or time-dependent greeting copy.
- No automatic prompt submission.
- No persistent ambient animation after the entrance.
- No changes to session creation, history persistence, runtime selection, or composer submission behavior.
