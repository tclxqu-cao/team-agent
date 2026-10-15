export const site = {
  name: "AgentRoam",
  repository: "https://github.com/tclxqu-cao/team-agent",
  releases: "https://github.com/tclxqu-cao/team-agent/releases",
  api: "https://api.github.com/repos/tclxqu-cao/team-agent/releases?per_page=20",
  command: "npx agentroam@preview",
};
export const githubIcon =
  '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 .8a11.3 11.3 0 0 0-3.57 22c.56.1.77-.24.77-.54v-2.1c-3.14.68-3.8-1.34-3.8-1.34-.5-1.3-1.25-1.64-1.25-1.64-1.03-.7.08-.69.08-.69 1.13.08 1.73 1.16 1.73 1.16 1 1.73 2.64 1.23 3.28.94.1-.73.4-1.23.72-1.51-2.5-.29-5.14-1.26-5.14-5.6 0-1.23.44-2.24 1.16-3.03-.12-.29-.5-1.44.11-3 0 0 .95-.3 3.1 1.16a10.8 10.8 0 0 1 5.64 0c2.16-1.46 3.1-1.16 3.1-1.16.62 1.56.23 2.71.12 3a4.34 4.34 0 0 1 1.16 3.03c0 4.35-2.65 5.3-5.17 5.58.4.35.77 1.04.77 2.1v3.1c0 .3.2.65.78.54A11.3 11.3 0 0 0 12 .8Z"/></svg>';
export const arrow = '<span aria-hidden="true">↗</span>';
export const mark =
  '<svg viewBox="0 0 40 40" fill="none" aria-hidden="true"><path d="M8 29V11a4 4 0 0 1 4-4h16a4 4 0 0 1 4 4v16" stroke="currentColor" stroke-width="4" stroke-linecap="round"/><path d="m16 15 5 5-5 5m8 7H13" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/><circle cx="32" cy="32" r="3" fill="currentColor"/></svg>';
export function picture(name, alt, extra = "") {
  return `<button class="screenshot ${extra}" data-lightbox="${name}" aria-label="放大查看：${alt}"><img src="assets/${name}" alt="${alt}" loading="lazy" width="1440" height="900"></button>`;
}
export function command(value = site.command) {
  return `<div class="command"><span aria-hidden="true">$</span><code>${value}</code><button type="button" data-copy="${value}" aria-label="复制命令">复制 <span aria-hidden="true">⧉</span></button></div>`;
}
