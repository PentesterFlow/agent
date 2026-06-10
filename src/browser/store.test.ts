import { describe, expect, it } from 'vitest';
import { CaptureStore } from './store.js';

describe('CaptureStore Burp bridge', () => {
  it('records Burp tasks and issues', () => {
    const store = new CaptureStore();
    const task = store.ingestBurpTask({
      action: 'scan',
      target: 'https://app.example.com/api/orders/1',
      method: 'GET',
      url: 'https://app.example.com/api/orders/1',
      host: 'app.example.com',
    });
    expect(task.ok).toBe(true);
    expect(store.listBurpTasks()[0]).toMatchObject({
      action: 'scan',
      target: 'https://app.example.com/api/orders/1',
    });

    const issue = store.ingestBurpIssue({
      id: 'finding:idor',
      title: 'IDOR on order lookup',
      severity: 'high',
      confidence: 'Certain',
      url: 'https://app.example.com/api/orders/1',
      detail: 'User B can read User A order.',
    });
    expect(issue.ok).toBe(true);
    expect(store.listBurpIssues()[0]).toMatchObject({
      id: 'finding:idor',
      title: 'IDOR on order lookup',
      severity: 'high',
    });
  });

  it('clears Burp bridge queues with capture state', () => {
    const store = new CaptureStore();
    store.ingestBurpTask({ action: 'plan', target: 'https://app.example.com' });
    store.ingestBurpIssue({
      title: 'Finding',
      url: 'https://app.example.com',
      detail: 'Evidence',
    });
    store.clear();
    expect(store.listBurpTasks()).toEqual([]);
    expect(store.listBurpIssues()).toEqual([]);
  });

  it('truncates large captured bodies before retaining them', () => {
    const store = new CaptureStore();
    store.ingest({
      url: 'https://app.example.com/api',
      method: 'GET',
      respBody: 'a'.repeat(100_000),
    });

    const body = store.listRequests()[0]?.responseBody ?? '';
    expect(body).toContain('truncated');
    expect(body.length).toBeLessThan(70_000);
  });
});
