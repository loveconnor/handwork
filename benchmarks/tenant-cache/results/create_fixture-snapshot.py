"""Create the public broken fixture after binaries are frozen."""
import json
from pathlib import Path
HERE=Path(__file__).resolve().parent
assert (HERE/'results/freeze.json').exists()
F=HERE/'fixture'
FILES={
'src/types.ts':'''export type Project = { id: string; organizationId: string; name: string; updatedAt: number };
export type Organization = { id: string; name: string };
export type User = { id: string; name: string };
export type ListOptions = { page: number; pageSize: number; sort: 'name' | 'updatedAt'; direction: 'asc' | 'desc' };
export type Request = { method: string; path: string; token?: string; query?: Record<string,string>; body?: unknown };
export type Response = { status: number; body: unknown };
''',
'src/db/database.ts':'''import type { Project, Organization, User } from '../types.ts';
export type Seed = { projects: Project[]; organizations: Organization[]; users: User[]; memberships: {userId:string; organizationId:string}[]; sessions: Record<string,string> };
export function createDatabase(seed: Seed) {
  return {
    projects: new Map(seed.projects.map(p => [p.id, structuredClone(p)])),
    organizations: new Map(seed.organizations.map(o => [o.id, {...o}])),
    users: new Map(seed.users.map(u => [u.id, {...u}])),
    memberships: new Set(seed.memberships.map(m => JSON.stringify([m.userId,m.organizationId]))),
    sessions: new Map(Object.entries(seed.sessions)),
    counters: { projectReads: 0, projectLists: 0, projectUpdates: 0 },
  };
}
export type Database = ReturnType<typeof createDatabase>;
''',
'src/db/project-repository.ts':'''import type { Database } from './database.ts';
import type { ListOptions } from '../types.ts';
export function projectRepository(db: Database) {
  return {
    find(id: string) { db.counters.projectReads++; const p=db.projects.get(id); return p ? {...p} : undefined; },
    list(organizationId: string, options: ListOptions) {
      db.counters.projectLists++;
      const rows=[...db.projects.values()].filter(p=>p.organizationId===organizationId);
      rows.sort((a,b)=> {
        const primary=options.sort==='name' ? a.name.localeCompare(b.name) : a.updatedAt-b.updatedAt;
        return (primary || a.id.localeCompare(b.id)) * (options.direction==='asc' ? 1 : -1);
      });
      const start=(options.page-1)*options.pageSize;
      return { items: rows.slice(start,start+options.pageSize).map(p=>({...p})), total: rows.length, ...options };
    },
    update(id:string, name:string) {
      db.counters.projectUpdates++;
      const p=db.projects.get(id); if(!p) return undefined;
      const updated={...p,name,updatedAt:p.updatedAt+1}; db.projects.set(id,updated); return {...updated};
    },
  };
}
''',
'src/db/membership-repository.ts':'''import type { Database } from './database.ts';
export function membershipRepository(db:Database) {
  const key=(userId:string,organizationId:string)=>JSON.stringify([userId,organizationId]);
  return {
    has(userId:string,organizationId:string){return db.memberships.has(key(userId,organizationId));},
    revoke(userId:string,organizationId:string){db.memberships.delete(key(userId,organizationId));},
    organizationsFor(userId:string){return [...db.organizations.values()].filter(o=>db.memberships.has(key(userId,o.id))).map(o=>({...o}));},
  };
}
''',
'src/auth/session.ts':'''import type { Database } from '../db/database.ts';
import { HttpError } from '../http/response.ts';
export function requireSession(db:Database,token?:string) {
  const id=token ? db.sessions.get(token) : undefined;
  const user=id ? db.users.get(id) : undefined;
  if(!user) throw new HttpError(401,'unauthorized');
  return {...user};
}
''',
'src/auth/membership.ts':'''import { membershipRepository } from '../db/membership-repository.ts';
import type { Database } from '../db/database.ts';
import { HttpError } from '../http/response.ts';
export function requireMembership(db:Database,userId:string,organizationId:string) {
  if(!membershipRepository(db).has(userId,organizationId)) throw new HttpError(403,'forbidden');
}
''',
'src/cache/keys.ts':'''import type { ListOptions } from '../types.ts';
export function projectListKey(organizationId:string,options:ListOptions):string {
  return `projects:list:${options.page}:${options.pageSize}:${options.sort}:${options.direction}`;
}
export function projectDetailKey(projectId:string):string { return `projects:detail:${projectId}`; }
''',
'src/cache/project-cache.ts':'''export interface Cache {
  get(key:string): unknown;
  set(key:string,value:unknown): void;
  delete(key:string): void;
  keys(): string[];
}
export function createCache() {
  const entries=new Map<string,unknown>();
  const metrics={hits:0,misses:0,writes:0,deletes:0};
  return {
    metrics,
    get(key:string){if(entries.has(key)){metrics.hits++;return structuredClone(entries.get(key));}metrics.misses++;return undefined;},
    set(key:string,value:unknown){metrics.writes++;entries.set(key,structuredClone(value));},
    delete(key:string){metrics.deletes++;entries.delete(key);},
    keys(){return [...entries.keys()];},
  };
}
''',
'src/http/response.ts':'''import type { Response } from '../types.ts';
export class HttpError extends Error {
  status:number;
  constructor(status:number,message:string){super(message);this.status=status;}
}
export function ok(body:unknown):Response{return {status:200,body};}
export function failure(error:unknown):Response {
  return error instanceof HttpError ? {status:error.status,body:{error:error.message}} : {status:500,body:{error:'internal_error'}};
}
''',
'src/http/router.ts':'''import type { Request, Response } from '../types.ts';
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
''',
'src/http/list-options.ts':'''import type { ListOptions } from '../types.ts';
import { HttpError } from './response.ts';
export function listOptions(query:Record<string,string>={}):ListOptions {
  const page=Number(query.page??1),pageSize=Number(query.pageSize??10),sort=query.sort??'name',direction=query.direction??'asc';
  if(!Number.isInteger(page)||page<1||!Number.isInteger(pageSize)||pageSize<1||pageSize>100||!['name','updatedAt'].includes(sort)||!['asc','desc'].includes(direction))throw new HttpError(400,'invalid_query');
  return {page,pageSize,sort:sort as ListOptions['sort'],direction:direction as ListOptions['direction']};
}
''',
'src/services/project-service.ts':'''import type { Database } from '../db/database.ts';
import type { Cache } from '../cache/project-cache.ts';
import type { ListOptions } from '../types.ts';
import { projectRepository } from '../db/project-repository.ts';
import { requireMembership } from '../auth/membership.ts';
import { projectListKey, projectDetailKey } from '../cache/keys.ts';
import { HttpError } from '../http/response.ts';
export function projectService(db:Database,cache:Cache) {
  const projects=projectRepository(db);
  function detail(userId:string,projectId:string) {
    const project=projects.find(projectId);
    if(!project)throw new HttpError(404,'not_found');
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
      return updated;
    },
  };
}
''',
'src/services/organization-service.ts':'''import type { Database } from '../db/database.ts';
import { membershipRepository } from '../db/membership-repository.ts';
import { requireMembership } from '../auth/membership.ts';
import { HttpError } from '../http/response.ts';
export function organizationService(db:Database){return {
  list(userId:string){return {items:membershipRepository(db).organizationsFor(userId)};},
  detail(userId:string,id:string){requireMembership(db,userId,id);const org=db.organizations.get(id);if(!org)throw new HttpError(404,'not_found');return {...org};},
};}
''',
'src/routes/projects.ts':'''import type { Router } from '../http/router.ts';
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
''',
'src/routes/organizations.ts':'''import type { Router } from '../http/router.ts';
import type { Database } from '../db/database.ts';
import { requireSession } from '../auth/session.ts';
import { organizationService } from '../services/organization-service.ts';
import { ok } from '../http/response.ts';
export function registerOrganizations(router:Router,db:Database) {
  const service=organizationService(db);
  router.add('GET','/organizations',(req)=>ok(service.list(requireSession(db,req.token).id)));
  router.add('GET','/organizations/:organizationId',(req,p)=>ok(service.detail(requireSession(db,req.token).id,p.organizationId)));
}
''',
'src/routes/account.ts':'''import type { Router } from '../http/router.ts';
import type { Database } from '../db/database.ts';
import { requireSession } from '../auth/session.ts';
import { ok } from '../http/response.ts';
export function registerAccount(router:Router,db:Database) {
  router.add('GET','/health',()=>ok({status:'ok'}));
  router.add('GET','/me',req=>ok(requireSession(db,req.token)));
  router.add('DELETE','/session',req=>{requireSession(db,req.token);db.sessions.delete(req.token!);return {status:204,body:null};});
}
''',
'src/app.ts':'''import { createDatabase } from './db/database.ts';
import type { Seed } from './db/database.ts';
import { createCache } from './cache/project-cache.ts';
import type { Cache } from './cache/project-cache.ts';
import { createRouter } from './http/router.ts';
import { registerProjects } from './routes/projects.ts';
import { registerOrganizations } from './routes/organizations.ts';
import { registerAccount } from './routes/account.ts';
export function createApp(seed:Seed,cache:Cache=createCache()) {
  const db=createDatabase(seed),router=createRouter();
  registerProjects(router,db,cache);registerOrganizations(router,db);registerAccount(router,db);
  return {request:router.handle,db,cache};
}
''',
'src/seed.ts':'''import type { Seed } from './db/database.ts';
export function sampleSeed():Seed {return {
  users:[{id:'alice',name:'Alice'},{id:'bob',name:'Bob'},{id:'both',name:'Both'}],
  organizations:[{id:'org-a',name:'A'},{id:'org-b',name:'B'}],
  memberships:[{userId:'alice',organizationId:'org-a'},{userId:'bob',organizationId:'org-b'},{userId:'both',organizationId:'org-a'},{userId:'both',organizationId:'org-b'}],
  sessions:{alice:'alice',bob:'bob',both:'both'},
  projects:[{id:'a1',organizationId:'org-a',name:'Alpha',updatedAt:3},{id:'a2',organizationId:'org-a',name:'Delta',updatedAt:1},{id:'a3',organizationId:'org-a',name:'Gamma',updatedAt:2},{id:'b1',organizationId:'org-b',name:'Beta',updatedAt:7},{id:'b2',organizationId:'org-b',name:'Echo',updatedAt:5},{id:'b3',organizationId:'org-b',name:'Foxtrot',updatedAt:6}],
};}
''',
 'tests/projects.test.ts':'''import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.ts';
import { sampleSeed } from '../src/seed.ts';
test('authenticated detail',()=>{const a=createApp(sampleSeed());assert.equal(a.request({method:'GET',path:'/projects/a1',token:'alice'}).status,200);});
test('authenticated list',()=>{const a=createApp(sampleSeed());const r=a.request({method:'GET',path:'/organizations/org-a/projects',token:'alice'});assert.equal(r.status,200);assert.equal((r.body as any).items.length,3);});
test('update then read',()=>{const a=createApp(sampleSeed());assert.equal(a.request({method:'PATCH',path:'/projects/a1',token:'alice',body:{name:'New'}}).status,200);assert.equal((a.request({method:'GET',path:'/projects/a1',token:'alice'}).body as any).name,'New');});
test('anonymous request rejected',()=>{const a=createApp(sampleSeed());assert.deepEqual(a.request({method:'GET',path:'/projects/a1'}),{status:401,body:{error:'unauthorized'}});});
test('invalid update rejected',()=>{const a=createApp(sampleSeed());assert.equal(a.request({method:'PATCH',path:'/projects/a1',token:'alice',body:{name:''}}).status,400);});
''',
 'tests/account.test.ts':'''import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.ts';
import { sampleSeed } from '../src/seed.ts';
test('health and profile',()=>{const a=createApp(sampleSeed());assert.deepEqual(a.request({method:'GET',path:'/health'}).body,{status:'ok'});assert.equal((a.request({method:'GET',path:'/me',token:'alice'}).body as any).id,'alice');});
test('organizations scoped to user',()=>{const a=createApp(sampleSeed());assert.deepEqual((a.request({method:'GET',path:'/organizations',token:'alice'}).body as any).items.map((o:any)=>o.id),['org-a']);});
test('logout revokes session',()=>{const a=createApp(sampleSeed());assert.equal(a.request({method:'DELETE',path:'/session',token:'alice'}).status,204);assert.equal(a.request({method:'GET',path:'/me',token:'alice'}).status,401);});
''',
'README.md':'''# Project-management API

Node 24 runs TypeScript directly. Run `npm test`; no third-party dependencies are needed.

`createApp(seed, cache?)` returns a synchronous `request({method,path,token?,query?,body?})` dispatcher plus the in-memory `db` and injected `cache`. The fixture uses no network, clock or database service. Database counters expose project reads, list queries and updates for instrumentation. Cache values are snapshots, not references into storage.

## API conventions

- Successful reads and updates return status 200 with the resource, or a list `{items,total,page,pageSize,sort,direction}`. Logout returns 204 with null.
- Missing/invalid sessions return 401 `{error:"unauthorized"}`.
- Authenticated nonmembers return 403 `{error:"forbidden"}` with no resource fields. Known project IDs use the project's actual owning organization, regardless of organization IDs supplied in query/body. Only `name` is editable; ownership cannot be reassigned.
- Missing projects return 404 `{error:"not_found"}`. Unknown routes also return 404.
- Invalid list options return 400 `{error:"invalid_query"}`; invalid project names return 400 `{error:"invalid_body"}`. Unexpected failures return 500 `{error:"internal_error"}`.

GET/PATCH `/projects/:projectId` require membership in the project's owning organization. GET `/organizations/:organizationId/projects` requires current membership, including on cache hits. GET `/organizations` lists the current user's organizations; GET `/organizations/:organizationId`, GET `/me`, DELETE `/session`, and GET `/health` also work.

## Lists and caching

Page and pageSize default to 1 and 10 (positive integers, size at most 100). Sort is name or updatedAt (default name); direction is asc or desc (default asc). Ties sort by ID in the same direction. The cache must keep organizations, pages, page sizes, sort fields and directions distinct. A successful project update invalidates every list variant for only the owning organization; unrelated cached lists must remain usable. Unauthorized requests must not mutate storage or cached entries. Revoked membership takes effect immediately. Caching must remain enabled, with repeated identical authorized lists avoiding another repository list query.

The injected cache interface is get/set/delete/keys; callers may supply an instrumented implementation. Organization IDs are opaque strings, so cache grouping must distinguish IDs that share prefixes or contain punctuation.
'''
}
for name,content in FILES.items():
 p=F/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_text(content)
(F/'package.json').write_text(json.dumps({'name':'tenant-cache-benchmark','private':True,'type':'module','scripts':{'test':'node --test tests/*.test.ts'},'engines':{'node':'>=24'}},indent=2))
(F/'.gitignore').write_text('node_modules/\n')
print(f'Created {len(list((F/"src").rglob("*.ts")))} source files')
