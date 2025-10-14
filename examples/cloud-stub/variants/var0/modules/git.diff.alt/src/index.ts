type DiffSpec = { paths: string[] };
type DiffResult = { summary: string };

export const diffPort = {
  async diff(_spec: DiffSpec): Promise<DiffResult> {
    return { summary: 'stub diff' };
  }
};
