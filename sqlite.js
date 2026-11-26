const bun = Boolean(process.versions.bun);
const { Database } = bun ? await import('bun:sqlite') : await import('node:sqlite').then(module => ({ Database: module.DatabaseSync }));

export function openDatabase(path) {
  return new Database(path);
}

export function openReadOnlyDatabase(path) {
  return new Database(path, bun ? { readonly: true } : { readOnly: true });
}
