export type Path = string;

export interface DiffSpec { paths: Path[]; }
export interface DiffResult { summary: string; }

export interface DiffPort {
  diff(spec: DiffSpec): Promise<DiffResult>;
}

export interface IndexPort {
  stage(paths: Path[]): Promise<void>;
  unstage(paths: Path[]): Promise<void>;
}

export interface WorktreeRef { root: Path; }
export interface WorktreePort {
  create(base: Path, name: string): Promise<WorktreeRef>;
  cleanup(wt: WorktreeRef): Promise<void>;
}

export interface SafetyPort {
  normalizePath(p: Path): Promise<Path>;
  isSafe(p: Path): Promise<boolean>;
}

export declare const PortsV1: {
  readonly DiffPort: 1;
  readonly IndexPort: 1;
  readonly WorktreePort: 1;
  readonly SafetyPort: 1;
};
