#!/usr/bin/env bun
import * as readline from "node:readline/promises";
import { randomUUID } from "node:crypto";
import { agentsPath, claimsPath, realOrphanProbeDeps, realRandomBytes, realResolveInputs, realTranscriptProbeDeps } from "../paths";
import { runCommand } from "../spawn";
import { runCli } from "./main";
import { spawnClaudeAttach } from "./attach";
import { createResidentAgentMessenger } from "@brooswit/drovr";

async function prompt(text:string):Promise<string>{const rl=readline.createInterface({input:process.stdin,output:process.stdout});try{return await rl.question(text);}finally{rl.close();}}
const common={agentsPath:agentsPath(),runCommand,now:Date.now,generateAttemptId:randomUUID,randomBytes:realRandomBytes,transcriptProbeDeps:realTranscriptProbeDeps};
runCli(process.argv.slice(2),{
  actions:common,
  adopt:{claimsPath:claimsPath(),agentsPath:agentsPath(),now:Date.now,resolveInputs:realResolveInputs,lexicalInputs:{cwd:process.cwd(),home:process.env.HOME ?? ""},probeDeps:realOrphanProbeDeps},
  claimsPath:claimsPath(),resolveInputs:realResolveInputs,probeDeps:realOrphanProbeDeps,cwd:process.cwd(),...(process.env.HOME === undefined ? {} : {home:process.env.HOME}),
  stdinIsTTY:process.stdin.isTTY===true,stdoutIsTTY:process.stdout.isTTY===true,
  stdout:s=>process.stdout.write(s),stderr:s=>process.stderr.write(s),prompt,spawnAttach:spawnClaudeAttach,messenger:createResidentAgentMessenger(),
  ...(process.env.CLAUDE_CODE_SESSION_ID ? {selfSessionId:process.env.CLAUDE_CODE_SESSION_ID} : {}),
}).then(code=>{process.exitCode=code;});
