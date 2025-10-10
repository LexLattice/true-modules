export const safetyPort = {
  async normalizePath(p: string): Promise<string> {
    return p;
  },
  async isSafe(_p: string): Promise<boolean> {
    return true;
  }
};
