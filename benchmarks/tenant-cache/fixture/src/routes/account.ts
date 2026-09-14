import type { Router } from '../http/router.ts';
import type { Database } from '../db/database.ts';
import { requireSession } from '../auth/session.ts';
import { ok } from '../http/response.ts';
export function registerAccount(router:Router,db:Database) {
  router.add('GET','/health',()=>ok({status:'ok'}));
  router.add('GET','/me',req=>ok(requireSession(db,req.token)));
  router.add('DELETE','/session',req=>{requireSession(db,req.token);db.sessions.delete(req.token!);return {status:204,body:null};});
}
