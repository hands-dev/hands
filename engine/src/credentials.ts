import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * `hands login`'s local credential store — `~/.hands/credentials.json`
 * (mode 0600, dir 0700), deliberately NOT under `~/.claude/` (that's
 * Claude-Code-plugin config namespace; a hands cloud account is product
 * identity, not IDE-plugin config — see the #26 plan §2). Machine-wide, not
 * per-repo (unlike coordinationDir), so `hands.config.json`'s
 * `HANDS_HOME`-per-repo override doesn't apply here; `HANDS_TEST_HOME`
 * mirrors config.ts's own userConfigPath test-isolation convention.
 *
 * File-based for the POC (mirrors how comparable CLIs — gh, vercel — started
 * too); OS-keychain hardening is a flagged fast-follow, not v1 (see the plan).
 */
export interface HandsCredentials {
  accessToken: string;
  refreshToken?: string;
  /** epoch ms; isExpired() compares against this */
  expiresAt: number;
  githubLogin: string;
  /** POC: hardcoded "free" by /api/whoami until real billing exists */
  tier: string;
  /** from /api/whoami — null when the login has no configured books repo mapping */
  cloudBooksUrl: string | null;
  /** from /api/whoami — the hosted dashboard path for this login */
  dashboardUrl: string | null;
  updatedAt: number;
}

export function credentialsPath(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.HANDS_TEST_HOME?.trim() || os.homedir();
  return path.join(home, ".hands", "credentials.json");
}

/** Returns null on any read/parse failure — "not logged in" and "corrupt file" are handled identically: re-run `hands login`. */
export function readCredentials(env: NodeJS.ProcessEnv = process.env): HandsCredentials | null {
  try {
    const raw = fs.readFileSync(credentialsPath(env), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return isHandsCredentials(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isHandsCredentials(value: unknown): value is HandsCredentials {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.accessToken === "string" &&
    typeof v.expiresAt === "number" &&
    typeof v.githubLogin === "string" &&
    typeof v.tier === "string"
  );
}

export function writeCredentials(creds: HandsCredentials, env: NodeJS.ProcessEnv = process.env): void {
  const file = credentialsPath(env);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(creds, null, 2)}\n`, { mode: 0o600 });
}

/** `hands logout` — returns true if a credentials file was actually removed, false if there was nothing to do. */
export function clearCredentials(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    fs.unlinkSync(credentialsPath(env));
    return true;
  } catch {
    return false;
  }
}

export function isExpired(creds: HandsCredentials, now: number = Date.now()): boolean {
  return now >= creds.expiresAt;
}
