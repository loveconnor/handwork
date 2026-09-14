import type { ListOptions } from '../types.ts';
export function projectListKey(organizationId:string,options:ListOptions):string {
  return `projects:list:${options.page}:${options.pageSize}:${options.sort}:${options.direction}`;
}
export function projectDetailKey(projectId:string):string { return `projects:detail:${projectId}`; }
