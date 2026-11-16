# Azure Speech integration

Keep `VOICE_PROVIDER=local` as the default. `azure` uses Azure Speech SDK for streaming ASR and 24 kHz mono PCM TTS; credentials stay in the sidecar environment. Existing local Sherpa/MLX engines remain available without Azure credentials. Local keyword spotting can still guard cloud ASR when its model is installed.

Implementation and acceptance:

1. Validate provider and Azure settings at startup; report the active provider in health.
2. Add Azure ASR and TTS adapters with bounded buffers, cancellation, safe errors, and final-result draining.
3. Preserve the existing voice protocols. Wire authenticated browser TTS to the shared PCM player.
4. Test configuration switching, SDK event/lifecycle contracts, ASR final ordering, browser transport, pairing revocation, and TTS cancellation.
5. Build affected packages and exercise the real local sidecar with model audio. Verify the browser path using ego-browser.

The user has no Azure resource yet and explicitly requested implementation plus local verification first. SDK simulations cannot establish Azure account, network, microphone/device, or cloud recognition quality. Do not claim live Azure E2E acceptance.
