export interface CLIParseResult {
  command: string | null;
  options: Record<string, unknown>;
  positionals: string[];
  errors: string[];
}

export declare function cliParse(argv: string[]): CLIParseResult;
