import { runMarketplaceDetail, runMarketplaceSearch } from './marketplace.mjs';

/** Opt-in migration. Unchanged deployments still use the legacy site routes. */
export async function marketplaceRequest(url: string, init: RequestInit): Promise<Response> {
  const browserUrl = process.env.WINDOWS_BROWSER_URL;
  if (!browserUrl) return fetch(url, init);
  const headers = new Headers(init.headers);
  const config = {
    url: browserUrl,
    token: process.env.WINDOWS_BROWSER_TOKEN || (headers.get('authorization') || '').replace(/^Bearer /, ''),
    signal: init.signal ?? undefined,
  };
  const options = JSON.parse(String(init.body));
  const data = url.endsWith('/marketplace/detail')
    ? await runMarketplaceDetail(config, options)
    : await runMarketplaceSearch(config, options);
  return Response.json(data);
}
