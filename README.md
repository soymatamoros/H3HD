# MiniMax H3 Studio

Estudio de escritorio local en español para ComfyUI, con integración MiniMax H3 y SDXL independiente para imágenes. El repositorio contiene implementación ejecutable, flujos API derivados de plantillas oficiales, instaladores reproducibles y un paquete Windows x64.

**Estado: versión 0.1.0 de ingeniería, pendiente de aceptación en Windows/GPU.** Se construyó el ejecutable Windows desde Linux; eso no prueba su lanzamiento, portabilidad ni generación real. No se incluye ningún resultado simulado como generación. Las funciones solo se habilitan cuando el backend publica los nodos y nombres de modelos necesarios.

## Descargar y abrir

El artefacto generado está en `release/MiniMaxH3Studio-0.1.0-win-x64.zip`. Su suma está en `release/SHA256SUMS.txt`. Extrae **todo** el ZIP en una carpeta con escritura y abre `MiniMax H3 Studio.exe`. Conserva sus DLL, recursos y avisos de licencia. No requiere Node/Python global, Docker o WSL en el equipo destino. El backend y los modelos se descargan por separado después de consentimiento; el ZIP no incluye pesos.

1. En **Ajustes**, revisa GPU, RAM, disco y FFmpeg. Si tienes ComfyUI, selecciona su carpeta y su Python con los selectores nativos; configura carpetas externas de modelos si corresponde.
2. Si no lo tienes, pulsa **Preparar backend portable**. La confirmación detalla las fuentes/licencias. Se descargan ComfyUI v0.43.0 NVIDIA CUDA 12.6 y FFmpeg BtbN, se comprueban sus SHA-256 oficiales, y se ejecuta una prueba tensorial CUDA del Python integrado. Consulta `data/logs/` si falla. No se sobrescriben instalaciones ajenas.
3. En **Modelos**, instala solo las dependencias que necesites. Texto/imagen a video y continuación requieren FL2VA, codificador Qwen3-VL, VAE de video y VAE de audio. Las referencias requieren además Ref2VA. SDXL Base 1.0 es opcional e independiente. Antes de cada descarga se resuelven tamaño y SHA-256 LFS desde Hugging Face, fijando la revisión; se muestran fuente/licencia y se pide aceptación. Sin hash fiable no se descarga. Los tamaños iniciales son aproximados.
4. Pulsa **Reconectar** después de instalar modelos o añadir rutas a una instancia que ya estaba iniciada; reinicia el backend si cambias las rutas externas. Los modelos que ComfyUI ya enumera se reutilizan. Los archivos encontrados por nombre se muestran como **sin verificar**; la instalación verifica por tamaño/hash los candidatos antes de reutilizarlos.
5. Para tu primer video: **Texto a video**, prompt con escena y sonido, formato nativo 1344 × 768, ≈5 segundos, **Máxima calidad** y **Generar**. Se envía un flujo base FL2VA sin LoRA Turbo, `res_multistep` / `simple`, 25 pasos. La salida debe recuperarse y decodificarse con FFmpeg antes de declararse completada.

H3 usa 24 FPS y una rejilla temporal `17k+5`: las selecciones de 5/10/15 segundos producen 124/243/362 fotogramas, aproximadamente 5,167/10,125/15,083 s. El lienzo habitual 1344 × 768 tiene relación 1,75:1, no 16:9 exacto. No se promete 2K nativo. La generación conjunta de audio se conserva; no hay interruptores falsos de audio, negativos o CFG para el flujo H3 base.

## Funciones implementadas

- Interfaz React/TypeScript en español, shell Electron con contexto aislado, sin Node en el renderer; API IPC de acciones concretas y backend limitado a loopback.
- Detección NVIDIA mediante `nvidia-smi`, RAM/disco reales, búsqueda acotada de instalaciones y modelos, rutas externas y bootstrap portátil con Python/PyTorch integrados.
- Cinco constructores de flujo: texto a video, primer/último fotograma, referencias multimodales Ref2VA, continuación mediante guía de los últimos 22 fotogramas y SDXL texto/imagen a imagen. Se validan contra `/object_info` antes del envío.
- Referencias hasta 9 imágenes, 3 videos y 3 audios independientes según el esquema oficial; etiquetas e índices de audio de video separados. Los videos se normalizan a 24 FPS para acondicionamiento y su audio se extrae aparte sin cambiar la frecuencia nativa. Esa normalización es procesamiento de entrada, no mejora de calidad. Se avisa de estiramientos/recortes del flujo oficial.
- API ComfyUI HTTP/WebSocket, progreso real, cola, cancelación, recuperación de errores y archivos. No se cambia de modelo/calidad después de OOM. Solo se detiene el backend iniciado por Studio.
- Descargas por streaming, reanudación HTTP Range, reintentos, cancelación, SHA-256, protección contra sobrescritura y catálogo de revisiones verificadas guardado localmente. La prueba de descarga usa red simulada, no pesos reales.
- Biblioteca con parámetros, workflow, semilla, referencias y originales; renombrar, duplicar, favoritos, reabrir, regenerar y exportar JSON. Guardado atómico, copia de seguridad y recuperación explícita de trabajos interrumpidos. Borradores del editor se conservan automáticamente. La eliminación requiere confirmación y conserva archivos maestros en disco.
- Audio H3 guardado también como máster FLAC independiente antes del mux MP4, usando el nodo oficial SaveAudioAdvanced y la frecuencia nativa. La conversión PCM del guardador no se presenta como conservación bit a bit del tensor FP32.
- Exportación real FFmpeg: MP4 H.264/H.265 si el encoder está disponible, PNG/JPEG/WebP, WAV PCM/AAC/FLAC y copia binaria del original. Escalado Lanczos proporcional hasta altura2160, enfoque conservador y normalización/denoising opcionales. Se conservan originales; las versiones procesadas se registran por separado para comparar.
- Comparación sincronizada y avance por fotogramas, waveform real, niveles/posibles muestras recortadas, diferencias temporales de pistas, estimaciones documentadas de duplicados, cambios de luminancia y suavidad. No son certificados de calidad ni detectores universales de ghosting.
- Datos propios, caché Electron y dependencias dentro de `data/`, junto al ejecutable. Las rutas internas se guardan relativas. Funciona sin conexión una vez instalados y configurados los modelos; la portabilidad completa aún necesita prueba real de traslado en Windows.

## Desarrollo y pruebas

Se eligió Electron en vez de Tauri para producir aquí un paquete x64 reproducible sin toolchain Rust/MSVC y mantener el mismo backend TypeScript probado en Linux y Windows. El usuario final recibe Node/Chromium dentro del paquete, no necesita instalarlos.

Requisitos de desarrollo: Node24, npm y FFmpeg/FFprobe en PATH para los tests multimedia. Las pruebas de integración locales necesitan permiso para abrir un puerto loopback.

```sh
npm ci
npm test
npm run build
npm run desktop
npm run package:win
```

En el entorno de nube con proxy, `NODE_USE_ENV_PROXY=1 npm ci` activa el soporte de proxy de Node para la descarga verificada de Electron; no desactives TLS. `npm run dev` sirve únicamente la interfaz de navegador y muestra que la inferencia exige la aplicación de escritorio. No ofrece un backend de generación simulado.

Resultados de validación actuales: **62 pruebas automatizadas aprobadas** (13 workflows/esquemas de fuente oficial, 12 integración ComfyUI simulada con transporte HTTP/WebSocket real y requisitos de medios, 10 descargas con red simulada y disco/hash reales, 11 multimedia FFmpeg real, 7 persistencia/recuperación/traslado de rutas, 5 seguridad y 4 detección). TypeScript y compilación Vite/escritorio pasan. Las pruebas no ejecutan el modelo H3.

Pruebas de interfaz: `CHROMIUM_PATH=/ruta/a/chromium npm run test:ui` inicia su propio Vite temporal. Pasan **18 comprobaciones** de navegación, recuperación y estado desconectado real, sin API de escritorio ni resultados inventados. `npm run test:electron`, después de compilar, pasa **14 comprobaciones con Electron real en Linux**: ventana, preload/IPC, catálogo, diagnóstico, rechazo de ruta ejecutable no seleccionada y persistencia tras reinicio. Usa una copia temporal aislada. Requiere pantalla; en esta máquina se usó Xorg dummy con DISPLAY=:99 y el opt-in STUDIO_CI_NO_SANDBOX=1 únicamente para el host CI. Ese opt-in no se incluye en el lanzador distribuido. La aplicación mantiene contexto aislado, Node desactivado en renderer y configuración sandbox. Los tres scripts PowerShell se analizaron con el parser oficial de PowerShell; eso tampoco valida su ejecución en Windows.

Para inferencia real se proporciona `scripts/test-windows-inference.ps1`, descrito en [Windows](docs/WINDOWS.md). Los cinco modos necesitan pesos, referencias y fixtures API reales; un fixture ausente falla, no se salta silenciosamente. Conserva la salida `results.json` y evalúa visualmente continuidad y sincronía perceptual.

## Límites pendientes

- Esta máquina no dispone de Windows ni NVIDIA/CUDA. No se ejecutaron inferencia, benchmark RTX4090, instaladores Windows, ni aceptación de traslado a SSD. **No es una entrega certificada de producción.**
- El proxy de esta tarea bloqueó Hugging Face. Los pesos, hashes concretos y textos completos de sus licencias no pudieron verificarse aquí. Los dominios se guardaron en el borrador del entorno, todavía requieren revisión/guardado y publicación para aplicar esa configuración. El instalador los resuelve y verifica en destino antes de descargar.
- No se han validado RIFE, superresolución neuronal, eliminación de ghosting, mejora de voz ni LoRA Turbo; esas funciones no se ofrecen como disponibles. Se conserva FPS nativo y se rechaza una conversión que necesitaría interpolación no validada.
- Máxima calidad y Equilibrado usan el mismo checkpoint oficial, 25/20 pasos respectivamente; no hay un benchmark que pruebe superioridad universal de uno. ComfyUI gestiona offloading; no se afirma que toda la canalización quepa en24GB ni se inventan estimaciones de VRAM.
- No hay traducción inglesa completa, drag-and-drop, editor de timeline multiclip, presets de redes sociales ni controles de bitrate/píxel arbitrarios. Las exportaciones implementadas se describen arriba.
- SDXL imagen a imagen usa las dimensiones de la imagen importada, ajustadas por VAE; no aplica el selector de lienzo de texto a imagen. La continuación incluye el tramo condicionado; no concatena automáticamente los clips ni promete continuidad perfecta.
- El ejecutable no está firmado. La distribución comercial requiere revisar licencias del programa, modelos y dependencias.

Investigación/versiones: [RESEARCH](docs/RESEARCH.md). Estado de aceptación: [checklist](docs/IMPLEMENTATION_CHECKLIST.md). [Hardware](docs/HARDWARE.md), [medios](docs/MEDIA.md), [solución de problemas](docs/TROUBLESHOOTING.md) y [avisos de terceros](THIRD_PARTY_NOTICES.md).
