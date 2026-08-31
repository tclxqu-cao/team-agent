# Web Add Menu Theme Design

## Background

The Web Shell add menu is rendered inside the themed React tree, but its CSS uses fixed light colors for the surface, border, text, and shadow. Switching from the default Pearl skin to Sci-fi or Noir therefore leaves the menu visually stuck in the light theme.

## Goal

Make the add menu automatically follow every active skin without changing its placement, dimensions, actions, or Electron behavior.

## Design

Replace the menu's fixed colors with the existing semantic skin tokens: `--bg-elevated` for the surface, `--border-default` for the outline, `--text-primary` for labels, and `--shadow-md` for elevation. Use `--control-hover` and `--control-active` for item interaction states so feedback also follows the active accent and surface palette.

The menu remains in the current DOM hierarchy, so it inherits `data-skin` variables from `document.documentElement`; no Portal or theme synchronization layer is required. The change stays scoped to `.web-native-add-menu` and does not affect desktop Electron controls.

## Verification

- Add a focused stylesheet contract test covering the required semantic tokens and rejecting fixed light menu colors.
- Run the WebApp test suite, typecheck, and production build.
- In a 390x844 browser viewport, open the menu under Pearl, Sci-fi, and Noir and verify the computed surface, text, border, and interaction colors change with the skin.
