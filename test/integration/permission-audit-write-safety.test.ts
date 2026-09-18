// The permission audit's own write safety (BAKR-41): the file `bakr <agent>
// approve` records into is 0600 from the moment it exists, appending never
// widens it, and anything already at the path that is not a private regular
// file is refused rather than written through. Every refusal here is a throw,
// which drovr turns into `audit-failed` with nothing pressed — the CLI half of
// that is in cli-approve.test.ts.
import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realAppendPermissionAudit } from "../../src/paths";

const dirs: string[] = [];
let restoreUmask: number | undefined;
afterEach(async () => {
  if (restoreUmask !== undefined) { process.umask(restoreUmask); restoreUmask = undefined; }
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});

async function stateDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bakr-audit-"));
  dirs.push(dir);
  return dir;
}

const modeOf = async (path: string): Promise<number> => (await stat(path)).mode & 0o777;

test("refuses to run under uid 0 — root ignores the mode bits these checks rest on", () => {
  expect(process.getuid?.()).not.toBe(0);
});

test("the file is created 0600 by the same open that creates it — even under umask 000", async () => {
  // A create-then-chmod would leave a 0666 file on disk for a moment under
  // this umask; creating with the mode leaves no such moment to observe.
  restoreUmask = process.umask(0o000);
  const path = join(await stateDir(), "bakr", "permission-approvals.jsonl");
  await realAppendPermissionAudit(path, '{"outcome":"approving"}\n');
  expect(await modeOf(path)).toBe(0o600);
});

test("a missing state directory is created 0700", async () => {
  restoreUmask = process.umask(0o000);
  const root = await stateDir();
  await realAppendPermissionAudit(join(root, "bakr", "permission-approvals.jsonl"), "{}\n");
  expect(await modeOf(join(root, "bakr"))).toBe(0o700);
});

test("records append in order and appending never widens the mode", async () => {
  const path = join(await stateDir(), "permission-approvals.jsonl");
  await realAppendPermissionAudit(path, '{"n":1,"outcome":"approving"}\n');
  await realAppendPermissionAudit(path, '{"n":1,"outcome":"approved"}\n');
  await realAppendPermissionAudit(path, '{"n":2,"outcome":"prompt-changed"}\n');
  expect(await readFile(path, "utf8")).toBe('{"n":1,"outcome":"approving"}\n{"n":1,"outcome":"approved"}\n{"n":2,"outcome":"prompt-changed"}\n');
  expect(await modeOf(path)).toBe(0o600);
});

test.each([0o644, 0o640, 0o604, 0o666])("an existing file at mode %o is refused, left unwritten and left at its mode", async (mode) => {
  const path = join(await stateDir(), "permission-approvals.jsonl");
  await writeFile(path, "earlier\n");
  await chmod(path, mode);
  await expect(realAppendPermissionAudit(path, "{}\n")).rejects.toThrow(`is mode 0${mode.toString(8)}, wider than 0600`);
  expect(await readFile(path, "utf8")).toBe("earlier\n");
  expect(await modeOf(path)).toBe(mode);
});

test("an existing file narrower than 0600 is appended to and not widened", async () => {
  const path = join(await stateDir(), "permission-approvals.jsonl");
  await writeFile(path, "earlier\n");
  await chmod(path, 0o400 | 0o200);
  await realAppendPermissionAudit(path, "next\n");
  expect(await readFile(path, "utf8")).toBe("earlier\nnext\n");
  expect(await modeOf(path)).toBe(0o600);
});

test("a symlink at the audit path is refused, never followed to its target", async () => {
  const root = await stateDir();
  const target = join(root, "elsewhere.txt");
  await writeFile(target, "not the audit\n");
  await chmod(target, 0o600);
  const path = join(root, "permission-approvals.jsonl");
  await symlink(target, path);
  await expect(realAppendPermissionAudit(path, "{}\n")).rejects.toThrow();
  expect(await readFile(target, "utf8")).toBe("not the audit\n");
});

test("a directory at the audit path is refused", async () => {
  const path = join(await stateDir(), "permission-approvals.jsonl");
  await mkdir(path);
  await expect(realAppendPermissionAudit(path, "{}\n")).rejects.toThrow();
});
