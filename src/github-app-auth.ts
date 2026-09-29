/**
 * Authenticate as a GitHub App instead of a static PAT — this Worker posts
 * exclusively as the App's bot identity, no personal token anywhere.
 * Self-contained (no npm deps): Cloudflare Workers support RS256 signing
 * natively via Web Crypto (`crypto.subtle`). Same approach as
 * cloudflare-code-reviewer's Advanced Track (`src/github-app-auth.ts`
 * there), minus the webhook-signature piece that repo needs and this one
 * doesn't — this Worker only ever calls out to GitHub, it never receives
 * GitHub webhooks, so there's no `installation.id` arriving on a payload.
 * `GITHUB_APP_INSTALLATION_ID` is set once as a secret instead (read it off
 * the "Install App" URL after installing on the target repo).
 */

export interface GitHubAppEnv {
  GITHUB_APP_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;
  GITHUB_APP_INSTALLATION_ID: string;
}

function base64UrlEncode(input: ArrayBuffer | string): string {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : new Uint8Array(input);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// GitHub Apps generate PKCS#1 keys ("BEGIN RSA PRIVATE KEY"). Web Crypto's
// importKey('pkcs8', ...) needs PKCS#8 ("BEGIN PRIVATE KEY"). Convert once,
// locally, before pasting the key into the GITHUB_APP_PRIVATE_KEY secret:
//   openssl pkcs8 -topk8 -nocrypt -in downloaded-key.pem -out pkcs8-key.pem
async function importPrivateKey(pem: string): Promise<CryptoKey> {
  if (pem.includes("BEGIN RSA PRIVATE KEY")) {
    throw new Error(
      'GITHUB_APP_PRIVATE_KEY is PKCS#1 ("BEGIN RSA PRIVATE KEY") — Web Crypto needs PKCS#8. ' +
        "Convert it first: openssl pkcs8 -topk8 -nocrypt -in downloaded-key.pem -out pkcs8-key.pem",
    );
  }
  const body = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  const der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
}

async function createAppJwt(appId: string, privateKeyPem: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  // Backdate iat by 60s to tolerate clock drift, per GitHub's own guidance.
  const payload = { iat: now - 60, exp: now + 600, iss: appId };
  const unsigned = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(JSON.stringify(payload))}`;
  const key = await importPrivateKey(privateKeyPem);
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  return `${unsigned}.${base64UrlEncode(signature)}`;
}

/** Exchange the App JWT for a short-lived (~1h) installation access token. */
async function getInstallationToken(appJwt: string, installationId: string): Promise<string> {
  const res = await fetch(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${appJwt}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "cloudflare-web-qa-jev-agent",
    },
  });
  if (!res.ok) {
    throw new Error(`Failed to mint installation token: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { token: string };
  return data.token;
}

/** Mints a fresh installation token for this call — there's no cross-call
 * cache here, since a single pipeline run makes only a handful of GitHub
 * calls (list issues, dedup, comment/create per finding), nowhere near
 * GitHub's rate limits, and a fresh token per call is simpler than reasoning
 * about the ~1h expiry mid-run. */
export async function getGitHubAppToken(env: GitHubAppEnv): Promise<string> {
  const jwt = await createAppJwt(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY);
  return getInstallationToken(jwt, env.GITHUB_APP_INSTALLATION_ID);
}
