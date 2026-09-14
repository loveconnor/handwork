import type { Response } from '../types.ts';
export class HttpError extends Error {
  status:number;
  constructor(status:number,message:string){super(message);this.status=status;}
}
export function ok(body:unknown):Response{return {status:200,body};}
export function failure(error:unknown):Response {
  return error instanceof HttpError ? {status:error.status,body:{error:error.message}} : {status:500,body:{error:'internal_error'}};
}
