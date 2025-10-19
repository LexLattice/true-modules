export interface ReporterWriteOptions {
  logDir?: string;
  fileName?: string;
  cwd?: string;
}

export interface ReporterWriteResult {
  file: string;
  appended: boolean;
  lines: string[];
}

export declare function reporterWrite(
  message: string,
  options?: ReporterWriteOptions
): Promise<ReporterWriteResult>;
