import { describe, expect, it } from 'vitest';
import { publicIceSummary, readRemoteIceConfig } from './ice-config.mjs';

describe('readRemoteIceConfig', () => {
  it('uses STUN only when TURN is not configured', () => {
    expect(readRemoteIceConfig({})).toEqual({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }], turnConfigured: false, warning: null });
  });

  it('adds credentialed TURN URLs without exposing credentials in diagnostics', () => {
    const config = readRemoteIceConfig({ AGENT_REMOTE_TURN_URLS: 'turn:relay.example:3478,turns:relay.example:443', AGENT_REMOTE_TURN_USERNAME: 'user', AGENT_REMOTE_TURN_CREDENTIAL: 'secret' });
    expect(config.iceServers[1]).toEqual({ urls: ['turn:relay.example:3478', 'turns:relay.example:443'], username: 'user', credential: 'secret' });
    expect(JSON.stringify(publicIceSummary(config))).not.toContain('secret');
  });

  it('falls back to STUN for incomplete TURN credentials', () => {
    const config = readRemoteIceConfig({ AGENT_REMOTE_TURN_URLS: 'turn:relay.example:3478' });
    expect(config.turnConfigured).toBe(false);
    expect(config.warning).toContain('不完整');
  });
});
