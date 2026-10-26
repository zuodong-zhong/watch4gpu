import { constants, copyFileSync } from "node:fs";

/** Create the editable local mapping on first run without replacing user data. */
export function ensureUserNamesFile(dataDirectory) {
  try {
    copyFileSync(
      new URL("user-names.example.json", dataDirectory),
      new URL("user-names.json", dataDirectory),
      constants.COPYFILE_EXCL,
    );
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
}
