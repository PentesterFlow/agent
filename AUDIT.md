# PentesterFlow — Code Audit / Bug Findings

> Internal review of correctness + security defects across all subsystems. Each finding was
> verified against source (and, where noted, reproduced at runtime). **Intentional pentest-tool
> behavior** (TLS-off HTTP, YOLO auto-approve, no redirect following, denylist as
> defense-in-depth not a boundary) is *excluded* — only unintended defects are listed.
>
> Scope note: most "gate" controls are **permission prompts**, not hard blocks. A "silent
> bypass" means the control fails to even *prompt* when it should — that's the real problem,
> since it defeats the intended human-in-the-loop checkpoint.

Severity legend: **HIGH** = security bypass / RCE primitive / crash / silent data loss ·
**MED** = correctness break, DoS, conditional bypass · **LOW** = cosmetic / edge / hardening.

---

## Capability-impact triage — "fix without limiting the operator"

PentesterFlow's mission is to help authorized pentesters/bug-hunters/security-engineers work
**without limits**. Every fix below is classified so none of them neuter that mission. Fix rules:

- **Gates remain prompts, never hard blocks.** `allow-once / allow-session / deny`, and **YOLO /
  `--dangerously-skip-permissions` always auto-approves.** Hitting internal IPs, cloud metadata,
  or reading target files stays fully possible.
- **The agent is never blinded to target data.** Redaction touches *only* what is persisted or
  sent to the cloud LLM (compaction, snapshots, learning JSONL). What the agent reads from a
  target is never scrubbed. Fixing redaction gaps stops the *operator's own* creds leaking — it
  does not hide the target's secrets from the agent.
- **The local sensitive-path gate guards the operator's own machine, not the target.** You don't
  pentest your own `~/.ssh`; making the gate catch `/ETC/SHADOW`/symlinks costs zero offensive
  capability and still prompts (and YOLO still bypasses).

| Class | Meaning | Findings |
|---|---|---|
| ✅ **Fix freely** | Pure reliability / anti-crash / anti-data-loss / stop operator's own secrets leaking. *Increases* mission effectiveness. | H1, H6, H7, H8, H9, H10, M4, M5, M6, M7, M8, M9, M10, M11, M12, M13, M14, L1–L8, L11–L15 |
| ⚠️ **Fix capability-preserving** | Make the *local-machine* gate actually catch what it claims — but keep it a **prompt with allow-session**, and YOLO still bypasses. No new friction on target work. | H3, H4, H5, M1, M2, M3 |
| 🟡 **Optional / keep permissive** | The SSRF rebinding gap. Reaching internal/metadata IPs is often the *goal*. Recommend **not** pinning IPs (that would break legitimate internal testing). At most, a **non-blocking notice** "resolved host is internal" — never a block. | H2 |
| ⛔ **Intentional — do NOT change** | Core "without limits" design. | TLS-off HTTP · YOLO mode · no redirect-following · denylist as soft defense-in-depth · scanners in `full` tooling profile · `requires_permission:false` plugin default · opt-in unredacted debug log (L9, operator's explicit choice) |

Net: of 39 findings, **33 are pure operator-benefit** (crashes, leaks of *your* secrets, OOM,
data loss, wrong output), **6 are capability-preserving gate hardening**, and the only
capability-sensitive one (H2) is best left permissive. **Nothing here adds limits to target work.**

---

## HIGH

### H1 — `grep -P` → `perl -ne` rewrite manufactures a Perl code-execution primitive
`src/tools/shell.ts:187-197` (pattern inlined into a `/.../` literal at `:193`)

The portability rewrite drops the user pattern straight into a Perl regex literal:
`print if /${perlPattern}/`. Perl regex literals interpolate `@{[...]}` / `${...}` and run
`(?{...})` code blocks. **Reproduced:**
`printf 'test\n' | perl -ne 'print if /@{[ \`echo PWNED >&2\` ]}/'` → prints `PWNED`.
So `grep -P '@{[ \`id\` ]}' file` becomes a command-execution shell-out that plain `grep`
would treat as inert data. The denylist won't catch it (no `rm`/`shutdown` token). The rewritten
`perl` form *is* shown in the permission modal, so it's not fully silent — but the rewrite
*creates* an exec primitive out of "just grepping" intent.
**Fix:** treat the pattern as data — pass via `@ARGV`/`\Q…\E` or `qr` without interpolation.

### H2 — SSRF gate is defeated by DNS rebinding (resolve-then-connect TOCTOU)
`src/tools/privateHost.ts:64-74` (gate resolves) vs `src/tools/http.ts:131`, `src/tools/web.ts:61` (connect)

The gate resolves the hostname to decide whether to prompt, then hands the **hostname string**
(not the vetted IP) to undici/fetch, which **re-resolves independently**. A short-TTL attacker
domain returns a public IP on the first lookup (→ no prompt) and `127.0.0.1` /
`169.254.169.254` on the connect lookup. Result: **silent SSRF to loopback/RFC1918/cloud
metadata with no prompt at all.** This is the single most serious gap.
**Fix:** resolve once in the gate and pin that IP for the connection (custom undici
`connect`/`lookup` that only allows the vetted address).

### H3 — Sensitive-path gate: case-insensitive bypass on macOS
`src/tools/sensitive.ts:42-56` (compares with `===`/`startsWith`, case-sensitive)

`isSensitivePath("/ETC/SUDOERS")` returns **false** while the file opens fine on default
case-insensitive APFS. So `file_read(path="/ETC/SHADOW")`, `~/.SSH/id_rsa`, `~/.AWS/credentials`
read **with no prompt**. Reproduced: `isSensitivePath("/ETC/SHADOW") === false`.
**Fix:** case-fold the comparison on case-insensitive filesystems.

### H4 — Sensitive-path gate: `/private/etc/...` realpath gap on macOS
`src/tools/sensitive.ts:9-14`, `src/tools/file.ts:50-51`

Denylist lists `/etc/...` but on macOS the canonical realpath is `/private/etc/...`. Only
`/private/etc/master.passwd` is listed; `shadow`/`sudoers` under `/private/etc` are not — and
the "check the realpath too" logic *defeats* the gate here because the canonical path itself
isn't denylisted. `file_read(path="/private/etc/sudoers")` reads ungated.
**Fix:** canonicalize denylist entries through realpath at load, or add `/private/etc/*`.

### H5 — `@file` mention inlining bypasses the gate via symlink (lexical-only check)
`src/agent/mentions.ts:38` (`isSensitivePath(resolved)` uses `resolve()`, never `realpath`)

Unlike `file.ts`, the mention path is checked lexically. A symlink under cwd
(`notes -> ~/.ssh/id_rsa`) plus a message containing `@notes` silently `readFileSync`s and
inlines the secret into the prompt — **no prompt at all**. (Combined with H3, a direct
`@/ETC/SUDOERS` also slips through.)
**Fix:** realpath before the sensitivity check, matching `file.ts`.

### H6 — Aborted turn persists a dangling assistant `tool_call`, breaking the session
`src/agent/agent.ts:584` (pushed + saved at `:586`, resumed at `:414`)

The assistant message carrying `toolCalls` is pushed and `save()`d **before** the tool loop
runs. Pressing **Esc** mid-loop throws `'aborted'`, so the matching `role:'tool'` results are
never appended — the invalid pair is written to disk. The next `run()` / `--resume` sends an
assistant `tool_calls` with no following tool message; OpenAI/Kimi pass it verbatim
(`src/llm/openai.ts:303-324`) → **hard 400**. Session is unusable until `/reset`. No
reconcile step exists on load or next-turn.
**Fix:** drop/repair a trailing assistant-with-tool_calls that has no results on save/load.

### H7 — Unclosed `<think>` erases the entire assistant message (silent data loss)
`src/agent/sanitize.ts:5,8`

`THINK_BLOCK_RE = /<think>[\s\S]*?(?:<\/think>|$)/gi` matches to end-of-string when there's no
close. Reproduced: `stripThinkingTags('<think>reasoning ... and the answer here')` → `""`.
A model that emits an unclosed `<think>` (truncation/streaming cutoff, or answer-inside-reasoning)
yields a blank turn; in compaction it throws "empty summary" → trips the circuit breaker (see M4).
**Fix:** only strip a `<think>…</think>` pair; if unclosed, strip the tag but keep trailing text.

### H8 — Plugin stdin write crashes the whole CLI on EPIPE
`src/tools/plugin.ts:128`

`child.stdin.write(JSON.stringify(args))` has no `'error'` listener. Large args (> ~64 KiB pipe
buffer) against a plugin that exits early raise an async `EPIPE` → promoted to
`uncaughtException` → **entire agent process dies**. Reproduced 5/5 with 5 MB stdin into a
fast-exiting child.
**Fix:** `child.stdin.on('error', …)` and guard the write.

### H9 — Redaction misses passwords in URL userinfo
`src/redact/redact.ts:11-38`

No pattern targets `scheme://user:pass@host`. Reproduced: `https://admin:Sup3rSecretPass@example.com`
passes through unchanged. These leak into `/compact` payloads sent to the LLM, snapshots,
findings, and the intelligence JSONL — exactly the trust boundary this module guards. Common in
curl repros, DB strings, git remotes.
**Fix:** add a `://user:pass@` userinfo pattern.

### H10 — Redaction misses 2-segment / unsigned JWTs
`src/redact/redact.ts:31`

The JWT pattern requires three segments. A 2-segment `alg:none` token or a header+payload prefix
logged before the signature (`eyJhbGci….eyJzdWIi…`) — which still contains the base64 claims
(subject, email) — passes unredacted. Reproduced.
**Fix:** match `eyJ…\.[A-Za-z0-9_-]+` with an optional third segment.

---

## MEDIUM

### M1 — `file.ts` gate TOCTOU vs the actual read/write (symlink race)
`src/tools/file.ts:50` (realpaths `abs`) vs `:99/:206/:215` (re-opens `abs`). The gate checks one
resolution and operates on another; a symlink swapped in between bypasses the "symlink-proof"
claim. **Fix:** open an fd once and fstat/read that fd.

### M2 — `read_payloads` / `read_skill_file` `../` containment defeated by a symlink in the skill dir
`src/tools/payloads.ts:103-110`, `src/tools/skillFile.ts:93-103`. A `payloads/evil -> /etc` symlink
plus `read_payloads(file="evil/passwd")` reads `/etc/passwd` (these tools don't prompt). The
lexical `..`/absolute checks are otherwise robust. **Fix:** realpath and re-check containment.

### M3 — `grep`/`glob` leak `/private/etc` (and case-variant) contents past the per-file gate
`src/tools/search.ts:131,182`. Same root cause as H3/H4: `GrepTool(path="/private/etc", glob="sudoers")`
streams file contents ungated. **Fix:** with H3/H4.

### M4 — Auto-compact circuit breaker never resets
`src/agent/agent.ts:741` (reset only on auto-compact success; absent in `compact()` `:456` and
`reset()` `:383`). After 3 failures the breaker trips and stays tripped for the whole process —
even after `/compact` succeeds or `/reset`. History then grows unbounded → eventual context 400
with no recovery. **Fix:** reset the counter on manual compact success and on reset.

### M5 — Auto-compact threshold checked before the user msg + `@mention` expansion
`src/agent/agent.ts:523-560`. `approxTokens()` runs at `:526` against history *without* the new
user message (`:546`) or expanded `@file` content (`:560`, up to 64 KB/mention). A turn just under
threshold + large attachments blows past the context window with no compaction → provider 400.
The `length/4` estimate also underestimates non-ASCII. **Fix:** estimate post-expansion.

### M6 — OpenAI streaming tool-call fallback fragments calls across chunks
`src/llm/openai.ts:239`. `fallbackIndex = parts.size` is recomputed per chunk, so a server that
omits `index` (some llama.cpp/vLLM/OpenRouter upstreams) lands fragments of one call in separate
map entries → split name/args → `JSON.parse` fails. **Fix:** track a stable fallback index across
chunks.

### M7 — Non-streaming path drops reasoning-model output when `content` is empty
`src/llm/openai.ts:155-172`. `chat()` reads only `message.content`; `deepseek-reasoner`-style
responses (answer in `reasoning_content`, empty `content`) yield a blank assistant turn in
non-streaming mode. Streaming handles it; non-streaming doesn't. **Fix:** fall back to
`reasoning_content` when content is empty.

### M8 — Gemini tool results use deprecated `role: 'function'`
`src/llm/gemini.ts:148-161`. `v1beta` `Content.role` accepts only `user`/`model`;
functionResponse parts should use `role: 'user'`. Newer Gemini models can 400 on multi-turn tool
use. **Fix:** emit `role: 'user'` for tool results.

### M9 — Capture store: unbounded `endpoints` Map + per-endpoint param Sets → OOM
`src/browser/store.ts:99,346-372`. `pruneIfNeeded` bounds only `requests`. Attacker-influenced
target traffic with unique paths/param names grows endpoint metadata without limit over a long
capture. **Fix:** LRU-cap `endpoints.size` and cap each param Set.

### M10 — MCP result fully buffered before the 128 KiB cap
`src/tools/mcp.ts:84,171`. A hostile/compromised MCP server returning multi-GB content is
materialized + `JSON.stringify`'d before truncation → OOM. The cap protects context, not the
process. **Fix:** bound the transport read.

### M11 — Terminal-escape injection from ingested data into the operator's TUI
`src/browser/server.ts:159,169-182` → `src/cli/index.ts:424` → `src/ui/Transcript.tsx:87,114`.
`eventText()` interpolates attacker-controlled `url`/`method`/`target`/Burp `action` into a
`kind:'system'` notice, which `system` rendering passes to Ink `<Text>` **without ANSI/control
stripping** (unlike the tool-call path). A captured URL with raw ESC sequences (OSC title-set,
cursor moves, hyperlinks) hits the pentester's terminal verbatim. **Fix:** scrub control bytes in
`eventText` (the repo already has a scrubber in `state.ts`).

### M12 — Findings store TOCTOU → one finding overwrites another
`src/findings/store.ts:38-50`. `uniqueFindingPath` uses `existsSync` then `save()` writes
separately; two same-slug saves can resolve to the same path and the second overwrites the first.
No atomic-rename (used elsewhere) here. **Path traversal via title is NOT exploitable** — slug is
`[a-z0-9-]+`. **Fix:** atomic create-exclusive.

### M13 — Intelligence JSONL: unbounded growth + concurrent-append dup race
`src/intelligence/store.ts:109-129,143-154`. No size/line cap (every compaction appends up to 25
scenarios, fully `readFileSync`-loaded on each op). Dedup is `title+category` only and two
concurrent callers can both pass the check. **JSONL injection is NOT possible** (`JSON.stringify`
escapes; text is redacted first). **Fix:** cap file size + serialize appends.

### M14 — Nested `<think>` leaks inner content + a stray `</think>`
`src/agent/sanitize.ts:5`. `stripThinkingTags('<think>a<think>b</think>visible</think>real')` →
`"visible</think>real"`. Non-greedy close + start-only dangling strip leaks reasoning and markup
for models that nest think blocks. **Fix:** balance nesting or strip all `</think>` occurrences.

---

## LOW / hardening

- **L1** `src/tools/shell.ts:191,197` — rewrite appends post-pattern grep flags (`-A3`,`--color`)
  as perl "filenames" → breaks legit commands; context flags unmodeled.
- **L2** `src/tools/shell.ts:82` — `GREP_P_RE` is textual; fires on `grep -P` inside `echo`/`awk`
  strings, corrupting output.
- **L3** `src/tools/file.ts:214` — `file_edit` single-occurrence path uses `String.replace`, which
  interprets `$&`/`$1`/`$$` in `new_string`; `replace_all` (split/join) does not. Silent corruption
  of PoCs/scripts containing literal `$&`. **Fix:** split/join in both branches.
- **L4** `src/tools/file.ts:101`, `src/agent/mentions.ts:66` — byte-cap truncation splits multibyte
  UTF-8 → trailing U+FFFD. Cosmetic.
- **L5** `src/llm/gemini.ts:71` — bare model id (no `models/` prefix) builds a 404 URL; picker
  normally supplies the prefix, so only manual config trips it.
- **L6** `src/redact/redact.ts` — no generic high-entropy fallback (unlabeled tokens/cookies in raw
  response bodies slip through); multiline/wrapped secrets only partially masked. (Inherent to
  label-anchored redaction.)
- **L7** `src/findings/httpRequest.ts:79-96,143-154` — curl `--data-urlencode` not encoded and
  `-d @file` emitted literally → malformed raw request / wrong Content-Length for Burp replay.
- **L8** `src/logger/logger.ts:54-63` — rotation only at `init()`; a long session grows unbounded
  mid-run, and `.log.1` is clobbered with no generational retention.
- **L9** `src/logger/sessionDebug.ts:26-48` — debug log writes raw tool I/O (HTTP bodies, args,
  stacks) **unredacted**. Opt-in + `0o600` + local, but asymmetric with every other path.
- **L10** `src/update/selfUpdate.ts:20,55-56` — `PENTESTERFLOW_REPO` is interpolated into a
  download-and-`sh` URL with **no checksum/signature** verification. Needs attacker-controlled env
  (already game-over) or CDN/MITM; hardening gap, not a remote vector.
- **L11** `src/tools/privateHost.ts:60` — `localhost.` (trailing dot) missed by the name check;
  only caught by the DNS fallback. **L12** `:91-107` — NAT64 (`64:ff9b::/96`) / 6to4 embedding of
  private/metadata v4 not flagged → silent reach in IPv6-only/NAT64 networks.
- **L13** `src/ui/permBridge.ts:34-35` — `sessionAllowed` cache is read *before* `noSessionCache`
  is consulted; not exploitable today (key spaces don't collide) but a latent bypass footgun.
- **L14** `src/tools/aliases.ts:43-64` — `KNOWN_TOOL_NAMES` lists `glob`/`grep`/`ask` but the real
  tool names are `GlobTool`/`GrepTool`/`ask_user` (and the canonical map omits them), so a skill
  declaring the *correct* runtime name fails validation. Asymmetric with shell/file tools.
- **L15** `src/ui/App.tsx:1443` — `/help` lists "Shift-Enter newline" (never implemented; real keys
  Ctrl-N/Ctrl-J) and omits Ctrl-F / Ctrl-A / Ctrl-E.

---

## Verified NOT bugs (so they aren't re-investigated)

Denylist bypasses via quoting/case/flag-reorder/`--`/newline (all caught) · cache-key collisions
(rewrite is deterministic; only semantically-equal commands share a key) · process-group
kill/timeout/abort (sound; minor: SIGTERM-only, no SIGKILL fallback) · IPv4 octal/hex/decimal/short
+ userinfo + IPv4-mapped-IPv6 SSRF encodings (all caught) · redirect-based SSRF (`redirect:'manual'`)
· `Authorization: Basic` + RSA/EC/OPENSSH private-key blocks (redacted) · ReDoS in redaction (all
linear, <3ms on 500k input) · prototype pollution via ingested JSON (fresh plain objects, no
recursive merge) · ingest `DELETE /clear` auth (gated) · empty/missing token compare (length-checked
+ `timingSafeEqual`) · ingest body cap before 4 MiB (enforced) · 0.0.0.0 bind (it's 127.0.0.1) ·
plugin command injection (`spawn` without `shell:true`) · streaming chunk-boundary reassembly
(correct) · `reasoning_content` re-injection (never accumulated) · Gemini `normalizeSchema`
stripping `required`/`enum` (it doesn't) · compaction dropping the system prompt or emitting orphan
tool results (it doesn't) · session save crash-safety (tmp+fsync+rename).

---

*Top priorities by real-world impact: **H2** (DNS-rebinding SSRF, silent), **H3/H4/H5** (sensitive
files read with no prompt on macOS), **H6** (abort corrupts the session), **H8** (plugin crashes
the CLI), **H9/H10** (the user's own secrets leak across the redaction boundary), **H1** (rewrite
builds an exec primitive).*
