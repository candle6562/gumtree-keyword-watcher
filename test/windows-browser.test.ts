import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { loadConfig } from '../src/config.js';
import { marketplaceRequest } from '../src/marketplace-browser/request.js';
import { pickRadiusKm } from '../src/marketplace-browser/marketplace.mjs';

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('Windows Browser migration', () => {
  it('uses the Windows Browser health URL and its own startup task', () => {
    const config = loadConfig({
      POSTCODE: 'SW1A 1AA', WHATSAPP_TO: 'whatsapp:+447700900000',
      TWILIO_ACCOUNT_SID: 'ACxxx', TWILIO_AUTH_TOKEN: 'test',
      WINDOWS_BROWSER_URL: 'http://windows:3878', WINDOWS_BROWSER_TOKEN: 'new-token',
    });
    expect(config.browserWorkerUrl).toBe('http://windows:3878');
    expect(config.browserWorkerToken).toBe('new-token');
    expect(config.browserWorkerAutostartCommand).toBe('/mnt/c/Windows/System32/schtasks.exe /Run /TN WindowsBrowser');
    expect(config.browserWorkerAutostartEnabled).toBe(true);
  });
  it('keeps legacy callers unchanged until opted in', async () => {
    vi.stubEnv('WINDOWS_BROWSER_URL', '');
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ items: [] }));
    vi.stubGlobal('fetch', fetchMock);
    await marketplaceRequest('http://legacy/marketplace/search', { method: 'POST', body: '{}' });
    expect(fetchMock.mock.calls[0][0]).toBe('http://legacy/marketplace/search');
  });

  it('runs detail parsing in the app using generic browser commands and closes the session', async () => {
    vi.stubEnv('WINDOWS_BROWSER_URL', 'http://windows:3878');
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith('/sessions')) return Response.json({ id: 'test' });
      if (init.method === 'DELETE') return Response.json({ ok: true });
      const command = JSON.parse(String(init.body));
      if (command.method === 'evaluate' && command.args[0].includes('document.body.innerText')) {
        return Response.json({ result: { title: 'Van', images: ['photo'], attributes: {} } });
      }
      return Response.json({ result: null });
    });
    vi.stubGlobal('fetch', fetchMock);
    const response = await marketplaceRequest('http://legacy/marketplace/detail', {
      method: 'POST', headers: { authorization: 'Bearer test-token' },
      body: JSON.stringify({ url: 'https://www.facebook.com/marketplace/item/123/' }),
    });
    expect((await response.json()).title).toBe('Van');
    expect(fetchMock.mock.calls.every(([url]) => url.startsWith('http://windows:3878/sessions'))).toBe(true);
    expect(fetchMock.mock.calls.at(-1)?.[1].method).toBe('DELETE');
    const click = fetchMock.mock.calls.find(([, init]) => init.body && JSON.parse(String(init.body)).method === 'click');
    expect(JSON.parse(String(click?.[1].body)).chain).toEqual([
      { method: 'getByText', args: ['See more', { exact: true }] },
      { method: 'first', args: [] },
    ]);
  }, 10000);

  it('targets Change location rather than other dialogs when setting radius', async () => {
    vi.stubEnv('WINDOWS_BROWSER_URL', 'http://windows:3878');
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith('/sessions')) return Response.json({ id: 'test' });
      if (init.method === 'DELETE') return Response.json({ ok: true });
      const command = JSON.parse(String(init.body));
      if (command.method === 'getAttribute') return Response.json({ result: 'Location: within 40 km' });
      if (command.method === 'evaluate' && command.args[0].includes('excludedOutside')) {
        return Response.json({ result: { items: [{ url: 'https://www.facebook.com/marketplace/item/123/', title: 'Mower' }], sawMarker: false, total: 1, excludedOutside: 0 } });
      }
      return Response.json({ result: null });
    });
    vi.stubGlobal('fetch', fetchMock);
    const response = await marketplaceRequest('http://legacy/marketplace/search', {
      method: 'POST', body: JSON.stringify({ query: 'mower', maxResults: 1, radiusKm: 20 }),
    });
    expect((await response.json()).radius).toEqual({ changed: true, radiusKm: 20, previousKm: 40 });
    const wait = fetchMock.mock.calls.find(([, init]) => init.body && JSON.parse(String(init.body)).method === 'waitFor');
    expect(JSON.parse(String(wait?.[1].body)).chain).toEqual([
      { method: 'getByRole', args: ['dialog', { name: 'Change location', exact: true }] },
    ]);
  }, 10000);

  it('reports a missing login and closes the session', async () => {
    vi.stubEnv('WINDOWS_BROWSER_URL', 'http://windows:3878');
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith('/sessions')) return Response.json({ id: 'test' });
      if (init.method === 'DELETE') return Response.json({ ok: true });
      const command = JSON.parse(String(init.body));
      return Response.json({ result: command.method === 'evaluate' ? true : null });
    });
    vi.stubGlobal('fetch', fetchMock);
    await expect(marketplaceRequest('http://legacy/marketplace/search', {
      method: 'POST', body: JSON.stringify({ query: 'mower', maxResults: 5 }),
    })).rejects.toThrow('Facebook login required');
    expect(fetchMock.mock.calls.at(-1)?.[1].method).toBe('DELETE');
  });

  it('rounds radii and parses every embedded page script', () => {
    expect(pickRadiusKm(21)).toBe(40);
    expect(pickRadiusKm(100)).toBe(100);
    const source = readFileSync(new URL('../src/marketplace-browser/marketplace.mjs', import.meta.url), 'utf8');
    const scripts = [...source.matchAll(/const (?:HARVEST_VISIBLE|SCROLL_STEP|DETAIL_EXTRACT) = (`[\s\S]*?`);/g)];
    expect(scripts).toHaveLength(3);
    for (const [, literal] of scripts) {
      const script = new Function(`return ${literal}`)();
      expect(() => new Function(`return (${script})`)).not.toThrow();
    }
  });
});
