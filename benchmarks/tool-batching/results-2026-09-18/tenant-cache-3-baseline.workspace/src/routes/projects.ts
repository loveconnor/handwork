import type { Router } from '../http/router.ts';
import type { Database } from '../db/database.ts';
import type { Cache } from '../cache/project-cache.ts';
import { requireSession } from '../auth/session.ts';
import { projectService } from '../services/project-service.ts';
import { listOptions } from '../http/list-options.ts';
import { ok } from '../http/response.ts';
export function registerProjects(router:Router,db:Database,cache:Cache) {
  const service=projectService(db,cache);
  router.add('GET','/projects/:projectId',(req,p)=>ok(service.detail(requireSession(db,req.token).id,p.projectId)));
  router.add('PATCH','/projects/:projectId',(req,p)=>ok(service.update(requireSession(db,req.token).id,p.projectId,req.body)));
  router.add('GET','/organizations/:organizationId/projects',(req,p)=>ok(service.list(requireSession(db,req.token).id,p.organizationId,listOptions(req.query))));
}
