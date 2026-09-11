// BAKR-20 §3.1/§3.2/§3.3 reproduction, adapted directly from the ticket's
// own "Reproductions you can use" snippet: the parent spawns N of these at
// once, each spins to a SHARED start instant (so all N genuinely contend,
// rather than lining up one at a time), adds exactly ONE agent through the
// selected lock mode, then exits. The parent counts keys under `.agents`
// afterward — a lost update shows up as fewer than N agents while every
// worker exited 0 (withAgentStoreLock/withAgentStoreLockLegacy reported
// "ok" for a write that did not survive).
//
// Three modes:
// - "new"      — the shipped, fixed `withAgentStoreLock` (agent-store-io.ts).
// - "old"      — the frozen pre-fix `withAgentStoreLockLegacy`
//                (legacy-agent-store-lock.ts), kept only for this
//                regression demonstration.
// - "unlocked" — POSITIVE CONTROL: no lock at all, a raw load-modify-save
//                with a deliberate small delay (mirroring
//                agent-lock-race-worker.ts's own widening delay) — proves
//                this harness can observe a lost update at all; a "new"
//                run with zero losses is meaningless without this.
import { randomBytes as nodeRandomBytes } from "node:crypto";
import { emptyAgentStore, mintUniqueAgentId, putAgent } from "../../../src/agent-model";
import { load, save, withAgentStoreLock } from "../../../src/agent-store-io";
import type { ClaimKey } from "../../../src/claim-key-resolve";
import { withAgentStoreLockLegacy } from "./legacy-agent-store-lock";

const PROBE_DIR = "/probe/dir" as ClaimKey;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const [, , modeRaw, storeRaw, startAtRaw, lingerMsRaw] = process.argv;
if ((modeRaw !== "new" && modeRaw !== "old" && modeRaw !== "unlocked") || !storeRaw || !startAtRaw) {
  console.error("usage: bun run agent-contention-worker.ts <new|old|unlocked> <store> <startAtEpochMs> [lingerMs]");
  process.exit(2);
}
const mode: "new" | "old" | "unlocked" = modeRaw;
const store: string = storeRaw;
const startAt = Number(startAtRaw);
const lingerMs = Number(lingerMsRaw ?? "0");

function randomBytes(byteLength: number): Uint8Array {
  return new Uint8Array(nodeRandomBytes(byteLength));
}

async function main(): Promise<void> {
  // Spin to a shared start instant — every contender races from the same
  // line, rather than staggering by however long each one took to boot.
  while (Date.now() < startAt) {
    /* busy-wait */
  }

  if (mode === "unlocked") {
    const loaded = await load(store);
    const current = loaded.status === "loaded" ? loaded.state : emptyAgentStore();
    await sleep(15); // deliberately widen the unprotected load-to-save window
    const id = mintUniqueAgentId(current, randomBytes);
    const next = putAgent(current, { id, name: undefined, directory: PROBE_DIR, state: "off", createdAt: Date.now(), birthSessionId: undefined, restoreTarget: undefined });
    await save(store, next);
    if (lingerMs > 0) await sleep(lingerMs);
    process.exit(0);
  }

  const lockFn = mode === "old" ? withAgentStoreLockLegacy : withAgentStoreLock;
  const r = await lockFn(store, (current) => {
    const id = mintUniqueAgentId(current, randomBytes);
    return {
      state: putAgent(current, { id, name: undefined, directory: PROBE_DIR, state: "off", createdAt: Date.now(), birthSessionId: undefined, restoreTarget: undefined }),
      result: id,
    };
  });
  if (lingerMs > 0) await sleep(lingerMs);
  process.exit(r.status === "ok" ? 0 : 3);
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
