import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_SETTINGS, parseRoutingSettings, type RoutingSettings } from "@tokenyard/gateway";
import { parse } from "yaml";

/**
 * Reads `config.yaml` from the data directory. With no file, routing stays off and traffic
 * simply passes through, exactly as before the file existed.
 */
export async function loadSettings(home: string): Promise<RoutingSettings> {
  const file = join(home, "config.yaml");
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return DEFAULT_SETTINGS;
    throw error;
  }
  try {
    return parseRoutingSettings(parse(text));
  } catch (error) {
    throw new Error(`${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
