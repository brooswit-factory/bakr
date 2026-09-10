import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Guards against the trap named in this repo's README: a declared
// engines.bun floor that no CI gate actually tests. This reads the floor out
// of package.json at runtime (never a hardcoded copy of the version, which
// could not detect the two drifting apart) and checks it against the bun
// that is actually running this test.
test("running bun satisfies the declared engines.bun floor", () => {
  const pkgPath = join(import.meta.dir, "..", "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
    engines?: { bun?: string };
  };

  const range = pkg.engines?.bun;
  expect(range).toBeTruthy();
  expect(Bun.semver.satisfies(Bun.version, range as string)).toBe(true);
});
