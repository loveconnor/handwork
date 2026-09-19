import type { ListOptions } from '../types.ts';
import { HttpError } from './response.ts';
export function listOptions(query:Record<string,string>={}):ListOptions {
  const page=Number(query.page??1),pageSize=Number(query.pageSize??10),sort=query.sort??'name',direction=query.direction??'asc';
  if(!Number.isInteger(page)||page<1||!Number.isInteger(pageSize)||pageSize<1||pageSize>100||!['name','updatedAt'].includes(sort)||!['asc','desc'].includes(direction))throw new HttpError(400,'invalid_query');
  return {page,pageSize,sort:sort as ListOptions['sort'],direction:direction as ListOptions['direction']};
}
