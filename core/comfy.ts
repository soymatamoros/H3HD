import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { localBackendUrl } from './security.js';
import type { Asset } from './types.js';

export class ComfyClient extends EventEmitter {
  readonly clientId = randomUUID();
  socket?: WebSocket;
  constructor(public base: string) { super(); this.base = localBackendUrl(base); }
  async request(route: string, body?: unknown) {
    const r = await fetch(this.base + route, { redirect:'error',method: body === undefined ? 'GET' : 'POST', headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error(`ComfyUI ${r.status}: ${(await r.text()).slice(0,1500)}`);
    return r.json();
  }
  health() { return this.request('/system_stats'); }
  objectInfo() { return this.request('/object_info'); }
  queue() { return this.request('/queue'); }
  history(promptId: string) { return this.request('/history/' + encodeURIComponent(promptId)); }
  async connect() {
    this.close();
    const socket = new WebSocket(this.base.replace(/^http:/, 'ws:') + '/ws?clientId=' + this.clientId);
    this.socket = socket;
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => { socket.terminate(); reject(new Error('WebSocket de ComfyUI no respondió.')); }, 10000);
      socket.once('open', () => { clearTimeout(timeout); resolve(); });
      socket.once('error', e => { clearTimeout(timeout); reject(e); });
    });
    socket.on('message', (data, binary) => { if (!binary) { try { this.emit('event', JSON.parse(data.toString())); } catch { /* Ignore non-JSON previews. */ } } });
    socket.on('error', error => this.emit('connectionError', error));
    socket.on('close', () => this.emit('disconnected'));
  }
  close() { this.socket?.removeAllListeners(); this.socket?.close(); this.socket = undefined; }
  async submit(prompt: Record<string,unknown>) {
    const result = await this.request('/prompt', { prompt, client_id: this.clientId });
    if (!result.prompt_id || (result.node_errors && Object.keys(result.node_errors).length)) throw new Error('Flujo rechazado: ' + JSON.stringify(result.node_errors ?? result));
    return result.prompt_id as string;
  }
  async cancel(promptId: string) {
    const q = await this.queue();
    const running = (q.queue_running ?? []).some((x: unknown[]) => x[1] === promptId);
    if (running) await this.request('/interrupt', {});
    else await this.request('/queue', { delete: [promptId] });
  }
  free() { return this.request('/free', { unload_models: true, free_memory: true }); }
  async uploadImage(filename: string, bytes: Uint8Array) {
    const form = new FormData(); form.set('image', new Blob([new Uint8Array(bytes)]), filename); form.set('overwrite','false');
    const r = await fetch(this.base + '/upload/image', { redirect:'error',method: 'POST', body: form, signal: AbortSignal.timeout(60000) });
    if (!r.ok) throw new Error('No se pudo subir la referencia: ' + await r.text());
    const data = await r.json();
    return data.subfolder ? `${data.subfolder}/${data.name}` : data.name as string;
  }
  async output(asset: Asset): Promise<Uint8Array> {
    const qs = new URLSearchParams({ filename: asset.filename, subfolder: asset.subfolder, type: asset.type });
    const r = await fetch(this.base + '/view?' + qs, { redirect:'error',signal: AbortSignal.timeout(120000) });
    if (!r.ok) throw new Error('No se pudo recuperar el archivo generado.');
    const bytes = new Uint8Array(await r.arrayBuffer());
    if (!bytes.length) throw new Error('ComfyUI devolvió un archivo vacío.');
    return bytes;
  }
}
export function historyAssets(history: any): Asset[] {
  const results: Asset[] = [];
  for (const node of Object.values(history.outputs ?? {}) as any[]) {
    for (const key of ['images','gifs','videos','audio']) for (const a of node[key] ?? []) {
      if (typeof a.filename === 'string' && (a.type ?? 'output') === 'output') results.push({ filename: a.filename, subfolder: a.subfolder ?? '', type: 'output' });
    }
  }
  return results.filter((a,i,all) => all.findIndex(b => b.filename === a.filename && b.subfolder === a.subfolder) === i);
}
