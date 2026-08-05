import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthOptions, AuthResult, OAuthClientProvider } from "@modelcontextprotocol/client";
import { login, localWhoami, logout, type WhoamiResponse } from "../src/login.js";
import { readCredentials, writeCredentials } from "../src/credentials.js";

let home: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "hands-login-"));
  env = { HANDS_TEST_HOME: home };
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

const OK_WHOAMI: WhoamiResponse = {
  githubLogin: "octocat",
  tier: "free",
  cloudBooksUrl: "https://github.com/hands-dev/books",
  dashboardUrl: "/octocat/dashboard",
};

/** `state()` is optional + possibly-async on the interface; login()'s real provider always implements it sync, but tests go through the generic type. */
async function stateOf(provider: OAuthClientProvider): Promise<string> {
  return (await provider.state?.()) ?? "";
}

/**
 * A fake `auth()` that behaves like the SDK's real orchestrator closely
 * enough to drive login()'s own orchestration: first call (no
 * authorizationCode) calls provider.redirectToAuthorization and returns
 * REDIRECT; second call (with authorizationCode) calls provider.saveTokens
 * and returns AUTHORIZED — exactly the two-call shape login() expects.
 */
function twoCallAuthFn(opts?: { onFirstCall?: (provider: OAuthClientProvider) => void | Promise<void> }) {
  return vi.fn(async (provider: OAuthClientProvider, options: AuthOptions): Promise<AuthResult> => {
    if (!options.authorizationCode) {
      await opts?.onFirstCall?.(provider);
      provider.redirectToAuthorization(new URL("https://auth.example.com/authorize?state=s1"));
      return "REDIRECT";
    }
    provider.saveTokens({ access_token: "gho_at", refresh_token: "gho_rt", expires_in: 3600, token_type: "bearer" });
    return "AUTHORIZED";
  });
}

function baseDeps(overrides: Partial<Parameters<typeof login>[0]> = {}) {
  return {
    env,
    findPort: vi.fn().mockResolvedValue(51234),
    openUrl: vi.fn().mockResolvedValue(undefined),
    waitForCallback: vi.fn().mockResolvedValue(new URLSearchParams({ code: "auth-code-1", state: "state-placeholder" })),
    fetchWhoami: vi.fn().mockResolvedValue(OK_WHOAMI),
    out: vi.fn(),
    ...overrides,
  };
}

describe("login — happy path", () => {
  it("completes the full flow and persists credentials", async () => {
    let expectedState = "";
    const authFn = twoCallAuthFn({ onFirstCall: async (p) => { expectedState = await stateOf(p); } });
    const waitForCallback = vi.fn().mockImplementation(async () => new URLSearchParams({ code: "auth-code-1", state: expectedState }));
    const result = await login(baseDeps({ authFn, waitForCallback }));

    expect(result).toEqual({ ok: true, githubLogin: "octocat", tier: "free" });
    expect(readCredentials(env)).toMatchObject({
      accessToken: "gho_at",
      refreshToken: "gho_rt",
      githubLogin: "octocat",
      tier: "free",
      cloudBooksUrl: "https://github.com/hands-dev/books",
      dashboardUrl: "/octocat/dashboard",
    });
  });

  it("opens the browser to the authorization URL the provider was given", async () => {
    let expectedState = "";
    const authFn = twoCallAuthFn({ onFirstCall: async (p) => { expectedState = await stateOf(p); } });
    const waitForCallback = vi.fn().mockImplementation(async () => new URLSearchParams({ code: "c", state: expectedState }));
    const openUrl = vi.fn().mockResolvedValue(undefined);
    await login(baseDeps({ authFn, waitForCallback, openUrl }));
    expect(openUrl).toHaveBeenCalledWith("https://auth.example.com/authorize?state=s1");
  });
});

describe("login — error paths", () => {
  it("fails cleanly when the sign-in flow itself throws", async () => {
    const authFn = vi.fn().mockRejectedValue(new Error("network down"));
    const result = await login(baseDeps({ authFn }));
    expect(result).toEqual({ ok: false, reason: expect.stringContaining("network down") });
  });

  it("fails when REDIRECT is returned but no authorization URL was set", async () => {
    const authFn = vi.fn().mockResolvedValue("REDIRECT");
    const result = await login(baseDeps({ authFn }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("did not produce an authorization URL");
  });

  it("fails when the callback wait rejects", async () => {
    const authFn = twoCallAuthFn();
    const waitForCallback = vi.fn().mockRejectedValue(new Error("timed out"));
    const result = await login(baseDeps({ authFn, waitForCallback }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("timed out");
  });

  it("fails when the callback carries an error param", async () => {
    const authFn = twoCallAuthFn();
    const waitForCallback = vi.fn().mockResolvedValue(new URLSearchParams({ error: "access_denied" }));
    const result = await login(baseDeps({ authFn, waitForCallback }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("not authorized");
  });

  it("fails closed on a state mismatch (possible CSRF)", async () => {
    const authFn = twoCallAuthFn();
    const waitForCallback = vi.fn().mockResolvedValue(new URLSearchParams({ code: "c", state: "wrong-state" }));
    const result = await login(baseDeps({ authFn, waitForCallback }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("state mismatch");
  });

  it("fails when the callback has no code", async () => {
    let expectedState = "";
    const authFn = twoCallAuthFn({ onFirstCall: async (p) => { expectedState = await stateOf(p); } });
    const waitForCallback = vi.fn().mockImplementation(async () => new URLSearchParams({ state: expectedState }));
    const result = await login(baseDeps({ authFn, waitForCallback }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("authorization code");
  });

  it("fails when the token exchange (second auth() call) throws", async () => {
    let expectedState = "";
    let call = 0;
    const authFn = vi.fn(async (provider: OAuthClientProvider, _options: AuthOptions): Promise<AuthResult> => {
      call++;
      if (call === 1) {
        expectedState = await stateOf(provider);
        provider.redirectToAuthorization(new URL("https://auth.example.com/authorize"));
        return "REDIRECT";
      }
      throw new Error("invalid_grant");
    });
    const waitForCallback = vi.fn().mockImplementation(async () => new URLSearchParams({ code: "c", state: expectedState }));
    const result = await login(baseDeps({ authFn, waitForCallback }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("invalid_grant");
  });

  it("fails when auth() completes without ever saving tokens", async () => {
    let expectedState = "";
    let call = 0;
    const authFn = vi.fn(async (provider: OAuthClientProvider, _options: AuthOptions): Promise<AuthResult> => {
      call++;
      if (call === 1) {
        expectedState = await stateOf(provider);
        provider.redirectToAuthorization(new URL("https://auth.example.com/authorize"));
        return "REDIRECT";
      }
      return "AUTHORIZED"; // no provider.saveTokens() call — malformed but must not crash
    });
    const waitForCallback = vi.fn().mockImplementation(async () => new URLSearchParams({ code: "c", state: expectedState }));
    const result = await login(baseDeps({ authFn, waitForCallback }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("no tokens were issued");
  });

  it("fails when /api/whoami can't confirm identity, and does not write partial credentials", async () => {
    let expectedState = "";
    const authFn = twoCallAuthFn({ onFirstCall: async (p) => { expectedState = await stateOf(p); } });
    const waitForCallback = vi.fn().mockImplementation(async () => new URLSearchParams({ code: "c", state: expectedState }));
    const fetchWhoami = vi.fn().mockResolvedValue(null);
    const result = await login(baseDeps({ authFn, waitForCallback, fetchWhoami }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("/api/whoami");
    expect(readCredentials(env)).toBeNull();
  });
});

describe("logout", () => {
  it("clears an existing login", () => {
    writeCredentials(
      { accessToken: "a", expiresAt: 0, githubLogin: "octocat", tier: "free", cloudBooksUrl: null, dashboardUrl: null, updatedAt: 0 },
      env,
    );
    expect(logout(env)).toBe(true);
    expect(readCredentials(env)).toBeNull();
  });

  it("is a no-op (not an error) when already logged out", () => {
    expect(logout(env)).toBe(false);
  });
});

describe("localWhoami", () => {
  it("reports logged-out state with no network call", () => {
    expect(localWhoami(env)).toEqual({ loggedIn: false });
  });

  it("reports the cached identity/tier when logged in", () => {
    writeCredentials(
      { accessToken: "a", expiresAt: 0, githubLogin: "octocat", tier: "free", cloudBooksUrl: null, dashboardUrl: null, updatedAt: 0 },
      env,
    );
    expect(localWhoami(env)).toEqual({ loggedIn: true, githubLogin: "octocat", tier: "free" });
  });
});
