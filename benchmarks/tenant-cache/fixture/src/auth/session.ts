import type { Database } from '../db/database.ts';
import { HttpError } from '../http/response.ts';
export function requireSession(db:Database,token?:string) {
  const id=token ? db.sessions.get(token) : undefined;
  const user=id ? db.users.get(id) : undefined;
  if(!user) throw new HttpError(401,'unauthorized');
  return {...user};
}
