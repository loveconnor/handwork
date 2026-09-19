import type { Project, Organization, User } from '../types.ts';
export type Seed = { projects: Project[]; organizations: Organization[]; users: User[]; memberships: {userId:string; organizationId:string}[]; sessions: Record<string,string> };
export function createDatabase(seed: Seed) {
  return {
    projects: new Map(seed.projects.map(p => [p.id, structuredClone(p)])),
    organizations: new Map(seed.organizations.map(o => [o.id, {...o}])),
    users: new Map(seed.users.map(u => [u.id, {...u}])),
    memberships: new Set(seed.memberships.map(m => JSON.stringify([m.userId,m.organizationId]))),
    sessions: new Map(Object.entries(seed.sessions)),
    counters: { projectReads: 0, projectLists: 0, projectUpdates: 0 },
  };
}
export type Database = ReturnType<typeof createDatabase>;
