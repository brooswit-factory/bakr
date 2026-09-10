// EXPLICITLY PROVISIONAL demonstration harness (BAKR-12) — not a CLI
// grammar. BAKR-3 owns bakr's real CLI; this script exists only so the
// daemon (src/index.ts) has something real to reconcile against while that
// CLI does not exist yet. It does exactly one thing: claim a directory.
//
// Usage: bun run scripts/demo-claim.ts <directory>

import { lstat, readlink } from "node:fs/promises";
import { claim, emptyStore, lookup } from "../src/claim-model";
import { load, save } from "../src/claim-store-io";
import { resolveClaimKey } from "../src/claim-key-resolve";
import { lexicallyNormalize } from "../src/claim-key";
import { claimsPath } from "../src/paths";
import { homedir } from "node:os";

async function main(): Promise<void> {
  const input = process.argv[2];
  if (input === undefined) {
    console.error("usage: bun run scripts/demo-claim.ts <directory>");
    process.exit(1);
  }

  const lexical = lexicallyNormalize(input, { cwd: process.cwd(), home: homedir() });
  const resolved = await resolveClaimKey(lexical, { lstat, readlink });
  if (!resolved.ok) {
    console.error(`could not resolve "${input}": ${resolved.reason}${"message" in resolved ? `: ${resolved.message}` : ""}`);
    process.exit(1);
  }

  const path = claimsPath();
  const loaded = await load(path);
  if (loaded.status === "malformed") {
    console.error(`refusing to write: claim store at "${path}" is malformed: ${loaded.error}`);
    process.exit(1);
  }
  const state = loaded.status === "loaded" ? loaded.state : emptyStore();

  const existing = lookup(state, resolved.key);
  const { state: nextState, claim: c } = claim(state, resolved.key, Date.now());
  await save(path, nextState);

  console.log(
    existing !== undefined
      ? `already claimed: "${resolved.key}" (claimed at ${new Date(c.claimedAt).toISOString()})`
      : `claimed: "${resolved.key}" at ${new Date(c.claimedAt).toISOString()}`
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
