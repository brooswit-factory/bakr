// BAKR-34/BAKR-42 R2/R3: pure, lexical-only coverage of agent-name.ts —
// classifyRef's total id/real-path/name split, deriveDirectoryNames' fixed
// point (base name, collision growth, root/one-segment edge cases), and
// computeAgentNames' agent-state layer on top (archived exclusion, R6's
// ambiguous-directory exclusion from nameByAgentId). Referenced from
// agent-lifecycle.test.ts and agent-model.test.ts as "see agent-name.test.ts
// for derivation coverage" — this is that file.

import { describe, expect, test } from "bun:test";
import { classifyRef, computeAgentNames, deriveDirectoryNames, type NameableAgent } from "../../src/agent-name";

// --- R2: classifyRef is total and lexical, never a filesystem probe --------

describe("classifyRef (R2)", () => {
  test("an '@'-prefixed ref is an id", () => {
    expect(classifyRef("@a1b2c3")).toBe("id");
    expect(classifyRef("@")).toBe("id");
  });

  test("an absolute path is a real path", () => {
    expect(classifyRef("/home/alice/project")).toBe("real-path");
  });

  test("'./' and '../'-prefixed refs are real paths", () => {
    expect(classifyRef("./code/x")).toBe("real-path");
    expect(classifyRef("../code/x")).toBe("real-path");
  });

  test("'~/'-prefixed and bare '~' are real paths", () => {
    expect(classifyRef("~/code/x")).toBe("real-path");
    expect(classifyRef("~")).toBe("real-path");
  });

  test("anything else — slash included — is a name, never a filesystem probe", () => {
    expect(classifyRef("brooswit-factory/butchr")).toBe("name");
    expect(classifyRef("code/x")).toBe("name");
    expect(classifyRef("alice")).toBe("name");
  });

  test("R2's own worked example: 'code/x' is a name, './code/x' is a path", () => {
    expect(classifyRef("code/x")).toBe("name");
    expect(classifyRef("./code/x")).toBe("real-path");
  });

  test("'~alice' (no slash after '~') is a name, not a real path — only bare '~' or '~/' qualifies", () => {
    expect(classifyRef("~alice")).toBe("name");
  });
});

// --- R3: base name = last two segments; collision growth is a fixed point -

describe("deriveDirectoryNames (R3)", () => {
  test("base name: the last two path segments, joined by '/'", () => {
    const names = deriveDirectoryNames(["/home/x/code/brooswit-factory/butchr"]);
    expect(names.get("/home/x/code/brooswit-factory/butchr")).toBe("brooswit-factory/butchr");
  });

  test("a one-segment key derives that single segment", () => {
    const names = deriveDirectoryNames(["/foo"]);
    expect(names.get("/foo")).toBe("foo");
  });

  test("the root '/' derives '/'", () => {
    const names = deriveDirectoryNames(["/"]);
    expect(names.get("/")).toBe("/");
  });

  test("two directories with distinct base names each keep their base name — no growth", () => {
    const names = deriveDirectoryNames(["/home/x/code/brooswit-factory/butchr", "/home/x/code/brooswit-factory/yappr"]);
    expect(names.get("/home/x/code/brooswit-factory/butchr")).toBe("brooswit-factory/butchr");
    expect(names.get("/home/x/code/brooswit-factory/yappr")).toBe("brooswit-factory/yappr");
  });

  test("a colliding base name grows every member by one leading segment, simultaneously, until unique", () => {
    // Both end in "x/api" at the base level.
    const names = deriveDirectoryNames(["/home/code/x/api", "/home/work/x/api"]);
    expect(names.get("/home/code/x/api")).toBe("code/x/api");
    expect(names.get("/home/work/x/api")).toBe("work/x/api");
  });

  test("growth repeats past one extra segment when the first growth step still collides", () => {
    const names = deriveDirectoryNames(["/a/b/shared/leaf", "/c/b/shared/leaf"]);
    // Base (2 segs) collides ("shared/leaf" for both); growing to 3 still
    // collides ("b/shared/leaf" for both); growing to 4 (their full paths,
    // which already differ at the leading segment) finally separates them.
    expect(names.get("/a/b/shared/leaf")).toBe("a/b/shared/leaf");
    expect(names.get("/c/b/shared/leaf")).toBe("c/b/shared/leaf");
  });

  test("a directory that cannot grow past its own full length (here: 2 segments) stays at its own bare segment join — never needing a leading '/' to stay unique", () => {
    // "/x/api" has only 2 segments and cannot grow past its own full form;
    // it collides at the base level with a longer directory sharing "x/api",
    // but that longer directory keeps growing away from the collision (it
    // has a segment left to grow with), leaving "/x/api" alone at "x/api" —
    // which can never collide with anything else, since a directory's own
    // full segment join is unique to it (see deriveDirectoryNames's comment).
    const names = deriveDirectoryNames(["/x/api", "/home/work/x/api"]);
    expect(names.get("/x/api")).toBe("x/api");
    expect(names.get("/home/work/x/api")).toBe("work/x/api");
  });

  test("a directory already at its own cap (one segment, per R3's own '/foo' -> 'foo' example) never collides with a still-growing candidate — each directory's own full join is unique to it", () => {
    // "/api" (one segment, at its cap immediately) vs. two longer directories
    // that also collide with each other at the base level.
    const names = deriveDirectoryNames(["/api", "/home/a/x/api", "/home/b/x/api"]);
    expect(names.get("/api")).toBe("api");
    expect(names.get("/home/a/x/api")).toBe("a/x/api");
    expect(names.get("/home/b/x/api")).toBe("b/x/api");
  });

  test("duplicate directory strings collapse to one entry, never colliding with themselves", () => {
    const names = deriveDirectoryNames(["/home/x/y", "/home/x/y"]);
    expect(names.size).toBe(1);
    expect(names.get("/home/x/y")).toBe("x/y");
  });

  test("a three-way collision grows every member together, not just the first two found", () => {
    const names = deriveDirectoryNames(["/a/shared/leaf", "/b/shared/leaf", "/c/shared/leaf"]);
    expect(names.get("/a/shared/leaf")).toBe("a/shared/leaf");
    expect(names.get("/b/shared/leaf")).toBe("b/shared/leaf");
    expect(names.get("/c/shared/leaf")).toBe("c/shared/leaf");
  });

  test("the same ClaimKey string passed twice — the normalized form of 'two spellings of one real directory' (trailing slash / symlink resolution both collapse upstream, in claim-key.ts / claim-key-resolve.ts, to this identical string) — derives ONE name", () => {
    // agent-name.ts is pure and consumes an already-normalized ClaimKey; it
    // never sees a trailing slash or an unresolved symlink itself (see the
    // module comment). What it must guarantee, and what this asserts, is
    // that the SAME normalized string always derives the SAME name, with no
    // path-dependence on insertion order or duplication.
    const key = "/home/alice/code/brooswit-factory/butchr";
    const names = deriveDirectoryNames([key, key, key]);
    expect(names.size).toBe(1);
    expect(names.get(key)).toBe("brooswit-factory/butchr");
  });
});

// --- computeAgentNames: the agent-state layer on top of deriveDirectoryNames

function agent(id: string, directory: string, state: NameableAgent["state"] = "on"): NameableAgent {
  return { id, directory, state };
}

describe("computeAgentNames (R1/R3/R6)", () => {
  test("one agent, one directory: gets its derived name", () => {
    const names = computeAgentNames([agent("@a1", "/home/x/code/y")]);
    expect(names.nameByAgentId.get("@a1")).toBe("code/y");
    expect(names.directoryToName.get("/home/x/code/y")).toBe("code/y");
    expect(names.agentIdsByDirectory.get("/home/x/code/y")).toEqual(["@a1"]);
  });

  test("R3: an archived agent participates in no group and gets no derived name — @id-only", () => {
    const names = computeAgentNames([agent("@a1", "/home/x/code/y", "archived")]);
    expect(names.nameByAgentId.size).toBe(0);
    expect(names.agentIdsByDirectory.size).toBe(0);
    // Its directory does not even enter the collision-group computation.
    expect(names.directoryToName.size).toBe(0);
  });

  test("R3: an archived sibling never collides with, or otherwise affects, a non-archived agent's own name", () => {
    const names = computeAgentNames([agent("@a1", "/home/x/code/y", "on"), agent("@a2", "/home/other/code/y", "archived")]);
    // Only @a1's directory is in play — no collision growth, since the
    // archived agent's directory was excluded before grouping ever happens.
    expect(names.nameByAgentId.get("@a1")).toBe("code/y");
    expect(names.nameByAgentId.has("@a2")).toBe(false);
  });

  test("R6: two non-archived agents sharing one directory (a legacy store already violating one-per-directory) get NO name in nameByAgentId — the caller's ambiguity signal — but the directory still gets a derived name and both ids are listed", () => {
    const names = computeAgentNames([agent("@a1", "/home/x/code/y"), agent("@a2", "/home/x/code/y")]);
    expect(names.nameByAgentId.has("@a1")).toBe(false);
    expect(names.nameByAgentId.has("@a2")).toBe(false);
    expect(names.directoryToName.get("/home/x/code/y")).toBe("code/y");
    expect(names.agentIdsByDirectory.get("/home/x/code/y")?.slice().sort()).toEqual(["@a1", "@a2"]);
  });

  test("R6: an archived agent sharing a directory with a non-archived one does not make it ambiguous", () => {
    const names = computeAgentNames([agent("@a1", "/home/x/code/y", "on"), agent("@a2", "/home/x/code/y", "archived")]);
    expect(names.nameByAgentId.get("@a1")).toBe("code/y");
    expect(names.nameByAgentId.has("@a2")).toBe(false);
  });

  test("collision growth is computed over non-archived agents only — an archived agent sharing a base name never forces growth", () => {
    const names = computeAgentNames([agent("@a1", "/home/code/x/api", "on"), agent("@a2", "/other/code/x/api", "archived")]);
    // Only @a1's directory participates — no collision to grow away from.
    expect(names.nameByAgentId.get("@a1")).toBe("x/api");
  });

  test("an empty agent set derives nothing", () => {
    const names = computeAgentNames([]);
    expect(names.nameByAgentId.size).toBe(0);
    expect(names.directoryToName.size).toBe(0);
    expect(names.agentIdsByDirectory.size).toBe(0);
  });
});
