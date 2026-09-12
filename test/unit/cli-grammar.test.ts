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
    expect(ok(["--help"])).toEqual({kind:"help"});
  });
  test.each([
    [["--"],"unrecognized flag"], [["--wat"],"unrecognized flag"], [["help"],undefined],
    [["adopt"],"requires"], [["x","wat"],"unknown verb"], [["create","x"],"no positional"],
    [["list","x"],"no arguments"], [["create","--yes"],"not valid"], [["x","on","extra"],"no further"],
    [["x","name"],"requires"], [["--help","list"],"used alone"],
  ] as const)("usage edge %#", (argv,message) => { const r=parseArgv([...argv]); if(message===undefined){expect(r).toEqual({ok:true,command:{kind:"attach",ref:"help"}});}else{expect(r.ok).toBe(false);if(!r.ok)expect(r.message).toContain(message);} });
  test("C3: every top-level dispatch word is reserved by the model", () => {
    for (const word of TOP_LEVEL_WORDS) expect(RESERVED_NAMES).toContain(word);
  });
});
