import type { Router } from '../http/router.ts';
import type { Database } from '../db/database.ts';
import { requireSession } from '../auth/session.ts';
import { organizationService } from '../services/organization-service.ts';
import { ok } from '../http/response.ts';
export function registerOrganizations(router:Router,db:Database) {
  const service=organizationService(db);
  router.add('GET','/organizations',(req)=>ok(service.list(requireSession(db,req.token).id)));
  router.add('GET','/organizations/:organizationId',(req,p)=>ok(service.detail(requireSession(db,req.token).id,p.organizationId)));
}
