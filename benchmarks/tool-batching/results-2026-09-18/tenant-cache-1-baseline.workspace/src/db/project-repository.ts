import type { Database } from './database.ts';
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
