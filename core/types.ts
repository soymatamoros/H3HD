export type Mode = 'text-video' | 'image-video' | 'reference-video' | 'extend-video' | 'image';
export type Quality = 'maximum' | 'balanced' | 'preview';
export interface Settings { comfyUrl: string; comfyPath: string; pythonPath: string; modelPaths: string[]; ffmpegPath: string; ffprobePath: string; language: 'es' | 'en'; }
export interface Hardware { platform: string; ramGB: number; freeDiskGB: number; gpu: { name: string; vramMB: number; freeMB: number; driver: string }[]; cuda: string; warnings: string[]; }
export interface Discovery { comfyPaths: string[]; models: { path: string; name: string; size: number; category: string; verified: boolean }[]; ffmpeg: boolean; }
export interface Capability { id: Mode; supported: boolean; reason: string; model: string; }
export interface Asset { filename: string; subfolder: string; type: string; local?: string; url?: string; processed?:boolean; metadata?:Record<string,unknown>; }
export interface Job { id: string; promptId?: string; projectId: string; status: 'queued'|'running'|'completed'|'failed'|'cancelled'; progress: number; stage: string; error?: string; outputs: Asset[]; createdAt: string; }
export interface Project { id: string; name: string; favorite: boolean; createdAt: string; updatedAt: string; request: GenerationRequest; workflow: Record<string,unknown>; outputs: Asset[]; }
export interface GenerationRequest { mode: Mode; prompt: string; negative: string; width: number; height: number; seed: number; steps: number; cfg: number; quality: Quality; checkpoint: string; inputImage?: string; lastImage?: string; denoise?: number; duration?: number; references?: {kind:'image'|'video'|'audio';filename:string;role:string;audioFilename?:string}[]; guideVideo?:string; guideAudio?:string; }
export interface ModelEntry { id: string; name: string; purpose: string; source: string; url: string; filename: string; category: string; bytes: number; sha256: string; license: string; licenseUrl: string; architecture: string; optional: boolean; }
export interface Download { id: string; status: 'downloading'|'verifying'|'completed'|'cancelled'|'failed'; received: number; total: number; error?: string; }
export interface Snapshot { settings: Settings; hardware: Hardware; discovery: Discovery; capabilities: Capability[]; connected: boolean; backendError?: string; checkpoints: string[]; jobs: Job[]; projects: Project[]; models: ModelEntry[]; downloads: Download[]; }
export interface ExportOptions { asset: Asset; format: 'mp4-h264'|'mp4-h265'|'png'|'jpeg'|'webp'|'wav'|'aac'|'flac'|'original'; targetHeight?: number; fps?: number; sharpen?: boolean; normalize?: boolean; denoise?: boolean; volume?: number; crf?: number; }
export interface StudioAPI {
  snapshot(): Promise<Snapshot>;
  settings(settings: Settings): Promise<void>;
  choosePath(kind: 'comfy'|'python'|'models'|'ffmpeg'|'ffprobe'): Promise<string|null>;
  backend(action: 'start'|'stop'|'reconnect'|'free'): Promise<void>;
  generate(request: GenerationRequest): Promise<Job>;
  cancel(id: string): Promise<void>;
  importImage(): Promise<string|null>;
  importReference(kind: 'image'|'video'|'audio'): Promise<{filename:string;url:string;audioFilename?:string}|null>;
  installModel(id: string): Promise<void>;
  modelInfo(id: string): Promise<ModelEntry>;
  cancelDownload(id: string): Promise<void>;
  bootstrap(): Promise<void>;
  project(action: 'rename'|'duplicate'|'favorite'|'delete'|'workflow', id: string, value?: string): Promise<void>;
  export(options: ExportOptions): Promise<string|null>;
  analyze(asset: Asset): Promise<Record<string,unknown>>;
  reveal(asset: Asset): Promise<void>;
  onUpdate(callback: () => void): () => void;
}
declare global { interface Window { studio?: StudioAPI; } }
