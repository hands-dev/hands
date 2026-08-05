import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { spawn } from "node:child_process";
import {
  auth as sdkAuth,
  type AuthOptions,
  type AuthResult,
  type OAuthClientInformationMixed,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  type OAuthTokens,
} from "@modelcontextprotocol/client";
import { clearCredentials, readCredentials, writeCredentials, type HandsCredentials } from "./credentials.js";

/**
 * `hands login` — browser-handoff OAuth against the same Descope project the
 * hosted books MCP authenticates against (one identity spine, see the #26
 * plan §1). Deliberately reuses @modelcontextprotocol/client's exported
 * `auth()` orchestrator + `OAuthClientProvider` interface rather than
 * hand-rolling PKCE/discovery/token-exchange — the #26/#32 spike confirmed
 * `auth()` is a standalone function (an `OAuthClientProvider` + a resource
 * URL, no live MCP Transport/Client connection needed) modeled directly on
 * the SDK's own reference CLI example
 * (examples/cli-client/host/auth.ts in modelcontextprotocol/typescript-sdk).
 *
 * `serverUrl` is the hosted books MCP endpoint — not because this flow ever
 * calls an MCP tool, but because that's the resource whose RFC 9728
 * Protected Resource Metadata names Descope as the authorization server;
 * pointing at it is how this process discovers Descope's URLs without
 * hardcoding them here.
 */

export const DEFAULT_MCP_SERVER_URL = "https://hands-cc.dev/api/mcp";
export const DEFAULT_WHOAMI_URL = "https://hands-cc.dev/api/whoami";

function resolveServerUrl(env: NodeJS.ProcessEnv): string {
  return env.HANDS_LOGIN_SERVER_URL?.trim() || DEFAULT_MCP_SERVER_URL;
}

function resolveWhoamiUrl(env: NodeJS.ProcessEnv): string {
  return env.HANDS_LOGIN_WHOAMI_URL?.trim() || DEFAULT_WHOAMI_URL;
}

/**
 * In-memory OAuth provider for one `hands login` run — tokens only need to
 * live for the duration of the flow; the CLI persists them to
 * ~/.hands/credentials.json itself once `auth()` returns AUTHORIZED. Modeled
 * directly on the SDK's own CliOAuthClientProvider reference example: the
 * SDK drives the whole authorization-code + PKCE flow, this class only
 * supplies storage + the `state` value the host must verify on callback.
 */
export class HandsOAuthClientProvider implements OAuthClientProvider {
  private clientInfo?: OAuthClientInformationMixed;
  private oauthTokens?: OAuthTokens;
  private verifier?: string;
  private discovery?: OAuthDiscoveryState;
  private currentState?: string;
  pendingAuthorizationUrl?: URL;

  constructor(
    readonly redirectUrl: string,
    readonly clientMetadata: OAuthClientMetadata,
  ) {}

  state(): string {
    this.currentState ??= crypto.randomUUID();
    return this.currentState;
  }

  get expectedState(): string | undefined {
    return this.currentState;
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.clientInfo;
  }

  saveClientInformation(clientInformation: OAuthClientInformationMixed): void {
    this.clientInfo = clientInformation;
  }

  tokens(): OAuthTokens | undefined {
    return this.oauthTokens;
  }

  saveTokens(tokens: OAuthTokens): void {
    this.oauthTokens = tokens;
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    this.pendingAuthorizationUrl = authorizationUrl;
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.verifier = codeVerifier;
  }

  codeVerifier(): string {
    if (!this.verifier) throw new Error("No code verifier saved");
    return this.verifier;
  }

  saveDiscoveryState(state: OAuthDiscoveryState): void {
    this.discovery = state;
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.discovery;
  }

  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
    if (scope === "all" || scope === "client") this.clientInfo = undefined;
    if (scope === "all" || scope === "tokens") this.oauthTokens = undefined;
    if (scope === "all" || scope === "verifier") this.verifier = undefined;
    if (scope === "all" || scope === "discovery") this.discovery = undefined;
  }
}

function createProvider(callbackPort: number): HandsOAuthClientProvider {
  const callbackUrl = `http://127.0.0.1:${callbackPort}/callback`;
  return new HandsOAuthClientProvider(callbackUrl, {
    client_name: "hands CLI",
    redirect_uris: [callbackUrl],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    application_type: "native",
    token_endpoint_auth_method: "none",
  });
}

/** A free loopback port for the OAuth callback, picked by the OS. */
export async function findCallbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

/** Start a loopback HTTP server and resolve with the OAuth callback's query parameters. */
export function waitForOAuthCallback(port: number): Promise<URLSearchParams> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const requestUrl = new URL(req.url ?? "/", "http://localhost");
      if (requestUrl.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html><body><h1>Signed in</h1><p>You can close this window and return to the terminal.</p></body></html>");
      resolve(requestUrl.searchParams);
      setTimeout(() => server.close(), 1000);
    });
    server.on("error", reject);
    server.listen(port, "127.0.0.1");
  });
}

/** Best-effort browser open — same darwin-only `open` shellout `hands serve` already uses; the URL is always printed too, so this is a nicety, never the only path. */
async function defaultOpenUrl(url: string): Promise<void> {
  if (process.platform !== "darwin") return;
  try {
    spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
  } catch {
    // opening the browser automatically is a nicety, not a requirement
  }
}

export interface WhoamiResponse {
  githubLogin: string;
  tier: string;
  cloudBooksUrl: string | null;
  dashboardUrl: string | null;
}

function isWhoamiResponse(value: unknown): value is WhoamiResponse {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.githubLogin === "string" && typeof v.tier === "string";
}

async function defaultFetchWhoami(whoamiUrl: string, accessToken: string): Promise<WhoamiResponse | null> {
  try {
    const res = await fetch(whoamiUrl, { headers: { authorization: `Bearer ${accessToken}` } });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    return isWhoamiResponse(body) ? body : null;
  } catch {
    return null;
  }
}

export type LoginResult =
  | { ok: true; githubLogin: string; tier: string }
  | { ok: false; reason: string };

export interface LoginOptions {
  env?: NodeJS.ProcessEnv;
  /** overridable for tests, and for hosts that want their own browser handling instead of shelling out */
  openUrl?: (url: string) => Promise<void>;
  /** overridable for tests — the SDK's real auth() orchestrator by default */
  authFn?: (provider: OAuthClientProvider, options: AuthOptions) => Promise<AuthResult>;
  /** overridable for tests — the real /api/whoami fetch by default */
  fetchWhoami?: (whoamiUrl: string, accessToken: string) => Promise<WhoamiResponse | null>;
  /** overridable for tests so a real loopback server/port probe isn't required */
  waitForCallback?: (port: number) => Promise<URLSearchParams>;
  findPort?: () => Promise<number>;
  out?: (line: string) => void;
}

/**
 * Run the full browser-handoff login flow: discover Descope via the MCP
 * endpoint's protected-resource metadata, open the browser, catch the
 * loopback callback, exchange the code, confirm via /api/whoami, and
 * persist ~/.hands/credentials.json. Returns a result rather than throwing
 * — the CLI command turns `{ok:false}` into a normal `hands: <reason>` exit,
 * same convention as the rest of cli.ts.
 */
export async function login(options: LoginOptions = {}): Promise<LoginResult> {
  const env = options.env ?? process.env;
  const out = options.out ?? (() => {});
  const authFn = options.authFn ?? sdkAuth;
  const fetchWhoami = options.fetchWhoami ?? defaultFetchWhoami;
  const waitForCallback = options.waitForCallback ?? waitForOAuthCallback;
  const findPort = options.findPort ?? findCallbackPort;
  const openUrl = options.openUrl ?? defaultOpenUrl;

  const serverUrl = resolveServerUrl(env);
  const whoamiUrl = resolveWhoamiUrl(env);

  const port = await findPort();
  const provider = createProvider(port);

  let result: AuthResult;
  try {
    result = await authFn(provider, { serverUrl });
  } catch (err) {
    return { ok: false, reason: `could not start the sign-in flow: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (result === "REDIRECT") {
    const authorizationUrl = provider.pendingAuthorizationUrl;
    if (!authorizationUrl) {
      return { ok: false, reason: "the sign-in flow did not produce an authorization URL" };
    }
    out(`Opening your browser to sign in with GitHub…\n  ${authorizationUrl.toString()}`);
    const callback = waitForCallback(port);
    callback.catch(() => {});
    await openUrl(authorizationUrl.toString());

    let params: URLSearchParams;
    try {
      params = await callback;
    } catch (err) {
      return { ok: false, reason: `sign-in failed: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (params.get("error")) {
      return { ok: false, reason: "sign-in was not authorized" };
    }
    const expectedState = provider.expectedState;
    if (!expectedState || params.get("state") !== expectedState) {
      return { ok: false, reason: "sign-in rejected: state mismatch (possible CSRF) — please try again" };
    }
    const code = params.get("code");
    if (!code) {
      return { ok: false, reason: "sign-in did not return an authorization code" };
    }
    try {
      result = await authFn(provider, { serverUrl, authorizationCode: code, iss: params.get("iss") ?? undefined });
    } catch (err) {
      return { ok: false, reason: `could not complete the token exchange: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  if (result !== "AUTHORIZED") {
    return { ok: false, reason: `sign-in did not complete (unexpected result: ${result})` };
  }
  const tokens = provider.tokens();
  if (!tokens) {
    return { ok: false, reason: "signed in, but no tokens were issued" };
  }

  const whoami = await fetchWhoami(whoamiUrl, tokens.access_token);
  if (!whoami) {
    return { ok: false, reason: "signed in, but could not confirm your identity via /api/whoami" };
  }

  const now = Date.now();
  writeCredentials(
    {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: now + (tokens.expires_in ?? 3600) * 1000,
      githubLogin: whoami.githubLogin,
      tier: whoami.tier,
      cloudBooksUrl: whoami.cloudBooksUrl,
      dashboardUrl: whoami.dashboardUrl,
      updatedAt: now,
    },
    env,
  );

  return { ok: true, githubLogin: whoami.githubLogin, tier: whoami.tier };
}

/** `hands logout` — clears the local credential store. Never fails the CLI: there's nothing destructive left to do either way. */
export function logout(env: NodeJS.ProcessEnv = process.env): boolean {
  return clearCredentials(env);
}

export interface WhoamiStatus {
  loggedIn: boolean;
  githubLogin?: string;
  tier?: string;
}

/** The synchronous, local-only identity check `hands paths`/`hands whoami` use — never calls the network; a stale cached tier is corrected on the next `hands login`. */
export function localWhoami(env: NodeJS.ProcessEnv = process.env): WhoamiStatus {
  const creds = readCredentials(env);
  if (!creds) return { loggedIn: false };
  return { loggedIn: true, githubLogin: creds.githubLogin, tier: creds.tier };
}

export type { HandsCredentials };
