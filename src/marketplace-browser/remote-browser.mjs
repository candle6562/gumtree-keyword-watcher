// Browser transport only. Site logic stays in marketplace.mjs.
export async function getContext(config) {
  const base = config.url.replace(/\/$/, '');
  const request = async (route, method = 'POST', body) => {
    const response = await fetch(base + route, {
      method,
      headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: config.signal || AbortSignal.timeout(120000),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(`windows-browser ${response.status}: ${data.error}`);
    return data;
  };
  return {
    async newPage() {
      const { id } = await request('/sessions');
      const route = `/sessions/${id}`;
      const target = (chain = []) => new Proxy({}, {
        get(_object, method) {
          if (method === 'then') return undefined;
          if (['locator', 'getByRole', 'getByText', 'first', 'nth'].includes(method)) {
            return (...args) => target([...chain, { method, args }]);
          }
          if (method === 'close') return async () => {
            // Cleanup must still work after the caller's deadline has expired.
            await fetch(base + route, { method: 'DELETE', headers: { authorization: `Bearer ${config.token}` }, signal: AbortSignal.timeout(10000) });
          };
          if (method === 'waitForTimeout') return (ms) => new Promise((resolve) => setTimeout(resolve, ms));
          return async (...args) => (await request(route + '/command', 'POST', { chain, method, args })).result;
        },
      });
      return target();
    },
  };
}
