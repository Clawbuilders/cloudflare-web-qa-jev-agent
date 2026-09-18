// Secret-shaped-string scrubber, applied to every piece of page text before
// it reaches an LLM or a public GitHub Issue. A crawled page's console
// errors or response bodies can accidentally contain a real credential
// (a misconfigured app logging its own API key, for instance); this never
// lets that reach a public Issue, no matter how the rest of the pipeline
// misbehaves.
const SECRET_PATTERNS: RegExp[] = [
  /AKIA[0-9A-Z]{16}/g, // AWS access key ID
  /gh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub tokens (ghp_/gho_/ghu_/ghs_/ghr_)
  /github_pat_[A-Za-z0-9_]{20,}/g, // GitHub fine-grained PAT
  /sk-[A-Za-z0-9]{20,}/g, // OpenAI / generic sk- style keys
  /sk_(live|test)_[A-Za-z0-9]{16,}/g, // Stripe secret keys
  /xox[baprs]-[A-Za-z0-9-]{10,}/g, // Slack tokens
  /AIza[0-9A-Za-z\-_]{20,}/g, // Google API keys
  /AC[a-f0-9]{32}/g, // Twilio account SID
  /SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g, // SendGrid keys
  /npm_[A-Za-z0-9]{30,}/g, // npm tokens
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, // PEM private keys
  /\b(?:api[_-]?key|secret|token|password|passwd|access[_-]?key)\s*[:=]\s*["']?[A-Za-z0-9\/+_=-]{8,}["']?/gi, // generic key=value
];

export function redact(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, "[REDACTED]");
  }
  return out;
}
