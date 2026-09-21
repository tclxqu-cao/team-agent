export const DEFAULT_STUN_SERVER = Object.freeze({ urls: 'stun:stun.l.google.com:19302' });

function splitUrls(value) {
  return String(value || '').split(',').map(item => item.trim()).filter(Boolean);
}

export function readRemoteIceConfig(env = process.env) {
  const turnUrls = splitUrls(env.AGENT_REMOTE_TURN_URLS).filter(url => /^turns?:[^\s]+$/i.test(url));
  const username = String(env.AGENT_REMOTE_TURN_USERNAME || '').trim();
  const credential = String(env.AGENT_REMOTE_TURN_CREDENTIAL || '').trim();
  const iceServers = [{ ...DEFAULT_STUN_SERVER }];
  let warning = null;
  if (turnUrls.length && username && credential) iceServers.push({ urls: turnUrls, username, credential });
  else if (turnUrls.length || username || credential) warning = 'TURN 配置不完整，已仅使用 STUN';
  return { iceServers, turnConfigured: iceServers.length > 1, warning };
}

export function publicIceSummary(config) {
  return {
    turnConfigured: config.turnConfigured,
    warning: config.warning,
    urls: config.iceServers.flatMap(server => Array.isArray(server.urls) ? server.urls : [server.urls]),
  };
}
