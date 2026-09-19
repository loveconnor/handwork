import { membershipRepository } from '../db/membership-repository.ts';
import type { Database } from '../db/database.ts';
import { HttpError } from '../http/response.ts';
export function requireMembership(db:Database,userId:string,organizationId:string) {
  if(!membershipRepository(db).has(userId,organizationId)) throw new HttpError(403,'forbidden');
}
