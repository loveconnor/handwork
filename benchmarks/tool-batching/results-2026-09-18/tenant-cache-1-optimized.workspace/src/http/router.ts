import type { Request, Response } from '../types.ts';
import { failure, HttpError } from './response.ts';
export type Handler=(request:Request,params:Record<string,string>)=>Response;
export function createRouter() {
  const routes:{method:string;pattern:string[];handler:Handler}[]=[];
  return {
    add(method:string,path:string,handler:Handler){routes.push({method,pattern:path.split('/').filter(Boolean),handler});},
    handle(request:Request):Response {
      try {
        const path=request.path.split('/').filter(Boolean);
        for(const route of routes){
          if(route.method!==request.method || route.pattern.length!==path.length) continue;
          const params:Record<string,string>={};
          if(!route.pattern.every((part,i)=>part.startsWith(':') ? (params[part.slice(1)]=decodeURIComponent(path[i]),true) : part===path[i])) continue;
          return route.handler(request,params);
        }
        throw new HttpError(404,'not_found');
      } catch(error){return failure(error);}
    },
  };
}
export type Router=ReturnType<typeof createRouter>;
