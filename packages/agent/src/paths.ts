import { homedir } from "node:os"
import { join } from "node:path"

// One knob decides where everything lives, so the laptop and a VPS differ by an
// environment variable rather than by code.

export const stateDir = process.env.BAZAAR_HOME?.trim() || join(homedir(), ".bazaaragent")

export const databasePath = join(stateDir, "bazaar.sqlite")
export const cacheDir = join(stateDir, "cache")
export const configPath = join(stateDir, "config.json")
