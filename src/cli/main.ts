import { homedir } from "node:os";
import { lexicallyNormalize } from "../claim-key";
import { resolveClaimKey, type ClaimKey } from "../claim-key-resolve";
import { claim } from "../claim-model";
import { load as loadClaims, withClaimStoreLock } from "../claim-store-io";
import { load as loadAgents } from "../agent-store-io";
import { emptyAgentStore, type AgentRecord, type RefClassification } from "../agent-model";
import { classifyRef } from "../agent-name";
import * as actions from "../agent-actions";
import { adopt } from "../adopt";
import { probeDirectory } from "../orphan-probe";
import { classifyClaims, buildOffers, applyDestinationHint } from "../orphan-model";
import { isHerdrPaneId, listBackgroundSessions, type BackgroundSessionInfo } from "../spawn";
import type { AdoptDeps } from "../adopt";
import type { AgentActionDeps } from "../agent-actions";
import type { ResolveInputs } from "../claim-key-resolve";
import type { OrphanProbeDeps } from "../orphan-probe";
import { parseArgv, type ParsedCommand } from "./grammar";
import { attachInPlace } from "./attach";
import { confirmDelete } from "./confirm";
import { residentRefusal, resolveResidentCwd, type ResidentMessenger } from "./send";
import { approvalExitCode, findOwnPrompt, ownPendingPermissions, renderApproval, renderPendingPermissions, resolveOperator, type PermissionHost } from "./permissions";
import { EXIT_FAILURE, EXIT_REFUSAL, EXIT_SUCCESS, EXIT_USAGE } from "./exit-codes";
import { formatMcpSpec, parseMcpSpec, type McpServerDeclaration } from "../launch-config";

export interface CliDeps {
  actions: AgentActionDeps;
  adopt: AdoptDeps;
  claimsPath: string;
  resolveInputs: ResolveInputs;
  probeDeps: OrphanProbeDeps;
  cwd: string;
  home?: string;
  stdinIsTTY: boolean;
  stdoutIsTTY: boolean;
  stdout(s: string): void;
  stderr(s: string): void;
  prompt(s: string): Promise<string>;
  spawnAttach(id: string): Promise<number>;
  messenger: ResidentMessenger;
  /** Reads the tool-permission prompts on this host's Claude panes; `permissions` narrows them to one agent. */
  permissions: PermissionHost;
  /** Where `approve` records every attempt: `$XDG_STATE_HOME/bakr/permission-approvals.jsonl`, beside agents.json. */
  permissionAuditPath: string;
  /** `$USER`: the operator `approve` records when `--as` is not given. */
  user?: string;
  /** The Claude session running this command, if any (CLAUDE_CODE_SESSION_ID): `relaunch` never kills its own caller. */
  selfSessionId?: string;
}

const help = `usage:\n  bakr [--dir <path>] ...      (deprecated: use "bakr <parent>/<leaf> ..." from any directory)\n  bakr\n  bakr list [--archived]\n  bakr create [--mcp <server>[:no-notify] ...]\n  bakr adopt <@id> [<@id> ...]\n  bakr <id|path|name>          (starts it if off, attaches if on; from any directory)\n  bakr <id|path|name> on|off|archive|unarchive|delete [--yes]\n  bakr <id|path|name> send <message>\n  bakr <id|path|name> permissions\n  bakr <id|path|name> approve <promptId> [--always] [--as <operator>]\n  bakr <id|path|name> mcp [<server>[:no-notify] ... | default]\n  bakr <id|path|name> relaunch\n  bakr relaunch --all\n\nan agent's name is its directory's last two path segments (e.g. ~/code/x/y is "x/y"), grown by one more leading\nsegment on a collision. A ref is an id iff it starts with "@"; a real path iff it starts with "/", "./", "../",\n"~/", or is exactly "~"; anything else, slash included, is a name — "bakr code/x" is a name, "bakr ./code/x" is a path.\n`;

/** Parses every spec, or returns the first refusal; duplicates keep their last spelling. */
function parseMcpSpecs(specs: readonly string[]): McpServerDeclaration[] | string {
  const byName = new Map<string, McpServerDeclaration>();
  for (const spec of specs) {
    const parsed = parseMcpSpec(spec);
    if (typeof parsed === "string") return parsed;
    byName.set(parsed.name, parsed);
  }
  return [...byName.values()];
}

const describeMcp = (servers: readonly McpServerDeclaration[]): string => servers.length === 0 ? "none" : servers.map(formatMcpSpec).join(" ");
/** BAKR-34/BAKR-42 R1: `agent.name` is legacy-only now — a label shows the CURRENT derived name (agent-name.ts), fetched separately (see `currentNames`), never the stored field. */
const label = (a: AgentRecord, derivedName: string | undefined) => `${a.id}${derivedName === undefined ? "" : ` "${derivedName}"`}`;
const refusalCode = (reason: string) => reason === "store-malformed" || reason === "listing-failed" || reason === "store-degraded" ? EXIT_FAILURE : EXIT_REFUSAL;
export const isAttachJobListed = (restoreSessionId:string, sessions:readonly {sessionId:string}[]):boolean => sessions.some(session => session.sessionId === restoreSessionId);

/** The GLOBAL derived-name set, for display — `store-malformed` degrades to "no names known" rather than failing a command that has already succeeded at its primary action; the malformed store is always also surfaced by that primary action's own result. */
async function currentNames(d: CliDeps): Promise<ReadonlyMap<string, string>> {
  const result = await actions.agentNames(d.actions);
  return result.ok ? result.names.nameByAgentId : new Map();
}

// Same exact-id + in-directory rule `send` delivers on, so list never reports an agent as reachable that send would refuse.
function availability(agent: AgentRecord, sessions: readonly BackgroundSessionInfo[]): string {
  if (!agent.restoreTarget) return "not listed";
  const r = resolveResidentCwd(agent.directory, agent.restoreTarget.sessionId, sessions);
  if (r.ok) return r.cwd === agent.directory ? "listed by claude" : `listed by claude in ${r.cwd.slice(agent.directory.length + 1)}`;
  return r.reason === "not-running" ? "not listed" : `listed by claude, not sendable (${r.reason})`;
}

/** Prints one relaunch outcome; true when the agent now runs a new session. */
function renderRelaunch(r: actions.RelaunchResult, names: ReadonlyMap<string, string>, d: CliDeps): boolean {
  if (!r.ok) { d.stderr(`${r.reason}: ${r.message}\n`); return false; }
  const channels = r.args.filter((arg) => arg.startsWith("--dangerously-load-development-channels=")).map((arg) => arg.slice(arg.indexOf("=") + 1));
  d.stdout(`relaunched ${label(r.agent, names.get(r.agent.id))}: ${r.previous.shortId} -> ${r.next.shortId} (session ${r.next.sessionId}), ${r.resumed ? "resumed with its conversation" : "fresh (the old session had no transcript)"}\n`);
  d.stdout(`channels: ${channels.length ? channels.join(" ") : "none"}\n`);
  return true;
}

function refuse(result: { reason: string; message: string }, d: CliDeps): number {
  d.stderr(`${result.reason}: ${result.message}\n`);
  return refusalCode(result.reason);
}
function renderStop(stop: actions.StopOutcome, d: CliDeps): boolean {
  if (stop.kind === "stop-failed" || stop.kind === "listing-failed") {
    d.stderr(`${stop.kind}: ${stop.error}\n`); return false;
  }
  if (stop.kind === "stopped") d.stdout(`stopped claude session ${stop.shortId}\n`);
  else if (stop.kind === "launches-ended") d.stdout(stop.shortIds.length ? `its launches had already ended: ${stop.shortIds.join(" ")}\n` : "it never started a session\n");
  else d.stdout(`${stop.kind.replaceAll("-", " ")}\n`);
  return true;
}

async function resolveDirectory(pathInput: string, d: CliDeps): Promise<ClaimKey | undefined> {
  const lexical = lexicallyNormalize(pathInput, { cwd: d.cwd, home: d.home ?? homedir() });
  const resolved = await resolveClaimKey(lexical, d.resolveInputs);
  if (!resolved.ok) d.stderr(`${resolved.reason}: ${resolved.reason === "resolve-failed" ? resolved.message : resolved.path}\n`);
  return resolved.ok ? resolved.key : undefined;
}

/**
 * R2's lexical id/real-path/name split, turned into a `RefClassification`
 * (agent-model.ts) a resolver can consume. Only the "real path" case is
 * impure (symlink-aware resolution, claim-key-resolve.ts) — an id or a name
 * ref carries the raw string unchanged and needs no filesystem access at
 * all, which is what makes both resolve globally, independent of `d.cwd`.
 */
async function classifyRefInput(ref: string, d: CliDeps): Promise<RefClassification | undefined> {
  const kind = classifyRef(ref);
  if (kind === "id") return { kind: "id", ref };
  if (kind === "name") return { kind: "name", ref };
  const directory = await resolveDirectory(ref, d);
  return directory === undefined ? undefined : { kind: "directory", directory };
}

async function claimDirectory(directory: ClaimKey, d: CliDeps): Promise<boolean> {
  const probe = await probeDirectory(directory, d.probeDeps);
  const identity = probe.kind === "exists" ? { dev: probe.device, ino: probe.inode } : undefined;
  const result = await withClaimStoreLock(d.claimsPath, current => { const next = claim(current, directory, Date.now(), identity); return { state: next.state, result: next.claim }; });
  if (result.status === "malformed") { d.stderr(`store-malformed: ${result.error}\n`); return false; }
  return true;
}

async function renderList(directory: ClaimKey, showArchived: boolean, d: CliDeps, emptyDiscovery = false): Promise<number> {
  const result = await actions.list(d.actions, directory);
  if (!result.ok) return refuse(result, d);
  let sessions: readonly BackgroundSessionInfo[] = [];
  let listingFailed: string | undefined;
  try { sessions = await listBackgroundSessions({ runCommand: d.actions.runCommand }); }
  catch (e) { listingFailed = e instanceof Error ? e.message : String(e); }
  const agents = result.agents.filter(a => showArchived || a.state !== "archived");
  const names = await currentNames(d);
  if (!agents.length) d.stdout(emptyDiscovery ? "no agents yet — `bakr create` makes one\n" : "no agents\n");
  else for (const agent of agents) d.stdout(`${label(agent, names.get(agent.id))} — ${agent.state} — ${listingFailed ? "could not list" : availability(agent, sessions)}\n`);
  return EXIT_SUCCESS;
}

/** Bare `bakr` in a directory: claim it, list what's there (or say there's nothing yet), and surface adoption offers. R2's "bare bakr in a directory, as today" — reused for a bare `bakr <real path>` targeting a directory with no non-archived agent yet (see `handleAttach`), rather than auto-creating one. */
async function discover(directory: ClaimKey, d: CliDeps): Promise<number> {
  if (!(await claimDirectory(directory, d))) return EXIT_FAILURE;
  const code = await renderList(directory, false, d, true); if (code !== 0) return code;
  const [claims, agents] = await Promise.all([loadClaims(d.claimsPath), loadAgents(d.actions.agentsPath)]);
  if (claims.status === "malformed") { d.stderr(`store-malformed: ${claims.error}\n`); return EXIT_FAILURE; }
  if (agents.status === "malformed") { d.stderr(`store-malformed: ${agents.error}\n`); return EXIT_FAILURE; }
  const claimState = claims.status === "loaded" ? claims.state : { claims: {} };
  const agentState = agents.status === "loaded" ? agents.state : emptyAgentStore();
  const probes = new Map<ClaimKey, Awaited<ReturnType<typeof probeDirectory>>>();
  await Promise.all(Object.values(claimState.claims).map(async c => probes.set(c.key, await probeDirectory(c.key, d.probeDeps))));
  const here = await probeDirectory(directory, d.probeDeps);
  const identity = here.kind === "exists" ? { dev: here.device, ino: here.inode } : undefined;
  const offers = applyDestinationHint(buildOffers(classifyClaims(claimState, agentState, probes)), identity, directory)
    .filter(o => o.agents.length).sort((a,b) => Number(Boolean(b.hintMatchedDestination))-Number(Boolean(a.hintMatchedDestination)));
  for (const offer of offers) d.stdout(`adoption offer${offer.hintMatchedDestination ? " (likely moved here)" : ""}: ${offer.source}\n  bakr adopt ${offer.agents.map(a => a.id).join(" ")}\n`);
  return EXIT_SUCCESS;
}

/** `on` (start-if-off / no-op-if-on), printed the same way whether reached via the explicit `on` verb or bare `bakr <ref>` (R5). */
function renderOn(r: actions.OnResult, names: ReadonlyMap<string, string>, d: CliDeps): number {
  if (!r.ok) return refuse(r, d);
  d.stdout(r.kind === "no-change" ? "already on\n" : `turned on ${label(r.agent, names.get(r.agent.id))}\n`);
  if (r.launchWedgeCleared) d.stdout("cleared failed launch record for the current attempt\n");
  if (r.forkWedgeCleared) d.stdout("cleared stray failed fork-from record\n");
  if (r.recovery) {
    d.stdout(`recovery: ${r.recovery.kind}\n`);
    if (r.recovery.kind === "refused") d.stderr(`${r.recovery.error}\n`);
    else if ("abandonedSessionId" in r.recovery && r.recovery.abandonedSessionId) d.stderr(`WARNING: ABANDONED SESSION ${r.recovery.abandonedSessionId}\n`);
  }
  return r.recovery?.kind === "refused" ? 1 : 0;
}

/**
 * Bare `bakr <ref>` (R5): starts the agent if it is off, or no-ops if
 * already on — archived stays refused, never a silently unarchived — and
 * then attaches, using the identical conservative "exact job must already
 * be listed" gate the explicit `attach` path always has (Claude Code 2.1.269
 * was measured to make `claude attach <shortId>` respawn an absent job).
 * The CLI runs the `on` path first, and only then attaches.
 */
async function startIfOffAttachIfOn(classification: RefClassification, refInput: string, d: CliDeps): Promise<number> {
  const onResult = await actions.on(d.actions, classification);
  const onCode = renderOn(onResult, await currentNames(d), d);
  if (!onResult.ok) return onCode;

  const target = await actions.attachTarget(d.actions, classification);
  if (!target.ok) return refuse(target, d);
  let sessions;
  try { sessions = await listBackgroundSessions({ runCommand: d.actions.runCommand }); }
  catch (e) { return refuse({ reason: "listing-failed", message: `cannot safely attach without a successful claude listing: ${e instanceof Error ? e.message : String(e)}` }, d); }
  if (!isAttachJobListed(target.restoreSessionId, sessions)) {
    return refuse({ reason: "not-yet-live", message: `agent ${target.agent.id} is on in bakr's store but its exact job is not listed by claude yet — run \`bakr ${refInput}\` again shortly` }, d);
  }
  const handoff = await attachInPlace(target.agent.restoreTarget!.shortId, { stdinIsTTY: d.stdinIsTTY, stdoutIsTTY: d.stdoutIsTTY, spawn: d.spawnAttach });
  if (!handoff.ok) { d.stderr(`non-tty: ${handoff.message}\n`); return 1; }
  return handoff.exitCode;
}

/**
 * Bare `bakr <ref>` dispatch (R2/R5). A real-path ref that resolves to no
 * non-archived agent yet falls back to `discover` scoped to that directory
 * — "bare bakr in a directory, as today" (R2's own "Creating" rule) — never
 * for an id or a name ref, neither of which can ever create (there is no
 * directory to create in without a real path).
 */
async function handleAttach(refInput: string, d: CliDeps): Promise<number> {
  const classification = await classifyRefInput(refInput, d);
  if (classification === undefined) return EXIT_FAILURE;
  if (classification.kind === "directory") {
    const resolved = await actions.resolveTarget(d.actions, classification);
    if (!resolved.ok && resolved.reason === "not-found") {
      return discover(classification.directory, d);
    }
  }
  return startIfOffAttachIfOn(classification, refInput, d);
}

async function handle(command: ParsedCommand, d: CliDeps): Promise<number> {
  if (command.kind === "help") { d.stdout(help); return 0; }
  if (command.kind === "discover") {
    const directory = await resolveDirectory(d.cwd, d); if (!directory) return EXIT_FAILURE;
    return discover(directory, d);
  }
  if (command.kind === "list") {
    const directory = await resolveDirectory(d.cwd, d); if (!directory) return EXIT_FAILURE;
    return renderList(directory, command.showArchived, d);
  }
  if (command.kind === "create") {
    // Claim BEFORE the agent record exists, mirroring adopt.ts's Q6 order:
    // the daemon restores only agents in CLAIMED directories, so an `on`
    // agent written into an unclaimed one would never come back after a
    // reboot. The claim is idempotent and saved atomically under its lock,
    // so a crash in between leaves at worst a harmless empty claim.
    const mcp = command.mcp === undefined ? undefined : parseMcpSpecs(command.mcp);
    if (typeof mcp === "string") { d.stderr(`bakr: usage error: ${mcp}\n`); return EXIT_USAGE; }
    const directory = await resolveDirectory(d.cwd, d); if (!directory) return EXIT_FAILURE;
    if (!(await claimDirectory(directory, d))) return EXIT_FAILURE;
    const r = await actions.create(d.actions, directory, mcp); if (!r.ok) return refuse(r,d);
    d.stdout(`created ${r.agent.id}\nattach with: bakr ${r.agent.id}\n`);
    if (!r.launch.ok) { d.stderr(`launch-failed: ${r.launch.error}\n`); return EXIT_FAILURE; }
    return 0;
  }
  if (command.kind === "attach") return handleAttach(command.ref, d);
  if (command.kind === "send") {
    const classification = await classifyRefInput(command.ref, d); if (!classification) return EXIT_FAILURE;
    const r = await actions.attachTarget(d.actions, classification); if (!r.ok) return refuse(r,d);
    let sessions;
    try { sessions = await listBackgroundSessions({ runCommand: d.actions.runCommand }); }
    catch (e) { return refuse({ reason: "listing-failed", message: `cannot find agent ${r.agent.id}'s session without a successful claude listing: ${e instanceof Error ? e.message : String(e)}` }, d); }
    const where = resolveResidentCwd(r.agent.directory, r.restoreSessionId, sessions);
    if (!where.ok) return refuse({ reason: where.reason, message: `agent ${r.agent.id} is on in bakr's store but ${where.message} — nothing was sent${where.reason === "not-running" ? `; the daemon restores it, or run \`bakr ${command.ref} on\`` : ""}` }, d);
    let result;
    try { result = await d.messenger.message({ provider: "claude", sessionId: r.restoreSessionId, cwd: where.cwd }, command.message); }
    catch (e) {
      const refusal = residentRefusal(e); if (!refusal) throw e;
      d.stderr(`${refusal.reason}: ${refusal.message}\n`);
      return refusal.reason === "delivery-unconfirmed" ? EXIT_FAILURE : EXIT_REFUSAL;
    }
    if (result.reply) d.stdout(result.reply.endsWith("\n") ? result.reply : `${result.reply}\n`);
    if (result.status === "replied") return EXIT_SUCCESS;
    d.stderr(`reply-pending: delivered to agent ${r.agent.id}, but its turn had not finished; attach with \`bakr ${command.ref}\` to follow\n`);
    return EXIT_REFUSAL;
  }
  if (command.kind === "permissions") {
    const classification = await classifyRefInput(command.ref, d); if (!classification) return EXIT_FAILURE;
    const r = await actions.resolveTarget(d.actions, classification); if (!r.ok) return refuse(r, d);
    const target = r.agent.restoreTarget;
    const names = await currentNames(d);
    if (target === undefined) { d.stdout(`${label(r.agent, names.get(r.agent.id))} has never been launched, so it has no pane to prompt on: no pending prompts\n`); return EXIT_SUCCESS; }
    let pending;
    try { pending = await d.permissions.list(); }
    catch (e) { return refuse({ reason: "listing-failed", message: `cannot read agent ${r.agent.id}'s pane: ${e instanceof Error ? e.message : String(e)}` }, d); }
    d.stdout(renderPendingPermissions(ownPendingPermissions(target, pending)));
    if (!isHerdrPaneId(target.shortId)) d.stderr(`note: agent ${r.agent.id} still runs under legacy \`claude --bg\` (${target.shortId}), whose prompts cannot be read; \`bakr ${command.ref} relaunch\` moves it into herdr\n`);
    return EXIT_SUCCESS;
  }
  if (command.kind === "approve") {
    // Refused before anything is read or pressed: drovr records the operator
    // on every attempt and an empty one would be an unattributed approval.
    const operator = resolveOperator(command.operator, d.user);
    if (operator === undefined) { d.stderr(`bakr: usage error: approve needs an operator: $USER is ${d.user === undefined ? "unset" : "empty"}; pass --as <operator>\n`); return EXIT_USAGE; }
    const classification = await classifyRefInput(command.ref, d); if (!classification) return EXIT_FAILURE;
    const r = await actions.resolveTarget(d.actions, classification); if (!r.ok) return refuse(r, d);
    const names = await currentNames(d);
    const target = r.agent.restoreTarget;
    if (target === undefined) return refuse({ reason: "no-prompt", message: `${label(r.agent, names.get(r.agent.id))} has never been launched, so it has no pane to prompt on; nothing was pressed` }, d);
    let pending;
    try { pending = await d.permissions.list(); }
    catch (e) { return refuse({ reason: "listing-failed", message: `cannot read agent ${r.agent.id}'s pane: ${e instanceof Error ? e.message : String(e)}; nothing was pressed` }, d); }
    const own = findOwnPrompt(target, pending, command.promptId, label(r.agent, names.get(r.agent.id)));
    if (!own.ok) {
      d.stderr(`${own.reason}: ${own.detail}; nothing was pressed\n`);
      if (!isHerdrPaneId(target.shortId)) d.stderr(`note: agent ${r.agent.id} still runs under legacy \`claude --bg\` (${target.shortId}), whose prompts cannot be read or answered; \`bakr ${command.ref} relaunch\` moves it into herdr\n`);
      return EXIT_REFUSAL;
    }
    // `always` is reachable only from a typed --always; there is no other
    // scope and no path to drovr's auto-mode option, which it never picks.
    const scope = command.always ? "always" : "once";
    let result;
    try { result = await d.permissions.approve({ paneId: own.prompt.paneId, promptId: command.promptId, operator, scope, auditPath: d.permissionAuditPath }); }
    catch (e) {
      d.stderr(`approve-failed: ${e instanceof Error ? e.message : String(e)}; whether a key reached pane ${own.prompt.paneId} is unknown and nothing was retried; \`bakr ${command.ref} permissions\` shows what is on it now\n`);
      return EXIT_FAILURE;
    }
    if (!result.ok) { d.stderr(`${result.reason}: ${result.detail} (attempt ${result.attemptId}; not retried)\n`); return approvalExitCode(result.reason); }
    d.stdout(renderApproval(label(r.agent, names.get(r.agent.id)), result, d.permissionAuditPath));
    return EXIT_SUCCESS;
  }
  if (command.kind === "adopt") {
    const store = await loadAgents(d.actions.agentsPath); if (store.status === "malformed") return refuse({reason:"store-degraded",message:store.error},d);
    const all = Object.values((store.status === "loaded" ? store.state : emptyAgentStore()).agents);
    const selected = command.ids.map(id => all.find(a => a.id === id)).filter((a): a is AgentRecord => a !== undefined);
    if (selected.length !== command.ids.length) return refuse({reason:"unknown-agent",message:"every adopt argument must name an existing agent id"},d);
    const sources = new Set(selected.map(a => a.directory)); if (sources.size !== 1) return refuse({reason:"mixed-sources",message:"all adopted agents must come from the same source directory"},d);
    const r = await adopt(d.adopt,{source:selected[0]!.directory,destinationInput:d.cwd,agentIds:command.ids}); if (!r.ok) return refuse(r,d);
    d.stdout(`adopted ${r.adoptedAgentIds.join(" ")} into ${r.destination}\n`); return 0;
  }
  if (command.kind === "delete") {
    const confirmed=await confirmDelete(command.yes,command.ref,{stdinIsTTY:d.stdinIsTTY,prompt:d.prompt}); if(!confirmed.ok){d.stderr(`${confirmed.message}\n`);return 1;}
    const classification = await classifyRefInput(command.ref, d); if (!classification) return EXIT_FAILURE;
    const r=await actions.deleteAgent(d.actions,classification); if(!r.ok)return refuse(r,d);
    if(!renderStop(r.stop,d)) return 3;
    if(r.kind==="parked"){d.stderr(`parked: agent was NOT deleted: ${r.message}\n`);return 1;} d.stdout(`deleted ${r.agentId}\n`);return 0;
  }
  if (command.kind === "mcp") {
    const specs = command.specs;
    const declaration = specs === undefined ? undefined : specs[0] === "default" ? null : parseMcpSpecs(specs);
    if (typeof declaration === "string") { d.stderr(`bakr: usage error: ${declaration}\n`); return EXIT_USAGE; }
    const classification = await classifyRefInput(command.ref, d); if (!classification) return EXIT_FAILURE;
    const r = await actions.mcp(d.actions, classification, declaration); if (!r.ok) return refuse(r, d);
    const names = await currentNames(d);
    const own = r.agent.mcp;
    d.stdout(`${label(r.agent, names.get(r.agent.id))} mcp: ${own === undefined ? "default (every server in its .mcp.json)" : describeMcp(own)}\n`);
    d.stdout(`next start carries: ${describeMcp(r.effective)}\n`);
    if (r.missing.length > 0) d.stderr(`not configured in its .mcp.json, so dropped: ${r.missing.join(" ")}\n`);
    if (r.changed) {
      d.stdout("approval written; a running session picks it up at its next start.\n");
      d.stdout(`a changed subscription reaches a running session only through a fork: run "bakr ${names.get(r.agent.id) ?? r.agent.id} relaunch" (off/on respawns it with the channels it was first launched with).\n`);
    }
    return 0;
  }
  if (command.kind === "relaunch") {
    const classification = await classifyRefInput(command.ref, d); if (!classification) return EXIT_FAILURE;
    const r = await actions.relaunch(d.actions, classification, d.selfSessionId === undefined ? {} : { selfSessionId: d.selfSessionId });
    const names = await currentNames(d);
    return renderRelaunch(r, names, d) ? 0 : r.ok === false && (r.reason === "launch-failed" || r.reason === "unlisted") ? EXIT_FAILURE : refusalCode(r.ok ? "" : r.reason);
  }
  if (command.kind === "relaunch-all") {
    const agents = await actions.relaunchCandidates(d.actions);
    if (!Array.isArray(agents)) return refuse(agents as { reason: string; message: string }, d);
    const names = await currentNames(d);
    let failed = 0;
    for (const agent of agents as readonly AgentRecord[]) {
      d.stdout(`${label(agent, names.get(agent.id))} in ${agent.directory}:\n`);
      const r = await actions.relaunch(d.actions, { kind: "id", ref: agent.id }, d.selfSessionId === undefined ? {} : { selfSessionId: d.selfSessionId });
      const skipped = !r.ok && (r.reason === "self" || r.reason === "busy");
      if (!renderRelaunch(r, names, d) && !skipped) failed += 1;
    }
    d.stdout(`relaunched ${agents.length - failed} of ${agents.length} candidate agent(s)${failed ? `; ${failed} failed` : ""}\n`);
    return failed ? EXIT_FAILURE : 0;
  }
  if (command.kind === "on") {
    const classification = await classifyRefInput(command.ref, d); if (!classification) return EXIT_FAILURE;
    const r = await actions.on(d.actions, classification);
    return renderOn(r, await currentNames(d), d);
  }
  const classification = await classifyRefInput(command.ref, d); if (!classification) return EXIT_FAILURE;
  const names = await currentNames(d);
  if (command.kind === "off") { const r=await actions.off(d.actions,classification);if(!r.ok)return refuse(r,d);d.stdout(r.kind==="no-change"?"already off\n":`turned off ${label(r.agent, names.get(r.agent.id))}\n`);if(r.kind==="turned-off"&&!renderStop(r.stop,d))return 3;return 0; }
  if (command.kind === "archive") { const r=await actions.archive(d.actions,classification);if(!r.ok)return refuse(r,d);d.stdout(r.kind==="no-change"?"already archived\n":`archived ${label(r.agent, names.get(r.agent.id))}\n`);if(r.kind==="archived"&&!renderStop(r.stop,d))return 3;return 0; }
  const r=await actions.unarchive(d.actions,classification);if(!r.ok)return refuse(r,d);d.stdout(`unarchived ${label(r.agent, names.get(r.agent.id))} — off\n`);
  return 0;
}

export async function runCli(argv:string[],d:CliDeps):Promise<number>{const parsed=parseArgv(argv);if(!parsed.ok){d.stderr(`bakr: usage error: ${parsed.message}\n${help}`);return EXIT_USAGE;}if(parsed.command.kind==="help"){d.stdout(help);return 0;}try{return await handle(parsed.command,d);}catch(e){d.stderr(`bakr could not serve the request: ${e instanceof Error?e.message:String(e)}\n`);return EXIT_FAILURE;}}
