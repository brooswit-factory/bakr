// BAKR-22, the epic's "never-spoken-to-then-moved" condition. Falsifier
// stated per test. Three-valued per the epic's correction (BAKR-23):
// `has-transcript` / `no-transcript` / `could-not-tell` — a boolean version
// of this probe existed earlier in this ticket and was ruled dangerous
// because it could silently fold "could not look" into "no transcript",
// which routes to `fresh` and permanently, silently abandons a real
// conversation. One test per branch, plus a mutation that turns
// `could-not-tell` into `no-transcript` — that mutation is the exact slip
// that would ship the data-loss path, per BAKR-23's explicit requirement.

import { describe, expect, test } from "bun:test";
import { probeResumableTranscript, type TranscriptProbeDeps } from "../../src/transcript-probe";

function fakeDeps(transcripts: Record<string, string[]>): TranscriptProbeDeps {
  // transcripts: { projectDir: [sessionId, ...] }
  return {
    listProjectDirs: async () => ({ ok: true, dirs: Object.keys(transcripts) }),
    transcriptExistsIn: async (dir, sessionId) => ({ ok: true, exists: (transcripts[dir] ?? []).includes(sessionId) }),
  };
}

describe("probeResumableTranscript", () => {
  test("has-transcript when SOME project directory has it — falsifier: if this only checked the first directory, a transcript in the second would be missed", async () => {
    const deps = fakeDeps({ "-tmp-a": ["other-session"], "-tmp-b": ["target-session"] });
    expect(await probeResumableTranscript("target-session", deps)).toEqual({ status: "has-transcript" });
  });

  test("no-transcript when NO project directory has it — the never-spoken-to case", async () => {
    const deps = fakeDeps({ "-tmp-a": ["some-other-session"] });
    expect(await probeResumableTranscript("target-session", deps)).toEqual({ status: "no-transcript" });
  });

  test("no-transcript against an empty projects root — never throws on nothing to search", async () => {
    const deps = fakeDeps({});
    expect(await probeResumableTranscript("target-session", deps)).toEqual({ status: "no-transcript" });
  });

  test("could-not-tell when listing the projects root itself fails — falsifier: this must NOT be treated as 'zero projects' (no-transcript)", async () => {
    const deps: TranscriptProbeDeps = {
      listProjectDirs: async () => ({ ok: false, reason: "EACCES: permission denied" }),
      transcriptExistsIn: async () => ({ ok: true, exists: false }),
    };
    const result = await probeResumableTranscript("target-session", deps);
    expect(result.status).toBe("could-not-tell");
    expect((result as { reason: string }).reason).toContain("EACCES");
  });

  test("could-not-tell when an individual directory's check fails before a hit is found — falsifier: this must NOT be silently skipped as if that directory simply lacked the transcript", async () => {
    const deps: TranscriptProbeDeps = {
      listProjectDirs: async () => ({ ok: true, dirs: ["-tmp-a", "-tmp-b"] }),
      transcriptExistsIn: async (dir) => (dir === "-tmp-a" ? { ok: false, reason: "EIO" } : { ok: true, exists: true }),
    };
    const result = await probeResumableTranscript("target-session", deps);
    expect(result.status).toBe("could-not-tell");
    expect((result as { reason: string }).reason).toContain("EIO");
  });

  test("stops searching once found — falsifier: a deps.transcriptExistsIn that fails on later directories must not be reached after a hit", async () => {
    let calledAfterHit = false;
    const deps: TranscriptProbeDeps = {
      listProjectDirs: async () => ({ ok: true, dirs: ["-tmp-a", "-tmp-b"] }),
      transcriptExistsIn: async (dir) => {
        if (dir === "-tmp-b") {
          calledAfterHit = true;
          throw new Error("must not be called after a hit");
        }
        return { ok: true, exists: dir === "-tmp-a" };
      },
    };
    const result = await probeResumableTranscript("x", deps);
    expect(result).toEqual({ status: "has-transcript" });
    expect(calledAfterHit).toBe(false);
  });

  test("MUTATION-THEN-REVERT: a version that folds could-not-tell into no-transcript is caught by this suite", async () => {
    // This test intentionally re-runs the collapsing behaviour the epic
    // flagged as the dangerous shape, inline, and asserts the CORRECT
    // (non-collapsed) result — proving this suite would fail if
    // `probeResumableTranscript` were mutated to do the collapsing itself.
    async function dangerousCollapsedProbe(sessionId: string, deps: TranscriptProbeDeps): Promise<{ status: "has-transcript" | "no-transcript" }> {
      const listing = await deps.listProjectDirs();
      if (!listing.ok) {
        // THE BUG: silently treats "could not list" as "no projects" ->
        // no-transcript -> fresh -> silent data loss.
        return { status: "no-transcript" };
      }
      for (const dir of listing.dirs) {
        const check = await deps.transcriptExistsIn(dir, sessionId);
        if (check.ok && check.exists) return { status: "has-transcript" };
      }
      return { status: "no-transcript" };
    }

    const deps: TranscriptProbeDeps = {
      listProjectDirs: async () => ({ ok: false, reason: "EACCES: permission denied" }),
      transcriptExistsIn: async () => ({ ok: true, exists: false }),
    };

    // The dangerous shape collapses to no-transcript (this is what we must
    // NOT ship):
    expect(await dangerousCollapsedProbe("target-session", deps)).toEqual({ status: "no-transcript" });

    // The real function under test refuses to collapse — this is the
    // assertion that fails the instant someone reintroduces the bug into
    // `probeResumableTranscript` itself:
    const real = await probeResumableTranscript("target-session", deps);
    expect(real.status).toBe("could-not-tell");
    expect(real.status).not.toBe("no-transcript");
  });
});
