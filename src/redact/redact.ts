// Credential redactor. Scrubs common secret shapes out of text before it
// crosses a trust boundary the user did not intend (the LLM during
// /compact, the markdown export during /export).
//
// L6 (AUDIT.md): no generic high-entropy fallback. We are intentionally
// label/shape-driven rather than "any 40+ char random string" because the
// latter produces too many false positives on normal pentest data (long
// IDs, hashes in responses, base64 bodies, etc.). We keep expanding the
// explicit patterns (see below) as a middle ground. See also the additional
// long-token pattern added for L6 mitigation.

// Each pattern captures the prefix in group 1 and the secret body in
// group 2 so the prefix (e.g. "Bearer ", "AKIA") stays intact while the
// body is masked.
const patterns: RegExp[] = [
  // Bearer token in Authorization header or freeform text.
  /(bearer\s+)([A-Za-z0-9._-]{16,})/gi,
  // Authorization: <scheme> <value> header line.
  /(authorization:\s*)(\S+\s+\S+)/gi,
  // AWS access key id.
  /\b(AKIA|ASIA)([0-9A-Z]{16})\b/g,
  // AWS secret access key adjacent to a key= marker.
  /(aws_secret_access_key\s*[:=]\s*["']?)([A-Za-z0-9/+=]{40})/gi,
  // GitHub personal / oauth / server tokens.
  /\b(gh[pousr]_)([A-Za-z0-9]{36,255})\b/g,
  // Stripe live / test keys.
  /\b(sk_(?:live|test)_)([A-Za-z0-9]{16,})\b/g,
  // OpenAI-style project and legacy keys.
  /\b(sk-)([A-Za-z0-9_-]{20,})\b/g,
  // Google API keys.
  /\b(AIza)([0-9A-Za-z_-]{35,})\b/g,
  // Slack tokens.
  /\b(xox[abprs]-)([A-Za-z0-9-]{10,})\b/g,
  // Password in URL userinfo: scheme://user:pass@host (any scheme — http(s),
  // postgres, mysql, redis, git remotes, etc.). The password body is captured
  // up to (but not including) the `@`, which a lookahead keeps in the string so
  // the rest of the URL survives. A port like host:8080/path won't match
  // because it isn't followed by `@` (H9).
  /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:)([^@\s/]+)(?=@)/gi,
  // JWTs: header.body, with an optional signature. A 2-segment / alg:none token
  // (or a header+payload prefix logged before the signature) still carries the
  // base64 claims, so we no longer require the third segment (H10).
  /\b(eyJ[A-Za-z0-9_-]{8,}\.)([A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]+)?)\b/g,
  // Generic api_key / secret / password / token = value assignment.
  /((?:api[_-]?key|secret|password|passwd|token)\s*[:=]\s*["']?)([A-Za-z0-9._\-+/=]{16,})/gi,
  // Credentials carried as URL/connection-string query parameters, e.g.
  // `mongodb+srv://h/db?authSource=admin&password=hunter2` or `?auth=...&token=...`.
  // The generic assignment above needs a 16+ char value; here we mask even a
  // short query-param secret since the `&`/`#`/whitespace delimiter bounds it (E25).
  /([?&](?:password|passwd|pwd|auth|token|api[_-]?key|access_token|secret)=)([^&#\s"']+)/gi,
  // HTTP Digest auth: the `response=` field is the credential-derived hash; the
  // 2-token Authorization pattern above only catches `Digest username=...`,
  // leaving the response/nonce exposed (E25).
  /(\bresponse=)("?[A-Fa-f0-9]{8,}"?)/g,
  // Conservative high-entropy fallback for L6 (AUDIT.md). Catches long
  // base64url-ish strings that look like bearer tokens / API keys in common
  // value positions. Length 32+ to avoid over-redacting short hashes/IDs in
  // normal responses. Still shape-ish (requires a key-like prefix nearby).
  /((?:api|auth|token|secret|key|cred)[^\s:=]{0,10}[:=]\s*["']?)([A-Za-z0-9/+=_-]{32,})/gi,
  // GCP service-account JSON: the private_key body is caught by the PEM block
  // below, but private_key_id (a key fingerprint) leaks separately (E25).
  /(["']?private_key_id["']?\s*[:=]\s*["']?)([A-Za-z0-9]{16,})/gi,
  // Cookie headers.
  /((?:set-)?cookie:\s*)([^\r\n]+)/gi,
  // Common API key headers.
  /((?:x-api-key|api-key|apikey):\s*)([^\r\n]+)/gi,
];

const privateKeyBlock =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;

/**
 * Scrubs known credential shapes from `s` and returns the redacted text.
 * Safe to call on empty strings; returns `s` unchanged when nothing matches.
 */
export function apply(s: string): string {
  if (!s) return s;

  // Private key blocks are replaced wholesale — preserving prefix doesn't
  // help and the body is unbounded.
  let out = s.replace(
    privateKeyBlock,
    '-----BEGIN PRIVATE KEY-----\n[REDACTED]\n-----END PRIVATE KEY-----',
  );

  for (const pattern of patterns) {
    out = out.replace(pattern, (_match, prefix: string, secret: string) => {
      return prefix + mask(secret);
    });
  }

  return out;
}

/**
 * Collapses a secret to a fixed redaction marker that hints at its
 * original length without revealing it. Keeps the first and last two
 * characters so log readers can still spot rotation churn without
 * recovering the secret itself.
 */
function mask(secret: string): string {
  if (secret.length <= 6) {
    return '[REDACTED]';
  }
  const head = secret.slice(0, 2);
  const tail = secret.slice(-2);
  // Length bucketed to nearest 4 so subtle differences don't leak.
  const bucket = Math.floor(secret.length / 4) * 4;
  const dots = '·'.repeat(bucket / 4);
  return `${head}…[REDACTED:${dots}]…${tail}`;
}
