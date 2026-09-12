import { expect,test } from "bun:test";
import { attachInPlace } from "../../src/cli/attach";
import { confirmDelete } from "../../src/cli/confirm";
import { isAttachJobListed } from "../../src/cli/main";

test("attach refuses non-TTY without spawning and propagates child status on a PTY",async()=>{
  let calls=0;
  expect(await attachInPlace("short",{stdinIsTTY:false,stdoutIsTTY:true,spawn:async()=>{calls++;return 9;}})).toMatchObject({ok:false});
  expect(calls).toBe(0);
  expect(await attachInPlace("short",{stdinIsTTY:true,stdoutIsTTY:true,spawn:async id=>{expect(id).toBe("short");return 9;}})).toEqual({ok:true,exitCode:9});
});

test("delete confirmation matrix",async()=>{
  expect(await confirmDelete(true,"x",{stdinIsTTY:false,prompt:async()=>""})).toEqual({ok:true});
  expect(await confirmDelete(false,"x",{stdinIsTTY:false,prompt:async()=>{throw new Error("must not prompt");}})).toMatchObject({ok:false});
  expect(await confirmDelete(false,"x",{stdinIsTTY:true,prompt:async()=>"yes"})).toEqual({ok:true});
  expect(await confirmDelete(false,"x",{stdinIsTTY:true,prompt:async()=>"no"})).toMatchObject({ok:false});
});

test("attach presence gate matches the exact full job id, never cwd or short id",()=>{
  const sessions=[{sessionId:"full-one"},{sessionId:"full-sibling"}];
  expect(isAttachJobListed("full-one",sessions)).toBe(true);
  expect(isAttachJobListed("one",sessions)).toBe(false);
  expect(isAttachJobListed("absent",sessions)).toBe(false);
});
