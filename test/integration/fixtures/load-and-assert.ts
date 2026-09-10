// Test fixture, not a demonstration for reviewers and not the CLI (see
// claim-and-save.ts's header for why). Spawned as a genuinely separate
// `bun` process — separate from claim-and-save.ts's own process, which
// has already exited by the time this one starts — by
// test/integration/claim-store-process-restart.test.ts: loads the store
// from `claimsPath` and prints the claim found at `key` as JSON, or fails
// loudly with a nonzero exit if it is missing, malformed, or not found.
import { lookup } from "../../../src/claim-model";
import { load } from "../../../src/claim-store-io";
import type { ClaimKey } from "../../../src/claim-key-resolve";

const [, , claimsPath, key] = process.argv;
if (!claimsPath || !key) {
  console.error("usage: bun run load-and-assert.ts <claimsPath> <key>");
  process.exit(2);
}

const result = await load(claimsPath);
if (result.status !== "loaded") {
  console.error(`expected the store to reload as 'loaded', got '${result.status}'${result.status === "malformed" ? `: ${result.error}` : ""}`);
  process.exit(1);
}

const found = lookup(result.state, key as ClaimKey);
if (!found) {
  console.error(`no claim found for key "${key}" after reload`);
  process.exit(1);
}

console.log(JSON.stringify(found));
