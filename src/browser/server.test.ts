import { request } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { type IngestServerHandle, startIngestServer } from './server.js';
import { CaptureStore } from './store.js';

let handle: IngestServerHandle | null = null;

afterEach(async () => {
  await handle?.close();
  handle = null;
});

describe('browser ingest server', () => {
  it('requires the bridge token for reads and writes', async () => {
    const store = new CaptureStore();
    handle = await startIngestServer({ store, port: 0, token: 'secret-token' });
    const parsed = new URL(handle.url);
    const base = `${parsed.protocol}//${parsed.host}`;

    const unauth = await fetch(`${base}/status`);
    expect(unauth.status).toBe(401);

    const queryToken = await fetch(`${base}/status?token=secret-token`);
    expect(queryToken.status).toBe(401);

    const authedStatus = await fetch(`${base}/status`, {
      headers: { 'X-Pentesterflow-Token': 'secret-token' },
    });
    expect(authedStatus.status).toBe(200);

    const authedPost = await fetch(`${base}/ingest`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Pentesterflow-Token': 'secret-token',
      },
      body: JSON.stringify({ url: 'https://app.example.com/api', method: 'GET' }),
    });
    expect(authedPost.status).toBe(202);
    expect(store.status().requestCount).toBe(1);
  });

  it('rejects non-loopback Host headers', async () => {
    const store = new CaptureStore();
    handle = await startIngestServer({ store, port: 0, token: 'secret-token' });

    const status = await rawStatusRequest(handle.port, {
      Host: 'evil.example',
      'X-Pentesterflow-Token': 'secret-token',
    });

    expect(status).toBe(403);
  });
});

function rawStatusRequest(port: number, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path: '/status',
        method: 'GET',
        headers,
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      },
    );
    req.on('error', reject);
    req.end();
  });
}
