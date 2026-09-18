import { describe, expect, test } from "bun:test";
import { buildLaunchInvocation, buildListInvocation, buildStopInvocation } from "../../src/spawn/argv";

describe("buildLaunchInvocation", () => {
  test("wraps claude --bg in a per-launch systemd-run --user --scope, with --expand-environment=no pinned", () => {
    const invocation = buildLaunchInvocation("/home/op/project", "bakr-launch-abc12345", []);
    const { argv } = invocation;

    expect(argv[0]).toBe("systemd-run");
    expect(argv).toContain("--user");
    expect(argv).toContain("--scope");
    expect(argv).toContain("--unit=bakr-launch-abc12345");
    expect(argv).toContain("--collect");
    expect(argv).toContain("--expand-environment=no");
    expect(argv).toContain("claude");
    expect(argv).toContain("--bg");
  });

  test("pinExpandEnvironment: false omits only the flag systemd < 254 rejects", () => {
    const pinned = buildLaunchInvocation("/x", "u", ["--resume", "s"]).argv;
    const legacy = buildLaunchInvocation("/x", "u", ["--resume", "s"], { pinExpandEnvironment: false }).argv;
    expect(legacy).toEqual(pinned.filter((a) => a !== "--expand-environment=no"));
  });

  test("the target directory travels as cwd, never as an argv element", () => {
    const invocation = buildLaunchInvocation("/home/op/project", "u", []);
    expect(invocation.cwd).toBe("/home/op/project");
    expect(invocation.argv).not.toContain("/home/op/project");
  });

  test("extra claude args go before --bg, each as its own argv element", () => {
    const invocation = buildLaunchInvocation("/x", "u", ["--append-system-prompt", "watch this repo"]);
    const claudeIndex = invocation.argv.indexOf("claude");
    const bgIndex = invocation.argv.indexOf("--bg");
    expect(invocation.argv.slice(claudeIndex + 1, bgIndex)).toEqual(["--append-system-prompt", "watch this repo"]);
    // FALSIFIER: --bg last. `claude --bg` does not parse options after it, it
    // takes the rest of argv as the session prompt, so anything appended here
    // is silently demoted to prompt text and its flag never takes effect.
    expect(bgIndex).toBe(invocation.argv.length - 1);
  });

  test("a value containing shell metacharacters survives as a single argv element, unescaped", () => {
    const weird = 'line one\nline two with $HOME and `backtick` and "quotes"';
    const invocation = buildLaunchInvocation("/x", "u", ["--append-system-prompt", weird]);
    expect(invocation.argv).toContain(weird);
    // Exactly one element carries it — it was never split or re-quoted.
    expect(invocation.argv.filter((a) => a === weird)).toHaveLength(1);
  });

  test("a directory containing shell metacharacters survives as cwd unchanged", () => {
    const weirdDir = "/home/op/project with spaces and $VAR and `backticks`";
    const invocation = buildLaunchInvocation(weirdDir, "u", []);
    expect(invocation.cwd).toBe(weirdDir);
  });
});

describe("buildListInvocation", () => {
  test("bare call lists all background sessions with no extra flags", () => {
    const invocation = buildListInvocation();
    expect(invocation.argv).toEqual(["claude", "agents", "--json"]);
  });

  test("underCwd adds --cwd <path> as a narrowing pre-filter, not a replacement for exact matching", () => {
    const invocation = buildListInvocation({ underCwd: "/home/op/project" });
    expect(invocation.argv).toEqual(["claude", "agents", "--json", "--cwd", "/home/op/project"]);
  });

  test("includeAll adds --all", () => {
    const invocation = buildListInvocation({ includeAll: true });
    expect(invocation.argv).toContain("--all");
  });
});

describe("buildStopInvocation", () => {
  test("builds claude stop <id>, and only that", () => {
    const invocation = buildStopInvocation("abc12345");
    expect(invocation.argv).toEqual(["claude", "stop", "abc12345"]);
  });

  test("an id containing shell metacharacters survives as a single argv element", () => {
    const weirdId = "not-a-real-id $(rm -rf /)";
    const invocation = buildStopInvocation(weirdId);
    expect(invocation.argv).toEqual(["claude", "stop", weirdId]);
  });
});
