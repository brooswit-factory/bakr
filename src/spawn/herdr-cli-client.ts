// A DrovrClient whose herdr calls travel over the herdr CLI, through the
// injected RunCommand — the one seam every other file in spawn/ uses.
//
// Why not the SDK's own socket: bakr's callers (agent-actions.ts, daemon.ts,
// the CLI) hand the spawn substrate a RunCommand and nothing else, and every
// test drives the real substrate through a fake RunCommand
// (test/support/fake-host.ts). A client that opened herdr's socket by itself
// would reach whatever herdr server runs on the machine the tests run on —
// the factory's own, on the laptop. Keeping the transport on RunCommand keeps
// that impossible and leaves those callers untouched (BAKR-37 §2).
//
// Only the methods drovr's resident host calls are carried; anything else is
// refused by name rather than guessed at. herdr's own refusals come back as
// the SDK's HerdrError with herdr's code, so drovr's checks on it
// (`agent_not_ready`, `agent_pane_busy`) see exactly what the socket would give.

import { DrovrClient, HerdrClient, HerdrError } from "@brooswit/drovr";
import type { RunCommand } from "./exec";

const HERDR_TIMEOUT_MS = 15_000;

type Params = Record<string, unknown>;

const str = (value: unknown): string => String(value);

/** herdr's CLI spells a read source with dashes where the API uses underscores (`recent_unwrapped`). */
const readSource = (source: unknown): string[] => source === undefined ? [] : ["--source", str(source).replace(/_/g, "-")];

const readOptions = (p: Params): string[] => [
  ...readSource(p["source"]),
  ...(p["lines"] === undefined ? [] : ["--lines", str(p["lines"])]),
  ...(p["strip_ansi"] === false ? ["--ansi"] : []),
];

/** The herdr CLI argv for one API method, or undefined for a method this transport does not carry. */
export function cliArgvFor(method: string, p: Params): string[] | undefined {
  switch (method) {
    case "agent.list": return ["herdr", "agent", "list"];
    case "agent.get": return ["herdr", "agent", "get", str(p["target"])];
    case "agent.read": return ["herdr", "agent", "read", str(p["target"]), ...readOptions(p)];
    case "agent.send_keys": return ["herdr", "agent", "send-keys", str(p["target"]), ...(p["keys"] as unknown[]).map(str)];
    case "agent.prompt": return ["herdr", "agent", "prompt", str(p["target"]), str(p["text"])];
    case "agent.start": return [
      "herdr", "agent", "start", str(p["name"]), "--kind", str(p["kind"]), "--pane", str(p["pane_id"]),
      ...(p["timeout_ms"] === undefined ? [] : ["--timeout", str(p["timeout_ms"])]),
      "--", ...((p["args"] as unknown[] | undefined) ?? []).map(str),
    ];
    case "pane.read": return ["herdr", "pane", "read", str(p["pane_id"]), ...readOptions(p)];
    case "pane.process_info": return ["herdr", "pane", "process-info", "--pane", str(p["pane_id"])];
    case "workspace.list": return ["herdr", "workspace", "list"];
    case "workspace.create": return [
      "herdr", "workspace", "create",
      ...(p["cwd"] === undefined ? [] : ["--cwd", str(p["cwd"])]),
      ...(p["label"] === undefined ? [] : ["--label", str(p["label"])]),
      ...Object.entries((p["env"] as Record<string, unknown> | undefined) ?? {}).flatMap(([key, value]) => ["--env", `${key}=${str(value)}`]),
      p["focus"] === true ? "--focus" : "--no-focus",
    ];
    case "workspace.close": return ["herdr", "workspace", "close", str(p["workspace_id"])];
    default: return undefined;
  }
}

/** A `read` prints the screen itself, not JSON (measured, herdr 0.8.2); only its refusal is JSON. */
const PRINTS_TEXT = new Set(["agent.read", "pane.read"]);

const refusal = (code: string, message: string, method: string): HerdrError => new HerdrError(code, message, method, { code, message });

/** Runs one API method over the herdr CLI and returns its result, or throws herdr's refusal as a HerdrError. */
export async function callOverCli(runCommand: RunCommand, method: string, params: unknown): Promise<unknown> {
  const p = (params ?? {}) as Params;
  const argv = cliArgvFor(method, p);
  if (argv === undefined) throw new Error(`herdr method ${method} is not carried over bakr's herdr CLI transport`);
  const timeoutMs = method === "agent.start" && typeof p["timeout_ms"] === "number" ? p["timeout_ms"] + HERDR_TIMEOUT_MS : HERDR_TIMEOUT_MS;
  const out = await runCommand(argv, { timeoutMs });
  const printed = out.stdout.trim() || out.stderr.trim();
  let parsed: { result?: unknown; error?: { code?: unknown; message?: unknown } } | undefined;
  try {
    parsed = JSON.parse(printed) as typeof parsed;
  } catch {
    parsed = undefined;
  }
  if (parsed?.error) throw refusal(str(parsed.error.code ?? "error"), str(parsed.error.message ?? "herdr reported an error"), method);
  if (out.exitCode !== 0) throw refusal(`exit-${out.exitCode}`, printed || "herdr exited non-zero", method);
  if (PRINTS_TEXT.has(method) && parsed?.result === undefined) {
    return { type: "pane_read", read: { text: out.stdout, pane_id: str(p["target"] ?? p["pane_id"]), format: "text", source: str(p["source"] ?? "recent"), truncated: false } };
  }
  if (parsed?.result && typeof parsed.result === "object") return parsed.result;
  throw refusal("unparseable", `herdr printed something that is not a result: ${JSON.stringify(printed.slice(0, 200))}`, method);
}

/**
 * A DrovrClient (drovr's corrections included) over the herdr CLI. The SDK's
 * own service classes still shape every call; only the wire step each one
 * ends in (`Service.call`) is redirected to `callOverCli`. Constructing it
 * opens nothing.
 */
export function drovrClientOverCli(runCommand: RunCommand): DrovrClient {
  const inner = new HerdrClient();
  const call = (method: string, params: unknown) => callOverCli(runCommand, method, params);
  for (const service of Object.values(inner)) {
    if (service && typeof service === "object" && typeof (service as { call?: unknown }).call === "function") {
      Object.defineProperty(service, "call", { value: call });
    }
  }
  Object.defineProperty(inner, "call", { value: call });
  return new DrovrClient({ herdr: inner });
}
