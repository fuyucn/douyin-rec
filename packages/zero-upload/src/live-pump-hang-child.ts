// Child entry: exercise acquireStreamWithBackoff with a fetch that never settles.
// Bundled by live-pump-hang.test.ts and run as a real process so an unref'ed
// timeout timer actually empties the event loop (vitest holds its own handles).
import { acquireStreamWithBackoff } from "./live-pump.js";

const t0 = Date.now();
const r = await acquireStreamWithBackoff({
  room: "hang",
  quality: "origin",
  timeoutMs: 20,
  maxRetries: 1,
  baseMs: 10,
  fetch: () => new Promise(() => {}),
});
process.stdout.write(JSON.stringify({ living: r.living, ms: Date.now() - t0 }));
process.exit(r.living ? 1 : 0);
