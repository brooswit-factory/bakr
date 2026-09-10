import { describe, expect, test } from "bun:test";
import { expandHome, lexicallyNormalize } from "../../src/claim-key";

const inputs = { cwd: "/home/alice/project", home: "/home/alice" };

describe("expandHome", () => {
  test("bare ~ expands to home", () => {
    expect(expandHome("~", inputs.home)).toBe("/home/alice");
  });

  test("~/rest expands with a joining slash", () => {
    expect(expandHome("~/work/repo", inputs.home)).toBe("/home/alice/work/repo");
  });

  test("~user (another user's home) is left unchanged", () => {
    expect(expandHome("~bob/repo", inputs.home)).toBe("~bob/repo");
  });

  test("a path with no leading ~ is left unchanged", () => {
    expect(expandHome("/etc/passwd", inputs.home)).toBe("/etc/passwd");
  });

  test("a home directory with a trailing slash still joins cleanly", () => {
    expect(expandHome("~/x", "/home/alice/")).toBe("/home/alice/x");
  });
});

describe("lexicallyNormalize", () => {
  test("an already-absolute path passes through resolve unchanged", () => {
    expect(lexicallyNormalize("/var/data", inputs)).toBe("/var/data");
  });

  test("a relative path resolves against cwd", () => {
    expect(lexicallyNormalize("sub/dir", inputs)).toBe("/home/alice/project/sub/dir");
  });

  test("a trailing slash is stripped", () => {
    expect(lexicallyNormalize("/var/data/", inputs)).toBe("/var/data");
  });

  test("`.` segments collapse", () => {
    expect(lexicallyNormalize("/var/./data", inputs)).toBe("/var/data");
  });

  test("`..` segments are left INTACT, not collapsed lexically", () => {
    // Deliberate: collapsing `..` here would be wrong whenever an earlier
    // segment is a symlink (see this module's own comment, and
    // claim-key-resolve.ts's — this was a real bug in an earlier draft,
    // caught by test/integration/claim-key-resolve.test.ts). Resolving
    // `..` is entirely claim-key-resolve.ts's job, which has the
    // filesystem access needed to do it correctly.
    expect(lexicallyNormalize("/var/data/../other", inputs)).toBe("/var/data/../other");
  });

  test("~ expansion happens before relative resolution", () => {
    expect(lexicallyNormalize("~/sub", inputs)).toBe("/home/alice/sub");
  });

  test("two lexically-different spellings of the same textual path normalize identically, when the difference is `.` or a trailing slash", () => {
    const a = lexicallyNormalize("/var/data/", inputs);
    const b = lexicallyNormalize("/var/./data", inputs);
    expect(a).toBe(b);
  });
});
