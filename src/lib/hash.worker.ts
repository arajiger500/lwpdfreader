/// <reference lib="webworker" />
import { sha256 } from '@noble/hashes/sha2.js';
self.onmessage = async (event: MessageEvent<Blob>) => {
  try {
    const file = event.data;
    const hash = sha256.create();
    const chunk = 4 * 1024 * 1024;
    for (let i = 0; i < file.size; i += chunk) {
      hash.update(new Uint8Array(await file.slice(i, i + chunk).arrayBuffer()));
      self.postMessage({ progress: Math.min(1, (i + chunk) / file.size) });
    }
    self.postMessage({
      id: Array.from(hash.digest(), (n) => n.toString(16).padStart(2, '0')).join(''),
    });
  } catch (e) {
    self.postMessage({ error: e instanceof Error ? e.message : 'Could not fingerprint PDF.' });
  }
};
