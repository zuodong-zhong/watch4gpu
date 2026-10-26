import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { ensureUserNamesFile } from "../lib/user-names-file.mjs";

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "watch4gpu-user-names-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const dataDirectory = pathToFileURL(`${directory}/`);
  writeFileSync(new URL("user-names.example.json", dataDirectory), "{}\n");
  return dataDirectory;
}

test("a fresh checkout gets an editable mapping and subsequent starts preserve edits", (t) => {
  const directory = fixture(t);
  const mappingFile = new URL("user-names.json", directory);
  ensureUserNamesFile(directory);
  assert.deepEqual(JSON.parse(readFileSync(mappingFile, "utf8")), {});

  const edited = '{\n  "alice": "Alice",\n  "alice_lab": "Alice"\n}\n';
  writeFileSync(mappingFile, edited);
  ensureUserNamesFile(directory);
  assert.equal(readFileSync(mappingFile, "utf8"), edited);
});

test("startup never resets an existing mapping even when it is mid-edit", (t) => {
  const directory = fixture(t);
  const mappingFile = new URL("user-names.json", directory);
  const unfinished = '{\n  "alice": ';
  writeFileSync(mappingFile, unfinished);
  ensureUserNamesFile(directory);
  assert.equal(readFileSync(mappingFile, "utf8"), unfinished);
});
