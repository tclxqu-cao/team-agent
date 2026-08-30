import { describe, expect, it, vi } from "vitest";
import {
  createUuidV4,
  installBrowserCryptoCompatibility,
  type CryptoLike,
} from "./browser-crypto";

describe("browser crypto compatibility", () => {
  it("preserves native randomUUID when available", () => {
    const getRandomValues = vi.fn((bytes: Uint8Array) => bytes);
    const cryptoLike: CryptoLike = {
      randomUUID: () => "native-id",
      getRandomValues,
    };

    installBrowserCryptoCompatibility(cryptoLike);

    expect(createUuidV4(cryptoLike)).toBe("native-id");
    expect(getRandomValues).not.toHaveBeenCalled();
  });

  it("generates an RFC 4122 v4 UUID from getRandomValues", () => {
    const cryptoLike: CryptoLike = {
      getRandomValues: (bytes) => {
        bytes.fill(0);
        return bytes;
      },
    };

    expect(createUuidV4(cryptoLike)).toBe("00000000-0000-4000-8000-000000000000");
  });

  it("installs the fallback only when randomUUID is missing", () => {
    const cryptoLike: CryptoLike = {
      getRandomValues: (bytes) => {
        bytes.fill(0);
        return bytes;
      },
    };

    installBrowserCryptoCompatibility(cryptoLike);

    expect(cryptoLike.randomUUID?.()).toBe("00000000-0000-4000-8000-000000000000");
  });
});
