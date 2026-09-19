import type { Database } from '../db/database.ts';
import type { Cache } from '../cache/project-cache.ts';
import type { ListOptions } from '../types.ts';
import { projectRepository } from '../db/project-repository.ts';
import { requireMembership } from '../auth/membership.ts';
import { projectListKey, projectListPrefix, projectDetailKey } from '../cache/keys.ts';
import { HttpError } from '../http/response.ts';
export function projectService(db:Database,cache:Cache) {
  const projects=projectRepository(db);
  function detail(userId:string,projectId:string) {
    const project=projects.find(projectId);
    if(!project)throw new HttpError(404,'not_found');
    requireMembership(db,userId,project.organizationId);
    return project;
  }
  return {
    detail,
    list(userId:string,organizationId:string,options:ListOptions) {
      requireMembership(db,userId,organizationId);
      const key=projectListKey(organizationId,options);
      const cached=cache.get(key);
      if(cached!==undefined)return cached;
      const result=projects.list(organizationId,options);cache.set(key,result);return result;
    },
    update(userId:string,projectId:string,body:unknown) {
      detail(userId,projectId);
      if(!body||typeof body!=='object'||typeof (body as any).name!=='string'||!(body as any).name.trim())throw new HttpError(400,'invalid_body');
      const updated=projects.update(projectId,(body as any).name.trim())!;
      cache.delete(projectDetailKey(projectId));
      const prefix=projectListPrefix(updated.organizationId);
      for(const key of cache.keys())if(key.startsWith(prefix))cache.delete(key);
      return updated;
    },
  };
}
