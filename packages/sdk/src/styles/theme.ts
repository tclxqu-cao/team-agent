import { css } from 'lit';

export const themeStyles = css`
  :host {
    /* Pearl Light Design System — Dark (default) */
    --accent: #4f6ef7;
    --accent-dim: rgba(79, 110, 247, 0.08);
    --accent-glow: rgba(79, 110, 247, 0.2);
    --bg-deepest: #0d1117;
    --bg-surface: #161b22;
    --bg-deep: #21262d;
    --text-primary: #e6edf3;
    --text-secondary: #8b949e;
    --text-muted: #6e7681;
    --border-subtle: rgba(48, 54, 61, 0.6);
    --border-default: #30363d;
    --border-glow: rgba(79, 110, 247, 0.3);
    --success: #34d399;
    --danger: #f43f5e;
    --radius-sm: 6px;
    --radius-md: 12px;
    --radius-lg: 16px;
    --ease-out: cubic-bezier(0.16, 1, 0.3, 1);
    --shadow-sm: 0 1px 3px rgba(0, 0, 0, 0.3);
    --shadow-md: 0 8px 24px rgba(0, 0, 0, 0.4);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  }

  :host([theme='light']) {
    --bg-deepest: #ffffff;
    --bg-surface: #f6f8fa;
    --bg-deep: #eaeef2;
    --text-primary: #1f2328;
    --text-secondary: #656d76;
    --text-muted: #8c959f;
    --border-subtle: rgba(208, 215, 222, 0.4);
    --border-default: #d0d7de;
    --shadow-sm: 0 1px 3px rgba(0, 0, 0, 0.08);
    --shadow-md: 0 8px 24px rgba(0, 0, 0, 0.12);
  }

  @media (prefers-color-scheme: light) {
    :host([theme='auto']) {
      --bg-deepest: #ffffff;
      --bg-surface: #f6f8fa;
      --bg-deep: #eaeef2;
      --text-primary: #1f2328;
      --text-secondary: #656d76;
      --text-muted: #8c959f;
      --border-subtle: rgba(208, 215, 222, 0.4);
      --border-default: #d0d7de;
      --shadow-sm: 0 1px 3px rgba(0, 0, 0, 0.08);
      --shadow-md: 0 8px 24px rgba(0, 0, 0, 0.12);
    }
  }
`;
