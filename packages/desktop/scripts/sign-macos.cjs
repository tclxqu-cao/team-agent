const { signAsync } = require("@electron/osx-sign");

// Electron's linker signature does not seal the packaged app's resources.
// Preview builds still need a complete bundle signature so Gatekeeper can
// offer its normal manual approval flow for software without notarization.
module.exports = async function signMac(options) {
  const identity = options.identity || "-";
  const adHoc = identity === "-";
  await signAsync({
    ...options,
    identity,
    identityValidation: false,
    preAutoEntitlements: false,
    preEmbedProvisioningProfile: false,
    // osx-sign 1.3.1 turns true into the invalid --strict=true argument.
    strictVerify: options.strictVerify === true ? undefined : options.strictVerify,
    ...(adHoc ? {
      // osx-sign reads this callback synchronously; a Promise drops overrides.
      optionsForFile: (file) => ({
        ...options.optionsForFile?.(file),
        hardenedRuntime: false,
        signatureFlags: "0x0",
        timestamp: "none",
      }),
    } : {}),
  });
  console.log(`[macOS signing] ${adHoc ? "ad-hoc preview; manual approval required" : "certificate"}: bundle verification passed`);
};
