import type { Finding } from './store.js';

const CURL_DATA_FLAGS = new Set([
  '-d',
  '--data',
  '--data-raw',
  '--data-binary',
  '--data-urlencode',
  '--json',
  '--form',
  '-F',
]);

const CURL_SKIP_VALUE_FLAGS = new Set([
  '-A',
  '--user-agent',
  '--connect-timeout',
  '--max-time',
  '--retry',
  '--retry-delay',
  '--proxy',
  '-o',
  '--output',
  '-w',
  '--write-out',
]);

export function findingRequestForBurp(finding: Finding): string {
  const fromCurl = finding.curl ? httpRequestFromCurl(finding.curl, finding.method) : null;
  if (fromCurl) return fromCurl;
  return fallbackRequest(finding.url, finding.method);
}

export function httpRequestFromCurl(command: string, fallbackMethod?: string): string | null {
  const tokens = shellWords(command.replace(/\\\r?\n/g, ' '));
  if (tokens.length === 0) return null;
  const curlIdx = tokens.findIndex((t) => t === 'curl' || t.endsWith('/curl'));
  const args = curlIdx >= 0 ? tokens.slice(curlIdx + 1) : tokens;
  let method = fallbackMethod || '';
  let target = '';
  const bodyParts: string[] = [];
  const headers: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? '';
    if (arg === '-X' || arg === '--request') {
      method = args[++i] ?? method;
      continue;
    }
    if (arg.startsWith('--request=')) {
      method = arg.slice('--request='.length);
      continue;
    }
    if (arg.startsWith('-X') && arg.length > 2) {
      method = arg.slice(2);
      continue;
    }
    if (arg === '-H' || arg === '--header') {
      const header = args[++i];
      if (header) headers.push(header);
      continue;
    }
    if (arg.startsWith('-H') && arg.length > 2) {
      headers.push(arg.slice(2));
      continue;
    }
    if (arg.startsWith('--header=')) {
      headers.push(arg.slice('--header='.length));
      continue;
    }
    if (arg === '--url') {
      target = args[++i] ?? target;
      continue;
    }
    if (arg.startsWith('--url=')) {
      target = arg.slice('--url='.length);
      continue;
    }
    if (CURL_DATA_FLAGS.has(arg)) {
      const value = args[++i] ?? '';
      if (arg === '--json' && !hasHeader(headers, 'content-type')) {
        headers.push('Content-Type: application/json');
      }
      bodyParts.push(encodeCurlData(arg, value));
      if (!method) method = 'POST';
      continue;
    }
    const dataEq = dataFlagValue(arg);
    if (dataEq) {
      if (dataEq.flag === '--json' && !hasHeader(headers, 'content-type')) {
        headers.push('Content-Type: application/json');
      }
      bodyParts.push(encodeCurlData(dataEq.flag, dataEq.value));
      if (!method) method = 'POST';
      continue;
    }
    if (arg === '-b' || arg === '--cookie') {
      const cookie = args[++i];
      if (cookie && !hasHeader(headers, 'cookie')) headers.push(`Cookie: ${cookie}`);
      continue;
    }
    if (arg.startsWith('--cookie=')) {
      const cookie = arg.slice('--cookie='.length);
      if (cookie && !hasHeader(headers, 'cookie')) headers.push(`Cookie: ${cookie}`);
      continue;
    }
    if (arg === '-u' || arg === '--user') {
      const user = args[++i];
      if (user && !hasHeader(headers, 'authorization')) {
        headers.push(`Authorization: Basic ${Buffer.from(user, 'utf8').toString('base64')}`);
      }
      continue;
    }
    if (arg.startsWith('--user=')) {
      const user = arg.slice('--user='.length);
      if (user && !hasHeader(headers, 'authorization')) {
        headers.push(`Authorization: Basic ${Buffer.from(user, 'utf8').toString('base64')}`);
      }
      continue;
    }
    if (CURL_SKIP_VALUE_FLAGS.has(arg)) {
      i++;
      continue;
    }
    const userAgentEq = arg.startsWith('--user-agent=') ? arg.slice('--user-agent='.length) : '';
    if (userAgentEq && !hasHeader(headers, 'user-agent')) {
      headers.push(`User-Agent: ${userAgentEq}`);
      continue;
    }
    if (arg.startsWith('http://') || arg.startsWith('https://')) {
      target = arg;
    }
  }

  if (!target) return null;
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return null;
  }

  const body = bodyParts.join('&');
  const normalizedMethod = (method || (body ? 'POST' : 'GET')).toUpperCase();
  const path = `${url.pathname || '/'}${url.search}`;
  const out: string[] = [`${normalizedMethod} ${path} HTTP/1.1`];
  if (!hasHeader(headers, 'host')) out.push(`Host: ${url.host}`);
  for (const header of headers) {
    if (header.includes(':')) out.push(header);
  }
  if (!hasHeader(headers, 'user-agent')) out.push('User-Agent: PentesterFlow');
  if (body && !hasHeader(headers, 'content-length')) {
    out.push(`Content-Length: ${Buffer.byteLength(body, 'utf8')}`);
  }
  out.push('', body);
  return out.join('\r\n');
}

function fallbackRequest(rawUrl: string, method?: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return `${method || 'GET'} / HTTP/1.1\r\nHost: localhost\r\n\r\n`;
  }
  const path = `${url.pathname || '/'}${url.search}`;
  return `${method || 'GET'} ${path} HTTP/1.1\r\nHost: ${url.host}\r\nUser-Agent: PentesterFlow\r\n\r\n`;
}

function hasHeader(headers: string[], name: string): boolean {
  const prefix = `${name.toLowerCase()}:`;
  return headers.some((h) => h.toLowerCase().startsWith(prefix));
}

// Convert a curl data-flag value into the bytes that actually go on the wire,
// so the rendered raw request (and its Content-Length) is valid for Burp replay
// rather than carrying a literal, unencoded token (L7).
function encodeCurlData(flag: string, value: string): string {
  if (flag === '--data-urlencode') return encodeUrlencodeArg(value);
  // --data-raw is intentionally literal — curl does NOT expand a leading @.
  if (flag === '--data-raw') return value;
  // -d / --data / --data-binary: a leading @ reads the body from a file, which
  // we can't inline here. Emit a clear placeholder so Content-Length matches the
  // emitted body instead of counting the literal "@filename".
  if ((flag === '-d' || flag === '--data' || flag === '--data-binary') && value.startsWith('@')) {
    return `<contents of file ${value.slice(1)}>`;
  }
  return value;
}

// curl --data-urlencode forms: `content`, `=content`, `name=content`, `@file`,
// `name@file`. The content portion is percent-encoded; the name (if any) is not.
function encodeUrlencodeArg(value: string): string {
  if (value.startsWith('@')) return `<URL-encoded contents of file ${value.slice(1)}>`;
  const at = value.indexOf('@');
  const eq = value.indexOf('=');
  if (eq >= 0 && (at < 0 || eq < at)) {
    const name = value.slice(0, eq);
    const content = encodeURIComponent(value.slice(eq + 1));
    return name ? `${name}=${content}` : content;
  }
  if (at > 0) {
    return `${value.slice(0, at)}=<URL-encoded contents of file ${value.slice(at + 1)}>`;
  }
  return encodeURIComponent(value);
}

function dataFlagValue(arg: string): { flag: string; value: string } | null {
  for (const flag of CURL_DATA_FLAGS) {
    const prefix = `${flag}=`;
    if (arg.startsWith(prefix)) return { flag, value: arg.slice(prefix.length) };
  }
  if (arg.startsWith('-d') && arg.length > 2) return { flag: '-d', value: arg.slice(2) };
  if (arg.startsWith('-F') && arg.length > 2) return { flag: '-F', value: arg.slice(2) };
  return null;
}

function shellWords(input: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: "'" | '"' | '' = '';
  for (let i = 0; i < input.length; i++) {
    const ch = input[i] ?? '';
    if (quote === "'") {
      if (ch === "'") quote = '';
      else cur += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') {
        quote = '';
      } else if (ch === '\\' && i + 1 < input.length) {
        cur += input[++i] ?? '';
      } else {
        cur += ch;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur) {
        out.push(cur);
        cur = '';
      }
      continue;
    }
    if (ch === '\\' && i + 1 < input.length) {
      cur += input[++i] ?? '';
      continue;
    }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}
