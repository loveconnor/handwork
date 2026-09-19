import type { Database } from './database.ts';
export function membershipRepository(db:Database) {
  const key=(userId:string,organizationId:string)=>JSON.stringify([userId,organizationId]);
  return {
    has(userId:string,organizationId:string){return db.memberships.has(key(userId,organizationId));},
    revoke(userId:string,organizationId:string){db.memberships.delete(key(userId,organizationId));},
    organizationsFor(userId:string){return [...db.organizations.values()].filter(o=>db.memberships.has(key(userId,o.id))).map(o=>({...o}));},
  };
}
