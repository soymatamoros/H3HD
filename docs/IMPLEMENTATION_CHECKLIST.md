# Lista de implementación y aceptación

Leyenda: `[x]` implementado/comprobado en el ámbito indicado; `[ ]` pendiente o sin verificación objetivo. Un test unitario del grafo no prueba generación GPU.

## A — Investigación

- [x] Inspeccionar fuente oficial ComfyUI, documentación y plantillas; conservar versiones y evidencia.
- [x] Verificar FL2VA/Ref2VA, nodos, límite por tipo, índices de referencias, FPS, grilla temporal y resolución local.
- [x] Separar SDXL para imágenes y dependencias por módulo.
- [x] Documentar licencia comercial H3 y distinguirla de la licencia de software.
- [ ] Verificar manifiesto de pesos y texto completo de licencias en Hugging Face: proxy deniega acceso.

## B–D — Backend / modelos / generación

- [x] Constructor de gráficos API de texto, keyframes, referencias, continuación con guía y SDXL.
- [x] Validación por esquema de nodos/modelos de la instancia ComfyUI conectada.
- [x] Prohibir cambios silenciosos de checkpoint, negativos H3, Turbo o resolución fuera de rango.
- [x] Trece pruebas unitarias/contrato de construcción, mapping de audio, límites y modos incompatibles; cinco gráficos validados contra esquemas extraídos de fuente oficial. No es ejecución GPU ni `/object_info` en vivo.
- [x] Corregir `SaveVideo` para el API V3 actual (`format.codec`); validar combos/autogrow dinámicos, tipos, límites y ciclos.
- [ ] Inferencia real texto a video con audio comprobado en GPU.
- [ ] Inferencia real imagen inicial/final a video.
- [ ] Inferencia real multimodal (imagen/video/audio) Ref2VA.
- [ ] Inferencia real continuación con guía y evaluación de continuidad audiovisual.
- [ ] Inferencia real SDXL texto e imagen a imagen.
- [ ] Verificación de archivos de modelos existentes por arquitectura/tamaño/hash completo.
- [ ] Benchmark de RTX 4090, RAM/offload y otras NVIDIA; no sustituir por estimaciones.

## E — Calidad y exportación

- [ ] Validación visual humana de mejoras sobre salidas de inferencia reales.
- [ ] Evaluación documentada de RIFE u otro interpolador; no presentado como disponible.
- [ ] Evaluación de un modelo de superresolución temporal; reescalado Lanczos no es superresolución IA.

## F–H — Interfaz, tests y distribución

- [ ] Recorrido completo en Windows 11 con la distribución portable movida a otra carpeta.
- [ ] Instalación limpia sin Python/Node global, sin permisos de administrador.
- [ ] Pruebas reales del bootstrap de ComfyUI, disponibilidad CUDA y detección NVIDIA.
- [ ] Pruebas reales de descarga/reanudación/cancelación de pesos desde HF.
- [ ] Firma de código y examen de licencias de distribución para una publicación comercial.

Los tests de escritorio, medios, almacenamiento y API implementados por el resto del proyecto se describen en README y en el informe final. Esta lista no da por realizadas pruebas que requieren Windows, pesos o GPU.

## Verificaciones de esta instancia

- [x] 62 tests CPU/transporte/medios/seguridad/almacén/esquemas, con mocks de inferencia/red claramente identificados.
- [x] 18 comprobaciones Chromium de interfaz, sin backend inventado.
- [x] 14 comprobaciones con Electron real en Linux/pantalla virtual: preload/IPC y persistencia de ajustes incluidas.
- [x] Bootstrap scripts PowerShell analizados sintácticamente (3/3), no ejecutados en Windows.
- [x] Máster FLAC H3 separado antes del mux MP4, según esquema oficial compatible v0.43.0.
- [x] Paquete Windows x64 compilado desde Linux; revisar suma en release/SHA256SUMS.txt. Su lanzamiento Windows sigue pendiente.
