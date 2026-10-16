import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import path from 'node:path';

// Only main-process folder selections enter this registry; renderers cannot add paths.
export class ProjectStore {
  constructor(file) { this.file = file; this.paths = []; }
  read() {
    if (!this.file) return [...this.paths];
    try { return JSON.parse(readFileSync(this.file, 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }
  projectPaths(registry) {
    const paths = Array.isArray(registry) ? registry
      : registry?.version === 1 && Array.isArray(registry.projects)
        ? registry.projects.map(project => project?.path) : null;
    if (!paths || paths.some(value => typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0'))) throw new Error('Invalid saved project registry');
    return [...new Set(paths)];
  }
  list() { return this.projectPaths(this.read()); }
  add(folder) {
    const registry = this.read();
    const paths = [folder, ...this.projectPaths(registry).filter(value => value !== folder)];
    this.projectPaths(paths);
    // Keep the original format, including names, session history and unknown metadata.
    const saved = Array.isArray(registry) ? paths : {
      ...registry,
      projects: [
        ...registry.projects.filter(project => project.path === folder),
        ...(registry.projects.some(project => project.path === folder) ? [] : [{ path: folder, name: path.basename(folder), sessions: [] }]),
        ...registry.projects.filter(project => project.path !== folder),
      ],
    };
    if (this.file) {
      mkdirSync(path.dirname(this.file), { recursive: true });
      const temporary = this.file + '.tmp';
      writeFileSync(temporary, JSON.stringify(saved), { mode: 0o600 });
      renameSync(temporary, this.file);
    }
    this.paths = paths;
  }
}
