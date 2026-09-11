// B13 (epic ruling, 2026-09-11): "only an explicit operator action may
// clear a failed or given-up launch record; the reconcile loop never does
// ... for the loop, the daemon's give-up stays final." Sibling assertion to
// `daemon-no-stop-path.test.ts` (BAKR-16): static source inspection, not a
// runtime mock, because the guarantee is about what the code CAN do. This
// file does not modify daemon.ts — it is new, added by BAKR-21 alongside
// the wedge-clearing mechanism it guards.
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const DAEMON_SOURCE_PATH = join(import.meta.dir, "..", "..", "src", "daemon.ts");

describe("B13: src/daemon.ts never clears a failed/wedged launch record", () => {
  test("no `clearFailedLaunchRecord` import, no `clearFailedLaunchRecord(` call", async () => {
    const source = await readFile(DAEMON_SOURCE_PATH, "utf8");

    // PROBE CONTROL: confirm this file DOES successfully find an unrelated, known-present string.
    expect(source).toContain("promoteUnresolvableLaunches");

    expect(source).not.toMatch(/clearFailedLaunchRecord/);
  });
});
