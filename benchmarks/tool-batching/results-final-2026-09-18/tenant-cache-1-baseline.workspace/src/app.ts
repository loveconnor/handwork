import { createDatabase } from './db/database.ts';
import type { Seed } from './db/database.ts';
import { createCache } from './cache/project-cache.ts';
import type { Cache } from './cache/project-cache.ts';
import { createRouter } from './http/router.ts';
import { registerProjects } from './routes/projects.ts';
import { registerOrganizations } from './routes/organizations.ts';
import { registerAccount } from './routes/account.ts';
export function createApp(seed:Seed,cache:Cache=createCache()) {
  const db=createDatabase(seed),router=createRouter();
  registerProjects(router,db,cache);registerOrganizations(router,db);registerAccount(router,db);
  return {request:router.handle,db,cache};
}
