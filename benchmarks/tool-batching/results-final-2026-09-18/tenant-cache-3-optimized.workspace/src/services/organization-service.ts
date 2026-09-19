import type { Database } from '../db/database.ts';
import { membershipRepository } from '../db/membership-repository.ts';
import { requireMembership } from '../auth/membership.ts';
import { HttpError } from '../http/response.ts';
export function organizationService(db:Database){return {
  list(userId:string){return {items:membershipRepository(db).organizationsFor(userId)};},
  detail(userId:string,id:string){requireMembership(db,userId,id);const org=db.organizations.get(id);if(!org)throw new HttpError(404,'not_found');return {...org};},
};}
