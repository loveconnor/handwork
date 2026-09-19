import type { ListOptions } from '../types.ts';
export function projectListPrefix(organizationId:string):string { return `projects:list:${encodeURIComponent(organizationId)}:`; }
export function projectListKey(organizationId:string,options:ListOptions):string {
  return `${projectListPrefix(organizationId)}${options.page}:${options.pageSize}:${options.sort}:${options.direction}`;
}
export function projectDetailKey(projectId:string):string { return `projects:detail:${projectId}`; }
