import { describe, expect, test } from "bun:test";
import { parseArgv, TOP_LEVEL_WORDS } from "../../src/cli/grammar";
import { RESERVED_NAMES } from "../../src/agent-model";

describe("bakr CLI grammar", () => {
  const ok = (argv:string[]) => { const r=parseArgv(argv); expect(r.ok).toBe(true); return r.ok ? r.command : undefined; };
  test("every supported form", () => {
    expect(ok([])).toEqual({kind:"discover"});
    expect(ok(["list"])).toEqual({kind:"list",showArchived:false});
    expect(ok(["list","--archived"])).toEqual({kind:"list",showArchived:true});
    expect(ok(["create"])).toEqual({kind:"create"});
    expect(ok(["create","--name","alice"])).toEqual({kind:"create",name:"alice"});
    expect(ok(["adopt","@one","@two"])).toEqual({kind:"adopt",ids:["@one","@two"]});
    expect(ok(["alice"])).toEqual({kind:"attach",ref:"alice"});
    expect(ok(["on"])).toEqual({kind:"attach",ref:"on"});
    for(const verb of ["on","off","archive","unarchive"] as const) expect(ok(["alice",verb])).toEqual({kind:verb,ref:"alice"});
    expect(ok(["alice","delete"])).toEqual({kind:"delete",ref:"alice",yes:false});
    expect(ok(["alice","delete","--yes"])).toEqual({kind:"delete",ref:"alice",yes:true});
    expect(ok(["alice","name","new"])).toEqual({kind:"rename",ref:"alice",newName:"new"});
    expect(ok(["alice","rename","new"])).toEqual({kind:"rename",ref:"alice",newName:"new"});
    expect(ok(["alice","send","hello there"])).toEqual({kind:"send",ref:"alice",message:"hello there"});
    expect(ok(["--help"])).toEqual({kind:"help"});
  });
  test.each([
    [["--"],"unrecognized flag"], [["--wat"],"unrecognized flag"], [["help"],undefined],
    [["adopt"],"requires"], [["x","wat"],"unknown verb"], [["create","x"],"no positional"],
    [["list","x"],"no arguments"], [["create","--yes"],"not valid"], [["x","on","extra"],"no further"],
    [["x","name"],"requires"], [["x","send"],"exactly one message"], [["x","send","a","b"],"quote it"], [["--help","list"],"used alone"],
  ] as const)("usage edge %#", (argv,message) => { const r=parseArgv([...argv]); if(message===undefined){expect(r).toEqual({ok:true,command:{kind:"attach",ref:"help"}});}else{expect(r.ok).toBe(false);if(!r.ok)expect(r.message).toContain(message);} });
  test("MCP declarations: --mcp on create, and the mcp verb", () => {
    expect(ok(["create","--mcp","yappr:no-notify","--mcp","rocketr"])).toEqual({kind:"create",mcp:["yappr:no-notify","rocketr"]});
    expect(ok(["create","--name","rocketr","--mcp","rocketr+notify"])).toEqual({kind:"create",name:"rocketr",mcp:["rocketr+notify"]});
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

  test("status: a read-only host-wide report, --json or a human summary (BAKR-48)", () => {
    expect(ok(["status"])).toEqual({kind:"status",json:false});
    expect(ok(["status","--json"])).toEqual({kind:"status",json:true});
    // `status` is a top-level word, so it can no longer be an agent name (RESERVED_NAMES).
    for (const [argv, message] of [
      [["status","now"], '"status" takes no arguments'],
      [["status","--all"], '--all is not valid with "status"'],
      [["status","--archived"], '--archived is not valid with "status"'],
      [["status","--yes"], '--yes/-y is not valid with "status"'],
      [["status","--name","x"], '--name is not valid with "status"'],
      [["list","--json"], '--json is not valid with "list"'],
      [["alice","on","--json"], '--json is not valid with "on"'],
      [["--help","--json"], "used alone"],
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
      [["alice","permissions","--name","x"], '--name is not valid with "permissions"'],
      [["alice","permissions","--mcp","yappr"], '--mcp is not valid with "permissions"'],
      [["alice","permissions","--help"], "used alone"],
    ] as const) {
      const r = parseArgv([...argv]);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.message).toContain(message);
    }
  });

  test("approve: one promptId; once unless --always is typed; operator only when --as is typed", () => {
    expect(ok(["alice","approve","20d2c5b2f8308147"])).toEqual({kind:"approve",ref:"alice",promptId:"20d2c5b2f8308147",always:false});
    expect(ok(["@a1","approve","20d2c5b2f8308147","--always"])).toEqual({kind:"approve",ref:"@a1",promptId:"20d2c5b2f8308147",always:true});
    expect(ok(["alice","approve","20d2c5b2f8308147","--as","usrr:carol"])).toEqual({kind:"approve",ref:"alice",promptId:"20d2c5b2f8308147",always:false,operator:"usrr:carol"});
    expect(ok(["alice","--always","--as","carol","approve","abc"])).toEqual({kind:"approve",ref:"alice",promptId:"abc",always:true,operator:"carol"});
    expect(ok(["approve"])).toEqual({kind:"attach",ref:"approve"});
    for (const [argv, message] of [
      [["alice","approve"], '"approve" requires exactly one promptId'],
      [["alice","approve","a","b"], '"approve" requires exactly one promptId'],
      [["alice","approve","abc","--as"], "--as requires an operator name"],
      [["alice","approve","abc","--as","--always"], "--as requires an operator name"],
      [["alice","approve","abc","--as",""], "--as requires a non-empty operator name"],
      [["alice","approve","abc","--as","  "], "--as requires a non-empty operator name"],
      [["alice","approve","abc","--yes"], '--yes/-y is not valid with "approve"'],
      [["alice","approve","abc","--all"], '--all is not valid with "approve"'],
      [["alice","approve","abc","--archived"], '--archived is not valid with "approve"'],
      [["alice","approve","abc","--name","x"], '--name is not valid with "approve"'],
      [["alice","approve","abc","--mcp","yappr"], '--mcp is not valid with "approve"'],
      [["alice","approve","abc","--help"], "used alone"],
      [["alice","approve","abc","--auto"], 'unrecognized flag "--auto"'],
    ] as const) {
      const r = parseArgv([...argv]);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.message).toContain(message);
    }
  });

  test("--always and --as are refused on every verb but approve, and at the top level", () => {
    const others: string[][] = [
      [], ["list"], ["create"], ["adopt","@a1"], ["relaunch"], ["alice"], ["alice","on"], ["alice","off"], ["alice","archive"], ["alice","unarchive"],
      ["alice","delete"], ["alice","rename","bob"], ["alice","relaunch"], ["alice","permissions"], ["alice","mcp"], ["alice","send","hi"],
    ];
    for (const words of others) {
      for (const flag of [["--always"], ["--as","carol"]]) {
        const r = parseArgv([...words, ...flag]);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.message).toMatch(new RegExp(`^${flag[0]} is not valid with "`));
      }
    }
    expect(parseArgv(["--always","--help"]).ok).toBe(false);
    expect(parseArgv(["--as","carol","--help"]).ok).toBe(false);
  });

  test("C3: every top-level dispatch word is reserved by the model", () => {
    for (const word of TOP_LEVEL_WORDS) expect(RESERVED_NAMES).toContain(word);
  });
});
