export function makeLogger(prefix: string) {
  const tag = `[${prefix}]`;
  return {
    info: (msg: string) => console.log(`${tag} ${msg}`),
    warn: (msg: string) => console.warn(`${tag} ${msg}`),
    error: (msg: string) => console.error(`${tag} ${msg}`),
  };
}
