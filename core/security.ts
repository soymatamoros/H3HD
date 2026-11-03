import path from 'node:path';
import { realpath } from 'node:fs/promises';

export function localBackendUrl(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('ComfyUI debe usar HTTP en 127.0.0.1 o [::1], sin rutas ni credenciales.');
  }
  return url.origin;
}
export function safeChild(root: string, relative: string): string {
  if (!relative || path.isAbsolute(relative) || relative.includes('\0') || relative.includes('\\') || relative.includes(':')) throw new Error('Ruta no permitida.');
  const target = path.resolve(root, relative);
  if (!target.startsWith(path.resolve(root) + path.sep)) throw new Error('Ruta fuera del directorio permitido.');
  return target;
}
export async function existingChild(root: string, relative: string): Promise<string> {
  const target = await realpath(safeChild(root, relative));
  const base = await realpath(root);
  if (!target.startsWith(base + path.sep)) throw new Error('Enlace fuera del directorio permitido.');
  return target;
}
export function fileName(name: string): string {
  if (!/^[\w. -]+$/u.test(name) || name === '.' || name === '..' || /[. ]$/.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) throw new Error('Nombre de archivo no permitido.');
  return name;
}
export function readableError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/out of memory|cuda.*alloc/i.test(message)) return 'VRAM insuficiente. Cierra otras aplicaciones o elige explícitamente otro perfil; no se ha reducido la calidad.';
  if (/ECONNREFUSED|fetch failed/i.test(message)) return 'No se puede conectar con ComfyUI. Revisa la ruta del backend y arráncalo en Ajustes.';
  return message.slice(0, 2000);
}
