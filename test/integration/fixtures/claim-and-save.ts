// Test fixture, not a demonstration for reviewers and not the CLI
// (BAKR-10 leaves CLI grammar entirely alone — see the ticket's "Also out
// of scope"). Spawned as a genuinely separate `bun` process by
// test/integration/claim-store-process-restart.test.ts: claims the given
// directory, saves the store, prints the resolved key alone on stdout,
// and exits. That exit is what makes the paired load-and-assert.ts fixture
// a real second process rather than a second call in the same one.
import { claim, emptyStore } from "../../../src/claim-model";
import { save } from "../../../src/claim-store-io";
import { lexicallyNormalize } from "../../../src/claim-key";
import { resolveClaimKey } from "../../../src/claim-key-resolve";
import { realResolveInputs } from "../../../src/paths";

const [, , claimsPath, dirToClaim] = process.argv;
if (!claimsPath || !dirToClaim) {
  console.error("usage: bun run claim-and-save.ts <claimsPath> <dirToClaim>");
  process.exit(2);
}

const lexical = lexicallyNormalize(dirToClaim, { cwd: dirToClaim, home: dirToClaim });
const resolved = await resolveClaimKey(lexical, realResolveInputs);
if (!resolved.ok) {
  console.error(`could not resolve "${dirToClaim}": ${JSON.stringify(resolved)}`);
  process.exit(1);
}

/** Fixed rather than `Date.now()` so the paired assertion in the test doesn't race a clock. */
const FIXED_CLAIMED_AT = 1234567890;

const { state } = claim(emptyStore(), resolved.key, FIXED_CLAIMED_AT);
await save(claimsPath, state);

console.log(resolved.key);
