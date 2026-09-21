import { describe, expect, it } from 'vitest';
import { VIDEO_PROFILES, VideoAdaptation } from './video-adaptation.mjs';

describe('VideoAdaptation', () => {
  it('treats the explicit quality as a bitrate and fps ceiling', () => {
    const adaptation = new VideoAdaptation('smooth');
    expect(adaptation.current()).toMatchObject({ bitRate: 2_000_000, maxFps: 30, quality: 'smooth' });
    for (let index = 0; index < 12; index += 1) adaptation.update({ lossRate: 0, rttMs: 30 });
    expect(adaptation.current().bitRate).toBe(VIDEO_PROFILES.smooth.maxBitRate);
  });

  it('reduces bitrate immediately and fps after sustained congestion', () => {
    const adaptation = new VideoAdaptation('hd');
    const first = adaptation.update({ lossRate: 0.08, rttMs: 280, availableBitrate: 4_000_000 });
    expect(first.bitRate).toBeLessThan(8_000_000);
    expect(first.maxFps).toBe(30);
    const second = adaptation.update({ lossRate: 0.08, rttMs: 280, availableBitrate: 3_000_000 });
    expect(second.maxFps).toBe(20);
  });

  it('recovers conservatively after three healthy samples and never crosses profile bounds', () => {
    const adaptation = new VideoAdaptation('original');
    for (let index = 0; index < 20; index += 1) adaptation.update({ lossRate: 0.3, rttMs: 600 });
    expect(adaptation.current().bitRate).toBe(VIDEO_PROFILES.original.minBitRate);
    expect(adaptation.current().maxFps).toBe(5);
    adaptation.update({}); adaptation.update({});
    expect(adaptation.update({}).reason).toBe('recovery');
    expect(adaptation.current().bitRate).toBeGreaterThan(VIDEO_PROFILES.original.minBitRate);
    expect(adaptation.current().maxFps).toBe(10);
  });

  it('does not mistake low static-screen receive bitrate for congestion', () => {
    const adaptation = new VideoAdaptation('hd');
    for (let index = 0; index < 6; index += 1) adaptation.update({ receiveBitrate: 80_000, lossRate: 0, rttMs: 30 });
    expect(adaptation.current()).toMatchObject({ bitRate: VIDEO_PROFILES.hd.maxBitRate, maxFps: 30 });
  });
});
