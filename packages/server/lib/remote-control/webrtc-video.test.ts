import { expect, it, vi } from 'vitest';
// @ts-expect-error gateway ESM
import { packetizeH264, RemoteWebrtcVideo } from './webrtc-video.mjs';
// @ts-expect-error gateway ESM
import { RemoteVideoSession } from './application/remote-video-session.mjs';

vi.mock('@agent/core', async importOriginal => ({
  ...await importOriginal<Record<string, unknown>>(), ...await import('../../../core/src/domain/live-view/index.js'),
  ...await import('../../../core/src/domain/live-view/remote-video-pacing.js'),
}));

it('keeps infrastructure composition outside the application coordinator', () => {
  expect(RemoteWebrtcVideo.prototype).toBeInstanceOf(RemoteVideoSession);
  expect(packetizeH264).toBeTypeOf('function');
});
