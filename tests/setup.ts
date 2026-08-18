import { randomFillSync } from "crypto";

// jsdom lacks WebCrypto — polyfill getRandomValues for anything that needs it.
Object.defineProperty(window, "crypto", {
  value: { getRandomValues: (b: Uint8Array) => (randomFillSync(b as BufferSource) as Uint8Array) },
});
