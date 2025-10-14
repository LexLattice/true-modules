export const handler = {
  async create(base: string, name: string) {
    return { root: `${base}/${name}` };
  },
  async cleanup() {
    return;
  }
};
