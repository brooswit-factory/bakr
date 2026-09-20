// The pure, lexical half of path-derived agent naming (BAKR-34/BAKR-42, R2/R3):
// no filesystem, no clock, no ambient env — the same pure/impure split
// claim-key.ts draws against claim-key-resolve.ts. A derived name is NEVER
// persisted (R1): every function here is a query over whatever `directory`/
// `state` values the caller currently holds, recomputed every time names are
// needed, so it stays correct as agents are created, archived and deleted
// without a rewrite pass.
//
// R2 — classifying a raw CLI ref is LEXICAL and TOTAL, never a filesystem
// probe: "@" prefix is an id; "/", "./", "../", "~/", or bare "~" is a real
// path; anything else — slash included — is a path name. `classifyRef` below
// is that rule, spelled out once so no call site re-derives it.
//
// R3 — derivation: a directory's base name is its last two path segments
// joined by "/"; a one-segment key derives that single segment (e.g. `/foo`
// derives `foo`, never `/foo`); the root "/" derives "/". When two or more
// directories share a base name, EVERY member of that colliding group grows
// by one more leading segment, simultaneously, repeating until every
// candidate in the group is unique — `deriveDirectoryNames` implements that
// fixed-point. A directory that runs out of segments before it is unique
// keeps its own full segment sequence (its full absolute path, minus the
// leading "/") — see `deriveDirectoryNames`'s own comment for why that is
// always already unique on its own, with no separate "ran out of segments"
// shape needed to keep it from colliding with a still-growing candidate.
//
// Archived agents are excluded upstream, not here (R3: "computed over
// non-archived agents only") — `computeAgentNames` is the one function in
// this module that knows about agent state at all; `deriveDirectoryNames`
// itself is a pure function of directory strings and has no notion of an
// "agent" or a lifecycle state.

/** R2: total, lexical, no filesystem access — see the module comment. */
export type RefKind = "id" | "real-path" | "name";

export function classifyRef(ref: string): RefKind {
  if (ref.startsWith("@")) return "id";
  if (ref === "~" || ref.startsWith("/") || ref.startsWith("./") || ref.startsWith("../") || ref.startsWith("~/")) return "real-path";
  return "name";
}

function segmentsOf(directory: string): readonly string[] {
  return directory.split("/").filter((segment) => segment.length > 0);
}

/**
 * The candidate name for one directory at a given leading-segment count: the
 * trailing `level` segments, joined by "/" — clamped to the whole array once
 * `level` reaches `segs.length` (a one-segment key at its base level, e.g.,
 * derives its bare single segment, matching R3's own worked example: `/foo`
 * derives `foo`, never `/foo`). `deriveDirectoryNames`'s growth loop never
 * advances a directory's `level` past its own `segs.length` (see that
 * function's guard), so `level` is always in `[0, segs.length]` here and this
 * clamp is the only case that needs handling — there is no separate "ran out
 * of segments" shape distinct from an ordinary bare join (see
 * `deriveDirectoryNames`'s own comment for why one is never needed).
 */
function candidateAtLevel(segs: readonly string[], level: number): string {
  if (segs.length === 0) return "/";
  return segs.slice(Math.max(0, segs.length - level)).join("/");
}

/**
 * R3's collision-growth fixed point, over a set of directories (duplicates
 * collapsed — the caller decides what "one entity" means; see
 * `computeAgentNames` for how an agent-store directory maps to one entry
 * here regardless of how many agents currently sit in it). Base level is
 * `min(2, segmentCount)`; a colliding group (2+ directories sharing a
 * candidate at their current levels) grows every member that still has
 * segments left, one at a time, and repeats until every candidate is
 * unique. TERMINATION: each directory's level is capped at its own segment
 * count (the `level < segs.length` guard below never grows it past that), so
 * a directory that reaches its own cap simply stops changing — its candidate
 * from then on is its FULL segment sequence joined by "/", which is a
 * DIFFERENT distinct directory's candidate can only equal if that directory
 * has the identical segment sequence, i.e. is the identical (already-deduped)
 * directory. So two directories can never share an at-cap candidate forever;
 * a colliding group where every member is capped is therefore impossible
 * (for 2+ distinct directories), and any group that still has a growing
 * member keeps shrinking on the next iteration. This is also why
 * `candidateAtLevel` needs no separate "ran out of segments" shape distinct
 * from an ordinary bare join (R3's own `/foo` -> `foo` example is exactly
 * this: a one-segment directory reaches its cap immediately and is already
 * unique on its own).
 */
export function deriveDirectoryNames(directories: readonly string[]): ReadonlyMap<string, string> {
  const unique = [...new Set(directories)];
  const segsByDirectory = new Map(unique.map((directory) => [directory, segmentsOf(directory)] as const));
  const levels = new Map(unique.map((directory) => [directory, Math.min(2, segsByDirectory.get(directory)!.length)] as const));

  let changed = true;
  while (changed) {
    changed = false;
    const groups = new Map<string, string[]>();
    for (const directory of unique) {
      const candidate = candidateAtLevel(segsByDirectory.get(directory)!, levels.get(directory)!);
      const group = groups.get(candidate);
      if (group === undefined) groups.set(candidate, [directory]);
      else group.push(directory);
    }
    for (const group of groups.values()) {
      if (group.length <= 1) continue;
      for (const directory of group) {
        const segs = segsByDirectory.get(directory)!;
        const level = levels.get(directory)!;
        if (level < segs.length) {
          levels.set(directory, level + 1);
          changed = true;
        }
      }
    }
  }

  const result = new Map<string, string>();
  for (const directory of unique) {
    result.set(directory, candidateAtLevel(segsByDirectory.get(directory)!, levels.get(directory)!));
  }
  return result;
}

export interface NameableAgent {
  readonly id: string;
  readonly directory: string;
  readonly state: string;
}

/**
 * The one function every consumer (resolution, `bakr list`, refusal
 * messages) should call rather than deriving names inline. Groups the
 * CURRENT non-archived agent set by directory (R3: archived agents get no
 * derived name and participate in no group — they are @id-only), derives
 * one name per directory via `deriveDirectoryNames`, and separately reports
 * which directories are held by more than one non-archived agent — R6's
 * "a legacy store that already violates one-per-directory must still load":
 * such a directory still gets a derived name (its would-be collision-group
 * member never disappears), but `agentsByDirectory` for it has more than one
 * id, which is the caller's own signal to refuse AMBIGUOUS rather than pick
 * one arbitrarily. `nameByAgentId` is therefore populated ONLY for a
 * directory held by exactly one non-archived agent — the single name a
 * caller can safely show or resolve by.
 */
export interface AgentNames {
  readonly nameByAgentId: ReadonlyMap<string, string>;
  readonly directoryToName: ReadonlyMap<string, string>;
  readonly agentIdsByDirectory: ReadonlyMap<string, readonly string[]>;
}

export function computeAgentNames<T extends NameableAgent>(agents: readonly T[]): AgentNames {
  const agentIdsByDirectory = new Map<string, string[]>();
  for (const agent of agents) {
    if (agent.state === "archived") continue;
    const ids = agentIdsByDirectory.get(agent.directory);
    if (ids === undefined) agentIdsByDirectory.set(agent.directory, [agent.id]);
    else ids.push(agent.id);
  }

  const directoryToName = deriveDirectoryNames([...agentIdsByDirectory.keys()]);

  const nameByAgentId = new Map<string, string>();
  for (const [directory, ids] of agentIdsByDirectory) {
    if (ids.length !== 1) continue;
    const name = directoryToName.get(directory);
    if (name !== undefined) nameByAgentId.set(ids[0]!, name);
  }

  return { nameByAgentId, directoryToName, agentIdsByDirectory };
}
