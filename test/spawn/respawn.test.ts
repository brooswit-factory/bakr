import { describe, expect, test } from "bun:test";
import { isRecognizedMissingJobRefusal, isRecognizedStaleCwdRefusal, respawnSession } from "../../src/spawn/respawn";
import { makeFakeHost } from "../support/fake-host";

const DIR = "/home/op/code/rocketr";
const instant = () => {
  let clock = 0;
  return { sleep: async (ms: number) => { clock += ms; }, now: () => clock };
};

describe("respawnSession (a restore under herdr)", () => {
  test("resumes the SAME session in a new pane, carrying the agent's current flags", async () => {
    const host = makeFakeHost();
    const flags = ["--mcp-config", `${DIR}/.mcp.json`, "--dangerously-load-development-channels=server:yappr"];
    const r = await respawnSession({ sessionId: "s1", directory: DIR, args: flags }, { runCommand: host.runCommand, label: "@rocketr", ...instant() });
    expect(r).toEqual({ ok: true, id: "w1:p1" });
    expect(host.starts()).toEqual([["--resume", "s1", ...flags]]);
    expect(host.panes[0]!.sessionId).toBe("s1");
  });

  test("never forks: a fork that is never prompted writes no transcript, so its own restore would find nothing", async () => {
    const host = makeFakeHost();
    await respawnSession({ sessionId: "s1", directory: DIR, args: [] }, { runCommand: host.runCommand, ...instant() });
    expect(host.starts()[0]).not.toContain("--fork-session");
  });

  test("never `claude respawn`, a permission flag, or a model flag", async () => {
    const host = makeFakeHost();
    await respawnSession({ sessionId: "s1", directory: DIR, args: [] }, { runCommand: host.runCommand, ...instant() });
    const everything = host.calls.flat();
    expect(host.calls.some((c) => c[0] === "claude")).toBe(false);
    for (const flag of ["--permission-mode", "--dangerously-skip-permissions", "--model"]) expect(everything).not.toContain(flag);
  });

  test("a failed start is a respawn failure with herdr's reason", async () => {
    const host = makeFakeHost({ failStart: "claude exited during startup" });
    const r = await respawnSession({ sessionId: "s1", directory: DIR, args: [] }, { runCommand: host.runCommand, ...instant() });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("claude exited during startup");
  });

  test("the legacy refusal predicates still recognise claude respawn's own texts, and nothing a herdr failure says", () => {
    expect(isRecognizedStaleCwdRefusal("Couldn't start a background session (working directory no longer exists or is not accessible: /gone)")).toBe(true);
    expect(isRecognizedMissingJobRefusal("No job matching abc")).toBe(true);
    expect(isRecognizedStaleCwdRefusal("claude did not start in pane w1:p1: claude exited during startup")).toBe(false);
    expect(isRecognizedMissingJobRefusal("claude did not start in pane w1:p1: claude exited during startup")).toBe(false);
  });
});
