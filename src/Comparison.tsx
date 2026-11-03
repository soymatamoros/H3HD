import { useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Pause, Play } from 'lucide-react';
import type { Asset } from '../core/types';

export function Comparison({ original, processed }: { original: Asset; processed: Asset }) {
  const left = useRef<HTMLVideoElement>(null), right = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const video = /\.(mp4|webm|mov|mkv)$/i.test(original.filename);
  const metadata = (original as Asset & { metadata?: Record<string, unknown> }).metadata;
  const fps = typeof metadata?.fps === 'number' && metadata.fps > 0 ? metadata.fps : 24;
  const seek = (target: number) => {
    const safe = Math.max(0, Math.min(duration, target));
    if (left.current) left.current.currentTime = safe;
    if (right.current) right.current.currentTime = safe;
    setTime(safe);
  };
  const pause = () => { left.current?.pause(); right.current?.pause(); setPlaying(false); };
  const play = async () => {
    if (!left.current || !right.current) return;
    right.current.currentTime = left.current.currentTime;
    try { await Promise.all([left.current.play(), right.current.play()]); setPlaying(true); } catch { pause(); }
  };
  return <section className="comparison-view" aria-label="Comparación de original y procesado">
    <div className="comparison-grid">
      <div><span>Original</span>{video ? <video ref={left} src={original.url} preload="metadata" playsInline onLoadedMetadata={() => setDuration(left.current?.duration || 0)} onTimeUpdate={() => { const current = left.current?.currentTime || 0; setTime(current); if (right.current && Math.abs(right.current.currentTime - current) > 0.1) right.current.currentTime = current; }} onEnded={pause} /> : <img src={original.url} alt="Original sin procesar" />}</div>
      <div><span>Procesado</span>{video ? <video ref={right} src={processed.url} preload="metadata" playsInline muted /> : <img src={processed.url} alt="Resultado procesado" />}</div>
    </div>
    {video && <div className="comparison-controls"><button className="icon-button" title="Fotograma anterior" aria-label="Fotograma anterior" onClick={() => { pause(); seek(time - 1 / fps); }}><ChevronLeft size={17} /></button><button className="icon-button" aria-label={playing ? 'Pausar comparación' : 'Reproducir comparación'} onClick={() => playing ? pause() : void play()}>{playing ? <Pause size={16} /> : <Play size={16} />}</button><button className="icon-button" title="Fotograma siguiente" aria-label="Fotograma siguiente" onClick={() => { pause(); seek(time + 1 / fps); }}><ChevronRight size={17} /></button><input aria-label="Posición de reproducción sincronizada" type="range" min={0} max={duration || 0} step={1 / fps} value={time} onChange={e => seek(+e.target.value)} /><span>{time.toFixed(2)} / {duration.toFixed(2)} s</span></div>}
    <p>Comparación sincronizada. El audio se reproduce desde el original.{video && !metadata?.fps ? ' El paso de inspección es de 1/24 s; consulta el análisis para conocer los FPS reales.' : ''}</p>
  </section>;
}

export function AudioWaveform({ analysis }: { analysis: Record<string, unknown> }) {
  const audio = analysis.audio as Record<string, unknown> | undefined;
  const wave = Array.isArray(audio?.waveform) ? audio.waveform.filter((n): n is number => typeof n === 'number' && Number.isFinite(n)) : [];
  if (!wave.length) return null;
  return <div className="waveform-panel"><svg viewBox={`0 0 ${wave.length * 4} 70`} role="img" aria-label="Forma de onda del audio analizado" preserveAspectRatio="none"><line x1={0} y1={35} x2={wave.length * 4} y2={35} stroke="#43503a" strokeWidth={1} />{wave.map((value, i) => { const size = Math.max(1, Math.min(1, value) * 64); return <rect key={i} x={i * 4} y={35 - size / 2} width={2} height={size} fill="#a4be8c" rx={1} />; })}</svg><div><span>Pico: {typeof audio?.peakDBFS === 'number' ? `${audio.peakDBFS.toFixed(1)} dBFS` : 'Silencio'}</span><span>{audio?.clippingCandidate ? 'Candidatos a recorte detectados' : 'Sin muestras a escala completa'}</span><span>{typeof audio?.sampleRate === 'number' ? `${audio.sampleRate.toLocaleString('es')} Hz` : ''}</span></div></div>;
}
