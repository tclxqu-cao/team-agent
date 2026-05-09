// ── Project Domain ──

export interface Project {
  id: string;
  name: string;
  description: string;
  created: string;
  updated: string;
}

export interface IProjectStore {
  get(id: string): Promise<Project | null>;
  create(project: Project): Promise<Project>;
  update(id: string, update: Partial<Project>): Promise<Project>;
  delete(id: string): Promise<void>;
  list(): Promise<Project[]>;
}
