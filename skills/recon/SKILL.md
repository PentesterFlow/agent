---
name: recon
description: External recon playbook for a web target — subdomain enumeration, live-host probing, tech fingerprinting, and a first pass at content discovery. Use when the user gives you a root domain or apex and wants attack surface mapping.
allowed-tools:
  - shell
  - http
  - file_write
---

# Recon playbook

You have been asked to map the attack surface of a domain the user is authorized to test. Stay surgical — do not scan IP ranges or third-party assets.

Default to curl and the built-in `http` tool. Do not pull in specialized scanners (subfinder, httpx, ffuf, gobuster, etc.) unless the user explicitly asks for them.

## 1. Confirm scope
Before running anything, restate the apex domain and ask the user to confirm it is in scope (only ask if scope was not already explicit in the conversation). Note any explicit out-of-scope subdomains or paths.

## 2. Passive subdomain enumeration with curl
Pull from public CT logs — no extra tooling required. Note: `crt.sh` is flaky and frequently answers with a `502`/HTML page or an empty body instead of JSON. Piping that straight into `jq` is what throws `jq: parse error: Invalid numeric literal`. Validate the body is JSON before parsing, and retry with backoff:

```
# Robust crt.sh pull — only parses when the response is valid JSON.
for attempt in 1 2 3; do
  resp=$(curl -fsS --max-time 30 -H 'Accept: application/json' \
    "https://crt.sh/?q=%25.<APEX>&output=json" 2>/dev/null)
  if printf '%s' "$resp" | jq -e . >/dev/null 2>&1; then
    printf '%s' "$resp" \
      | jq -r '.[].name_value' \
      | sed 's/^\*\.//' \
      | tr 'A-Z' 'a-z' | tr -d '\r' \
      | sort -u > subs.txt
    break
  fi
  sleep 3   # crt.sh is rate-limited / returns 502 under load
done
[ -s subs.txt ] || echo "crt.sh returned no JSON (502/empty) — retry later or use another source"
```

`name_value` is newline-separated and may include wildcard (`*.`) entries; the `sed`/`sort -u` above normalizes and dedupes them. If `<APEX>` is pinned via `/target`, substitute the real apex.

For a second source, layer on AlienVault OTX (also guard the JSON):

```
otx=$(curl -fsS --max-time 30 "https://otx.alienvault.com/api/v1/indicators/domain/<APEX>/passive_dns" 2>/dev/null)
printf '%s' "$otx" | jq -e . >/dev/null 2>&1 \
  && printf '%s' "$otx" | jq -r '.passive_dns[].hostname' | sort -u >> subs.txt
sort -u -o subs.txt subs.txt
```

Save the deduped list with `file_write` to `recon/<apex>/subs.txt`.

Only reach for `subfinder` / `amass` / `assetfinder` if the user names them or the apex is large enough that crt.sh paging starts to drop results.

## 3. Liveness + tech fingerprinting with curl
For each candidate, send a single GET and capture status, title, and key headers. Tight bash loop:

```
while read h; do
  curl -ksS -o /tmp/body -w "%{http_code}\t%{url_effective}\t%header{server}\t%header{x-powered-by}\n" \
    --max-time 8 "https://$h/" 2>/dev/null \
    | awk -F'\t' -v host="$h" '{title=""; getline title < "/tmp/body"; sub(/.*<title>/,"",title); sub(/<\/title>.*/,"",title); print $0"\t"title}'
done < subs.txt > httpx.txt
```

If you need more than that (favicon hashing, full tech fingerprinting on hundreds of hosts), say so and ask the user whether to install/run `httpx`.

## 4. Content discovery with curl + a wordlist
For 2-3 hosts that look custom (admin panels, staging, dashboards), do a focused wordlist sweep with curl:

```
WORDLIST=/usr/share/seclists/Discovery/Web-Content/raft-small-words.txt
while read w; do
  code=$(curl -ksS -o /dev/null -w "%{http_code}" --max-time 5 "https://<HOST>/$w")
  case "$code" in 200|204|301|302|401|403) echo "$code /$w";; esac
done < "$WORDLIST" | tee ffuf-<host>.txt
```

Use `-w "%{http_code} %{size_download}\n"` if you also want to filter by body size. Pick a small wordlist first — escalate to medium only if the small one produces signal.

Only use `ffuf` or `gobuster` if the user explicitly asks for them.

## 5. Summarize
Write a `recon/<apex>/summary.md` with:
- Counts: total subdomains, live hosts, by tech stack
- Top 10 interesting hosts (with one-line reasons)
- Candidate next steps (auth flows to inspect, admin endpoints, exposed configs, JS files worth diffing)
