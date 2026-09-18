import { describe, expect, test } from "bun:test";
import { takeDirOption } from "../../src/cli/dir-option";

describe("a leading --dir", () => {
  test("names the directory and leaves the rest of the command", () => {
    expect(takeDirOption(["--dir", "/home/op/code/brooswit", "brooswit", "off"])).toEqual({ dir: "/home/op/code/brooswit", rest: ["brooswit", "off"] });
  });

  test("absent, the command is untouched", () => {
    expect(takeDirOption(["brooswit", "off"])).toEqual({ rest: ["brooswit", "off"] });
  });

  test("is read only in the leading position, never from a message", () => {
    expect(takeDirOption(["rocketr", "send", "--dir", "/x"])).toEqual({ rest: ["rocketr", "send", "--dir", "/x"] });
  });

  test("without a directory is a usage error", () => {
    expect(takeDirOption(["--dir"])).toEqual({ error: "--dir needs a directory" });
    expect(takeDirOption(["--dir", ""])).toEqual({ error: "--dir needs a directory" });
  });
});
