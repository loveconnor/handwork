// Route provider requests through the host boundary for local HTTP fixtures.
export function routeProviderFetch(fetchImpl = globalThis.fetch, endpoint) {
  return (input, init) => fetchImpl(
    init?.method === "GET" ? new URL("/models", endpoint).href : endpoint,
    init,
  );
}
