const MAX_SIGNAL_CHARS = 64_000;
export const MAX_REMOTE_AUDIO_BUFFERED_BYTES = 256 * 1024;
const QUALITY = new Set(['smooth', 'hd', 'original']);
const PROFILES = new Set(['high', 'baseline']);
const VIEWER_KINDS = new Set(['start', 'stop', 'answer', 'ice', 'quality', 'stats', 'audio-start', 'audio-stop', 'audio-microphone']);
const PRODUCER_KINDS = new Set(['offer', 'ice', 'state', 'quality-state', 'audio-state', 'audio-system']);

function invalid(message = 'invalid remote video signal') {
  throw Object.assign(new Error(message), { code: 'EINVAL' });
}

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function boundedNumber(value, min, max) {
  return value === undefined || (typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max);
}

function boundedString(value, max, optional = true) {
  return value === undefined ? optional : typeof value === 'string' && value.length <= max;
}

function boundedNullableString(value, max) {
  return value === null || boundedString(value, max);
}

function boundedNullableNumber(value, min, max) {
  return value === null || boundedNumber(value, min, max);
}

function validDescription(value, expectedType) {
  const input = record(value);
  return Boolean(input && input.type === expectedType && boundedString(input.sdp, 60_000, false));
}

function validCandidate(value) {
  const input = record(value);
  if (!input) return false;
  return boundedString(input.candidate, 4_096, false)
    && boundedNullableString(input.sdpMid, 256)
    && boundedNullableNumber(input.sdpMLineIndex, 0, 1_024)
    && boundedNullableString(input.usernameFragment, 256);
}

function validIceServers(value) {
  if (value === undefined) return true;
  if (!Array.isArray(value) || value.length > 4) return false;
  return value.every((server) => {
    const input = record(server);
    if (!input) return false;
    const urls = Array.isArray(input.urls) ? input.urls : [input.urls];
    if (!urls.length || urls.length > 4 || urls.some(url => typeof url !== 'string' || url.length > 500 || !/^(stuns?|turns?):[^\s]+$/i.test(url))) return false;
    const hasTurn = urls.some(url => /^turns?:/i.test(String(url)));
    if (!hasTurn) return input.username === undefined && input.credential === undefined;
    return boundedString(input.username, 256, false) && boundedString(input.credential, 512, false);
  });
}

function validProfiles(value) {
  return value === undefined || (Array.isArray(value) && value.length <= 2 && value.every(profile => PROFILES.has(String(profile))));
}

function validDecoder(value) {
  if (value === undefined) return true;
  if (typeof value === 'string') return value.length <= 120;
  const input = record(value);
  return Boolean(input
    && boundedString(input.implementation, 120)
    && (input.powerEfficient === undefined || typeof input.powerEfficient === 'boolean')
    && (input.acceleration === undefined || ['hardware', 'software', 'unknown'].includes(String(input.acceleration))));
}

function validStats(data) {
  if (!boundedString(data.codec, 40) || !validDecoder(data.decoder)) return false;
  if (data.codecProfile !== undefined && !PROFILES.has(String(data.codecProfile))) return false;
  if (data.candidateType !== undefined && !['host', 'srflx', 'prflx', 'relay'].includes(String(data.candidateType))) return false;
  if (data.protocol !== undefined && !['udp', 'tcp'].includes(String(data.protocol))) return false;
  return boundedNumber(data.width, 0, 16_384)
    && boundedNumber(data.height, 0, 16_384)
    && boundedNumber(data.fps, 0, 240)
    && boundedNumber(data.rttMs, 0, 60_000)
    && boundedNumber(data.jitterMs, 0, 60_000)
    && boundedNumber(data.lossRate, 0, 1)
    && boundedNumber(data.droppedFrames, 0, 1_000_000_000)
    && boundedNumber(data.receiveBitrate, 0, 1_000_000_000)
    && boundedNumber(data.availableBitrate, 0, 1_000_000_000);
}

function validPcmFrame(data) {
  if (!Number.isSafeInteger(data.channels) || data.channels < 1 || data.channels > 2
      || typeof data.data !== 'string' || data.data.length < 4 || data.data.length % 4 !== 0
      || data.data.length > 48_000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data.data)) return false;
  const padding = data.data.endsWith('==') ? 2 : data.data.endsWith('=') ? 1 : 0;
  const decodedBytes = data.data.length / 4 * 3 - padding;
  return decodedBytes > 0 && decodedBytes % (data.channels * 2) === 0
    && Number.isSafeInteger(data.sequence) && data.sequence >= 0
    && Number.isSafeInteger(data.sampleRate) && data.sampleRate >= 8_000 && data.sampleRate <= 48_000
    && decodedBytes <= 36_000;
}

export function shouldDropRemoteAudioEvent(event, bufferedAmount) {
  return event?.type === 'browser:webrtc'
    && event.data?.kind === 'audio-system'
    && Number(bufferedAmount) > MAX_REMOTE_AUDIO_BUFFERED_BYTES;
}

function boundedSignal(value, allowedKinds) {
  const data = record(value);
  if (!data || !allowedKinds.has(String(data.kind))) invalid();
  let encoded;
  try { encoded = JSON.stringify(data); } catch { invalid(); }
  if (!encoded || encoded.length > MAX_SIGNAL_CHARS) invalid('remote video signal is too large');
  return data;
}

export function parseViewerRemoteVideoSignal(value) {
  const data = boundedSignal(value, VIEWER_KINDS);
  switch (data.kind) {
    case 'start':
      if (!validProfiles(data.receiverProfiles)) invalid();
      break;
    case 'answer':
      if (!validDescription(data.sdp, 'answer')) invalid();
      break;
    case 'ice':
      if (!validCandidate(data.candidate)) invalid();
      break;
    case 'quality':
      if (!QUALITY.has(String(data.quality))) invalid();
      break;
    case 'stats':
      if (!validStats(data)) invalid();
      break;
    case 'audio-microphone':
      if (!validPcmFrame(data)) invalid();
      break;
  }
  return data;
}

export function parseProducerRemoteVideoSignal(value) {
  const data = boundedSignal(value, PRODUCER_KINDS);
  switch (data.kind) {
    case 'offer':
      if (!validDescription(data.sdp, 'offer') || !validIceServers(data.iceServers) || !boundedString(data.warning, 500)) invalid();
      if (data.selectedProfile !== undefined && !PROFILES.has(String(data.selectedProfile))) invalid();
      break;
    case 'ice':
      if (!validCandidate(data.candidate)) invalid();
      break;
    case 'state':
      if (!['new', 'connecting', 'connected', 'disconnected', 'failed', 'closed'].includes(String(data.state))) invalid();
      if (!boundedString(data.error, 500) || !boundedString(data.fallbackReason, 500)) invalid();
      break;
    case 'quality-state':
      if (!QUALITY.has(String(data.quality))) invalid();
      if (data.selectedProfile !== undefined && !PROFILES.has(String(data.selectedProfile))) invalid();
      if (!boundedString(data.error, 500) || !boundedString(data.fallbackReason, 500)) invalid();
      break;
    case 'audio-state':
      if (!['idle', 'starting', 'live', 'failed'].includes(String(data.state)) || !boundedString(data.error, 500)) invalid();
      break;
    case 'audio-system':
      if (!validPcmFrame(data)) invalid();
      break;
  }
  return data;
}
