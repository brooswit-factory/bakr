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
// joined by "/"; a one-segment key derives that single segment; the root "/"
// derives "/". When two or more directories share a base name, EVERY member
// of that colliding group grows by one more leading segment, simultaneously,
// repeating until every candidate in the group is unique — `deriveDirectoryNames`
// implements that fixed-point. A directory that runs out of segments before
// it is unique keeps its full absolute path (leading "/" included); that
// representation can never collide with a still-growing candidate, since a
// still-growing candidate never carries a leading "/" (see that function's
// own comment for why this makes the fixed point well-defined without a
// depth cap).
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
 * The candidate name for one directory at a given leading-segment count.
 * `level >= segs.length` means "ran out of segments to grow with" — the
 * fallback is the full absolute path, leading "/" included, which is why it
 * is the one candidate shape here that can start with "/": every other
 * candidate is a bare join of trailing segments, and a real directory
 * segment can never itself contain "/", so the two shapes can never collide
 * (see `deriveDirectoryNames`'s own comment).
 */
function candidateAtLevel(segs: readonly string[], level: number): string {
  if (segs.length === 0) return "/";
  if (level >= segs.length) return `/${segs.join("/")}`;
  return segs.slice(segs.length - level).join("/");
}

/**
 * R3's collision-growth fixed point, over a set of directories (duplicates
 * collapsed — the caller decides what "one entity" means; see
 * `computeAgentNames` for how an agent-store directory maps to one entry
 * here regardless of how many agents currently sit in it). Base level is
 * `min(2, segmentCount)`; a colliding group (2+ directories sharing a
 * candidate at their current levels) grows every member that still has
 * segments left, one at a time, and repeats until every candidate is
 * unique. Terminates because each directory's level is strictly bounded by
 * its own segment count, and once a directory reaches that bound its
 * candidate is a full absolute path (leading "/"), which — by construction
 * — can never match a still-growing candidate (no leading "/") and so can
 * never keep the loop going on its account again.
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
