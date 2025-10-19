// True Modules — TS Port Interfaces (Ports@1)
export type Path = string;

export interface DiffSpec { paths: Path[]; }
export interface DiffResult { summary: string; }

export interface DiffPort {
  /** Unified diff across tracked files; MAY fallback to --no-index for untracked. */
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

export interface ReporterWriteOptions {
  logDir?: Path;
  fileName?: string;
}

export interface ReporterWriteResult {
  file: Path;
  appended: boolean;
  lines: string[];
}

export type ReporterPort = (
  message: string,
  options?: ReporterWriteOptions
) => Promise<ReporterWriteResult>;

export interface CLIParseResult {
  command: string | null;
  options: Record<string, unknown>;
  positionals: string[];
  errors: string[];
}

export type CLIPort = (argv: string[]) => CLIParseResult;

// Version fence for Ports@1 (documentation-only constant).
export const PortsV1 = {
  DiffPort: 1,
  IndexPort: 1,
  WorktreePort: 1,
  SafetyPort: 1,
  ReporterPort: 1,
  CLIPort: 1,
} as const;
