import { homedir } from "node:os";
import { lexicallyNormalize } from "../claim-key";
import { resolveClaimKey, type ClaimKey } from "../claim-key-resolve";
import { claim } from "../claim-model";
import { load as loadClaims, withClaimStoreLock } from "../claim-store-io";
import { load as loadAgents } from "../agent-store-io";
import { emptyAgentStore, type AgentRecord } from "../agent-model";
import * as actions from "../agent-actions";
import { adopt } from "../adopt";
import { probeDirectory } from "../orphan-probe";
import { classifyClaims, buildOffers, applyDestinationHint } from "../orphan-model";
import { listBackgroundSessions } from "../spawn";
import type { AdoptDeps } from "../adopt";
import type { AgentActionDeps } from "../agent-actions";
import type { ResolveInputs } from "../claim-key-resolve";
import type { OrphanProbeDeps } from "../orphan-probe";
import { parseArgv, type ParsedCommand } from "./grammar";
import { attachInPlace } from "./attach";
import { confirmDelete } from "./confirm";
import { residentRefusal, type ResidentMessenger } from "./send";
import { EXIT_FAILURE, EXIT_REFUSAL, EXIT_SUCCESS, EXIT_USAGE } from "./exit-codes";

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
}

const help = `usage:\n  bakr\n  bakr list [--archived]\n  bakr create [--name <name>]\n  bakr adopt <@id> [<@id> ...]\n  bakr <id|name>\n  bakr <id|name> on|off|archive|unarchive|delete [--yes]|name <new>|rename <new>\n  bakr <id|name> send <message>\n`;
const label = (a: AgentRecord) => `${a.id}${a.name === undefined ? "" : ` \"${a.name}\"`}`;
const refusalCode = (reason: string) => reason === "store-malformed" || reason === "listing-failed" || reason === "store-degraded" ? EXIT_FAILURE : EXIT_REFUSAL;
export const isAttachJobListed = (restoreSessionId:string, sessions:readonly {sessionId:string}[]):boolean => sessions.some(session => session.sessionId === restoreSessionId);

function refuse(result: { reason: string; message: string }, d: CliDeps): number {
  d.stderr(`${result.reason}: ${result.message}\n`);
  return refusalCode(result.reason);
}
function renderStop(stop: actions.StopOutcome, d: CliDeps): boolean {
  if (stop.kind === "stop-failed" || stop.kind === "listing-failed") {
    d.stderr(`${stop.kind}: ${stop.error}\n`); return false;
  }
  if (stop.kind === "stopped") d.stdout(`stopped claude session ${stop.shortId}\n`);
  else d.stdout(`${stop.kind.replaceAll("-", " ")}\n`);
  return true;
}

async function resolveDirectory(d: CliDeps): Promise<ClaimKey | undefined> {
  const lexical = lexicallyNormalize(d.cwd, { cwd: d.cwd, home: d.home ?? homedir() });
  const resolved = await resolveClaimKey(lexical, d.resolveInputs);
  if (!resolved.ok) d.stderr(`${resolved.reason}: ${resolved.reason === "resolve-failed" ? resolved.message : resolved.path}\n`);
  return resolved.ok ? resolved.key : undefined;
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
  let listed: readonly AgentRecord[] = [];
  let listingFailed: string | undefined;
  try { listed = (await listBackgroundSessions({ runCommand: d.actions.runCommand })).map(s => ({ id: s.sessionId } as unknown as AgentRecord)); }
  catch (e) { listingFailed = e instanceof Error ? e.message : String(e); }
  const agents = result.agents.filter(a => showArchived || a.state !== "archived");
  if (!agents.length) d.stdout(emptyDiscovery ? "no agents yet — `bakr create` makes one\n" : "no agents\n");
  else for (const agent of agents) d.stdout(`${label(agent)} — ${agent.state} — ${listingFailed ? "could not list" : listed.some(x => x.id === agent.restoreTarget?.sessionId) ? "listed by claude" : "not listed"}\n`);
  return EXIT_SUCCESS;
}

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

async function handle(command: ParsedCommand, directory: ClaimKey, d: CliDeps): Promise<number> {
  if (command.kind === "help") { d.stdout(help); return 0; }
  if (command.kind === "discover") return discover(directory, d);
  if (command.kind === "list") return renderList(directory, command.showArchived, d);
  if (command.kind === "create") {
    // Claim BEFORE the agent record exists, mirroring adopt.ts's Q6 order:
    // the daemon restores only agents in CLAIMED directories, so an `on`
    // agent written into an unclaimed one would never come back after a
    // reboot. The claim is idempotent and saved atomically under its lock,
    // so a crash in between leaves at worst a harmless empty claim.
    if (!(await claimDirectory(directory, d))) return EXIT_FAILURE;
    const r = await actions.create(d.actions, directory, command.name); if (!r.ok) return refuse(r,d);
    d.stdout(`created ${label(r.agent)}\nattach with: bakr ${r.agent.id}\n`);
    if (!r.launch.ok) { d.stderr(`launch-failed: ${r.launch.error}\n`); return EXIT_FAILURE; }
    return 0;
  }
  if (command.kind === "attach") {
    const r = await actions.attachTarget(d.actions, directory, command.ref); if (!r.ok) return refuse(r,d);
    // Claude Code 2.1.269 was measured to make `claude attach <shortId>`
    // respawn an absent job. Attach must remain a query + terminal handoff,
    // never an implicit lifecycle act, so require this exact full job id in
    // one successful listing before invoking attach.
    let sessions;
    try { sessions = await listBackgroundSessions({ runCommand: d.actions.runCommand }); }
    catch (e) { return refuse({ reason: "listing-failed", message: `cannot safely attach without a successful claude listing: ${e instanceof Error ? e.message : String(e)}` }, d); }
    if (!isAttachJobListed(r.restoreSessionId, sessions)) {
      return refuse({ reason: "not-yet-live", message: `agent ${r.agent.id} is on in bakr's store but its exact job is not listed by claude — refusing because claude attach would wake it implicitly; run \`bakr ${command.ref} on\`, wait for it to become listed, then attach` }, d);
    }
    const handoff = await attachInPlace(r.agent.restoreTarget!.shortId, { stdinIsTTY:d.stdinIsTTY, stdoutIsTTY:d.stdoutIsTTY, spawn:d.spawnAttach });
    if (!handoff.ok) { d.stderr(`non-tty: ${handoff.message}\n`); return 1; } return handoff.exitCode;
  }
  if (command.kind === "send") {
    const r = await actions.attachTarget(d.actions, directory, command.ref); if (!r.ok) return refuse(r,d);
    let result;
    try { result = await d.messenger.message({ provider: "claude", sessionId: r.restoreSessionId, cwd: r.agent.directory }, command.message); }
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
    const r=await actions.deleteAgent(d.actions,directory,command.ref); if(!r.ok)return refuse(r,d);
    if(!renderStop(r.stop,d)) return 3;
    if(r.kind==="parked"){d.stderr(`parked: agent was NOT deleted: ${r.message}\n`);return 1;} d.stdout(`deleted ${r.agentId}\n`);return 0;
  }
  if (command.kind === "rename") { const r=await actions.rename(d.actions,directory,command.ref,command.newName);if(!r.ok)return refuse(r,d);d.stdout(`renamed ${label(r.agent)}\n`);return 0; }
  if (command.kind === "on") {
    const r=await actions.on(d.actions,directory,command.ref);if(!r.ok)return refuse(r,d);
    d.stdout(r.kind === "no-change" ? "already on\n" : `turned on ${label(r.agent)}\n`);
    if(r.launchWedgeCleared)d.stdout("cleared failed launch record for the current attempt\n");
    if(r.forkWedgeCleared)d.stdout("cleared stray failed fork-from record\n");
    if(r.recovery){d.stdout(`recovery: ${r.recovery.kind}\n`);if(r.recovery.kind==="refused")d.stderr(`${r.recovery.error}\n`);else if("abandonedSessionId" in r.recovery && r.recovery.abandonedSessionId)d.stderr(`WARNING: ABANDONED SESSION ${r.recovery.abandonedSessionId}\n`);}
    return r.recovery?.kind === "refused" ? 1 : 0;
  }
  if(command.kind === "off") {const r=await actions.off(d.actions,directory,command.ref);if(!r.ok)return refuse(r,d);d.stdout(r.kind==="no-change"?"already off\n":`turned off ${label(r.agent)}\n`);if(r.kind==="turned-off"&&!renderStop(r.stop,d))return 3;return 0;}
  if(command.kind === "archive") {const r=await actions.archive(d.actions,directory,command.ref);if(!r.ok)return refuse(r,d);d.stdout(r.kind==="no-change"?"already archived\n":`archived ${label(r.agent)}\n`);if(r.kind==="archived"&&!renderStop(r.stop,d))return 3;return 0;}
  const r=await actions.unarchive(d.actions,directory,command.ref);if(!r.ok)return refuse(r,d);d.stdout(`unarchived ${label(r.agent)} — off\n`);
  return 0;
}

export async function runCli(argv:string[],d:CliDeps):Promise<number>{const parsed=parseArgv(argv);if(!parsed.ok){d.stderr(`bakr: usage error: ${parsed.message}\n${help}`);return EXIT_USAGE;}if(parsed.command.kind==="help"){d.stdout(help);return 0;}const directory=await resolveDirectory(d);if(!directory)return EXIT_FAILURE;try{return await handle(parsed.command,directory,d);}catch(e){d.stderr(`bakr could not serve the request: ${e instanceof Error?e.message:String(e)}\n`);return EXIT_FAILURE;}}
