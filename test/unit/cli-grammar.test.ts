import { describe, expect, test } from "bun:test";
import { parseArgv } from "../../src/cli/grammar";

describe("bakr CLI grammar", () => {
  const ok = (argv:string[]) => { const r=parseArgv(argv); expect(r.ok).toBe(true); return r.ok ? r.command : undefined; };
  test("every supported form", () => {
    expect(ok([])).toEqual({kind:"discover"});
    expect(ok(["list"])).toEqual({kind:"list",showArchived:false});
    expect(ok(["list","--archived"])).toEqual({kind:"list",showArchived:true});
    expect(ok(["create"])).toEqual({kind:"create"});
    expect(ok(["adopt","@one","@two"])).toEqual({kind:"adopt",ids:["@one","@two"]});
    expect(ok(["alice"])).toEqual({kind:"attach",ref:"alice"});
    expect(ok(["on"])).toEqual({kind:"attach",ref:"on"});
    for(const verb of ["on","off","archive","unarchive"] as const) expect(ok(["alice",verb])).toEqual({kind:verb,ref:"alice"});
    expect(ok(["alice","delete"])).toEqual({kind:"delete",ref:"alice",yes:false});
    expect(ok(["alice","delete","--yes"])).toEqual({kind:"delete",ref:"alice",yes:true});
    expect(ok(["alice","send","hello there"])).toEqual({kind:"send",ref:"alice",message:"hello there"});
    expect(ok(["--help"])).toEqual({kind:"help"});
  });
  // BAKR-34/BAKR-42 R9: `name`/`rename` and `--name` are retired — an
  // agent's name is derived from its directory now (R1/R3). Both are usage
  // errors, not dispatched commands.
  test("R9: name/rename and --name are retired as usage errors, not dispatched", () => {
    for (const argv of [["alice","name","new"], ["alice","rename","new"]]) {
      const r = parseArgv(argv);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.message).toContain("retired");
    }
    for (const argv of [["create","--name","alice"], ["alice","--name","x"]]) {
      const r = parseArgv(argv);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.message).toContain("--name is retired");
    }
  });
  test.each([
    [["--"],"unrecognized flag"], [["--wat"],"unrecognized flag"], [["help"],undefined],
    [["adopt"],"requires"], [["x","wat"],"unknown verb"], [["create","x"],"no positional"],
    [["list","x"],"no arguments"], [["create","--yes"],"not valid"], [["x","on","extra"],"no further"],
    [["x","send"],"exactly one message"], [["x","send","a","b"],"quote it"], [["--help","list"],"used alone"],
  ] as const)("usage edge %#", (argv,message) => { const r=parseArgv([...argv]); if(message===undefined){expect(r).toEqual({ok:true,command:{kind:"attach",ref:"help"}});}else{expect(r.ok).toBe(false);if(!r.ok)expect(r.message).toContain(message);} });
  test("MCP declarations: --mcp on create, and the mcp verb", () => {
    expect(ok(["create","--mcp","yappr:no-notify","--mcp","rocketr"])).toEqual({kind:"create",mcp:["yappr:no-notify","rocketr"]});
    expect(ok(["alice","mcp"])).toEqual({kind:"mcp",ref:"alice"});
    expect(ok(["alice","mcp","yappr+notify","rocketr"])).toEqual({kind:"mcp",ref:"alice",specs:["yappr+notify","rocketr"]});
    expect(ok(["alice","mcp","default"])).toEqual({kind:"mcp",ref:"alice",specs:["default"]});
    for (const [argv, message] of [
      [["create","--mcp"], "--mcp requires a server spec"],
      [["list","--mcp","yappr"], "--mcp is not valid"],
      [["alice","on","--mcp","yappr"], "--mcp is not valid"],
      [["alice","mcp","default","yappr"], "takes no server specs"],
    ] as const) {
      const r = parseArgv([...argv]);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.message).toContain(message);
    }
  });
  test("relaunch: one agent, or every agent on this host", () => {
    expect(ok(["rocketr","relaunch"])).toEqual({kind:"relaunch",ref:"rocketr"});
    expect(ok(["relaunch","--all"])).toEqual({kind:"relaunch-all"});
    for (const [argv, message] of [
      [["relaunch"], "takes only --all"],
      [["relaunch","rocketr"], "takes only --all"],
      [["rocketr","relaunch","now"], "takes no further arguments"],
      [["rocketr","on","--all"], "--all is not valid"],
      [["list","--all"], "--all is not valid"],
    ] as const) {
      const r = parseArgv([...argv]);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.message).toContain(message);
    }
  });

  test("permissions: one agent's pending prompts, no arguments, no flags", () => {
    expect(ok(["alice","permissions"])).toEqual({kind:"permissions",ref:"alice"});
    expect(ok(["@a1","permissions"])).toEqual({kind:"permissions",ref:"@a1"});
    expect(ok(["permissions"])).toEqual({kind:"attach",ref:"permissions"});
    for (const [argv, message] of [
      [["alice","permissions","extra"], '"permissions" takes no further arguments'],
      [["alice","permissions","--yes"], '--yes/-y is not valid with "permissions"'],
      [["alice","permissions","--all"], '--all is not valid with "permissions"'],
      [["alice","permissions","--archived"], '--archived is not valid with "permissions"'],
      [["alice","permissions","--name","x"], "--name is retired"],
      [["alice","permissions","--mcp","yappr"], '--mcp is not valid with "permissions"'],
      [["alice","permissions","--help"], "used alone"],
    ] as const) {
      const r = parseArgv([...argv]);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.message).toContain(message);
    }
  });
});
