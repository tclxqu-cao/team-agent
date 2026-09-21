import { expect, it } from 'vitest';
// @ts-expect-error gateway ESM
import { packetizeH264, RemoteWebrtcVideo } from './webrtc-video.mjs';
// @ts-expect-error gateway ESM
import { RemoteVideoSession } from './application/remote-video-session.mjs';

it('keeps infrastructure composition outside the application coordinator', () => {
  expect(RemoteWebrtcVideo.prototype).toBeInstanceOf(RemoteVideoSession);
  expect(packetizeH264).toBeTypeOf('function');
});
