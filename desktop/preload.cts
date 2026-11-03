import { contextBridge, ipcRenderer } from 'electron';
const methods = ['snapshot','settings','choosePath','backend','generate','cancel','importImage','importReference','modelInfo','installModel','cancelDownload','bootstrap','project','export','analyze','reveal'];
const api: Record<string,unknown> = {};
for (const method of methods) api[method] = (...args: unknown[]) => ipcRenderer.invoke('studio:'+method,...args);
api.onUpdate = (callback: () => void) => {
  const listener = () => callback(); ipcRenderer.on('studio:update',listener);
  return () => ipcRenderer.removeListener('studio:update',listener);
};
contextBridge.exposeInMainWorld('studio',api);
