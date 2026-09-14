# Project-management API

Node 24 runs TypeScript directly. Run `npm test`; no third-party dependencies are needed.

`createApp(seed, cache?)` returns a synchronous `request({method,path,token?,query?,body?})` dispatcher plus the in-memory `db` and injected `cache`. The fixture uses no network, clock or database service. Database counters expose project reads, list queries and updates for instrumentation. Cache values are snapshots, not references into storage.

## API conventions

- Successful reads and updates return status 200 with the resource, or a list `{items,total,page,pageSize,sort,direction}`. Logout returns 204 with null.
- Missing/invalid sessions return 401 `{error:"unauthorized"}`.
- Authenticated nonmembers return 403 `{error:"forbidden"}` with no resource fields. Known project IDs use the project's actual owning organization, regardless of organization IDs supplied in query/body. Only `name` is editable; ownership cannot be reassigned.
- Missing projects return 404 `{error:"not_found"}`. Unknown routes also return 404.
- Invalid list options return 400 `{error:"invalid_query"}`; invalid project names return 400 `{error:"invalid_body"}`. Unexpected failures return 500 `{error:"internal_error"}`.

GET/PATCH `/projects/:projectId` require membership in the project's owning organization. GET `/organizations/:organizationId/projects` requires current membership, including on cache hits. GET `/organizations` lists the current user's organizations; GET `/organizations/:organizationId`, GET `/me`, DELETE `/session`, and GET `/health` also work.

## Lists and caching

Page and pageSize default to 1 and 10 (positive integers, size at most 100). Sort is name or updatedAt (default name); direction is asc or desc (default asc). Ties sort by ID in the same direction. The cache must keep organizations, pages, page sizes, sort fields and directions distinct. A successful project update invalidates every list variant for only the owning organization; unrelated cached lists must remain usable. Unauthorized requests must not mutate storage or cached entries. Revoked membership takes effect immediately. Caching must remain enabled, with repeated identical authorized lists avoiding another repository list query.

The injected cache interface is get/set/delete/keys; callers may supply an instrumented implementation. Organization IDs are opaque strings, so cache grouping must distinguish IDs that share prefixes or contain punctuation.
