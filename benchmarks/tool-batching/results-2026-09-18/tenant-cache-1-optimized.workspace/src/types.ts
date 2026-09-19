export type Project = { id: string; organizationId: string; name: string; updatedAt: number };
export type Organization = { id: string; name: string };
export type User = { id: string; name: string };
export type ListOptions = { page: number; pageSize: number; sort: 'name' | 'updatedAt'; direction: 'asc' | 'desc' };
export type Request = { method: string; path: string; token?: string; query?: Record<string,string>; body?: unknown };
export type Response = { status: number; body: unknown };
