# Verificación de fuentes — MiniMax H3 Studio

Fecha de revisión: 2 de noviembre de 2026. Las comprobaciones siguientes describen código/documentación oficiales, **no resultados de inferencia obtenidos por esta aplicación**.

## Fuentes fijadas

- ComfyUI: [`858fd58dcd47b1407a6778e0920f02a9b40fd538`](https://github.com/Comfy-Org/ComfyUI/tree/858fd58dcd47b1407a6778e0920f02a9b40fd538).
- Documentación: [`7066cf4385164aee28581f1424bca2c586e6983b`](https://github.com/Comfy-Org/docs/tree/7066cf4385164aee28581f1424bca2c586e6983b/tutorials/video/minimax).
- Plantillas: [`60d0d2c2f5c98ab50116abd837156e4010534657`](https://github.com/Comfy-Org/workflow_templates/tree/60d0d2c2f5c98ab50116abd837156e4010534657/templates).
- Pesos referenciados por esas fuentes: [Comfy-Org/MiniMax-H3](https://huggingface.co/Comfy-Org/MiniMax-H3).

`research/sources.json` conserva las huellas SHA-256 de las plantillas descargadas. `workflows/official/` conserva las plantillas gráficas originales; `workflows/*.api.json` son ejemplos en formato API derivados de sus ramas base. No deben enviarse las plantillas de interfaz directamente a `/prompt`.

## Capacidades locales confirmadas en código

`comfy_extras/nodes_minimax_h3.py` implementa:

- `MiniMaxH3ImageToVideo`: texto sin imágenes, imagen inicial, imagen final o ambas. Checkpoint **FL2VA**.
- `MiniMaxH3ReferenceToVideo`: hasta nueve imágenes, tres videos y tres audios independientes. Checkpoint **Ref2VA** distinto de FL2VA.
- `MiniMaxH3AddGuide`: ancla imagen, lote de fotogramas y/o audio en un índice temporal. Permite continuación condicionada; no equivale a concatenar videos ni garantiza continuidad perfecta.
- `EmptyMiniMaxH3LatentAV`, `MiniMaxH3SigmaShift`, `MiniMaxH3FunControlNetApply` y `MiniMaxH3LatentUpscaleWithModel` también existen, pero la presencia de un nodo no valida automáticamente un flujo o modelo de mejora.

Los índices de API para referencias son cero-based y se expanden con puntos: `ref_images.ref_image_0`, `ref_videos.ref_video_0`, `ref_video_audios.ref_video_audio_0`, `ref_audios.ref_audio_0`. Los tags del prompt son uno-based: `<Picture 1>`, `<Video 1>`, `<Audio 1>`. Las bandas sonoras de videos se numeran como audio antes de los clips de audio independientes, siguiendo el orden de videos. No hay un sistema nativo de enums de roles: identidad, vestuario, cámara y voz se describen en lenguaje natural asociado a esos tags.

No se encontró un límite agregado de contexto más estricto documentado en las fuentes inspeccionadas. Los límites por tipo no son una promesa de que todas las combinaciones entren en la memoria disponible. El servicio hosted tiene límites distintos y no se usa como sustitución local.

## Resolución, tiempo y audio

El lienzo objetivo local es aproximadamente un megapíxel: **1344×768** para el formato panorámico, lados múltiplos de 32. `adapt_canvas` usa borde corto 768 y tope de área `768*1344`. El modelo usa **24 fps**. Los fotogramas se ajustan hacia arriba a `17k+5`: solicitar 5 segundos produce 124 fotogramas (5,1667 s); solicitar 15 produce 362 (15,0833 s). El rango entrenado indicado en el código es aproximadamente 124–362; los valores más largos expuestos por el nodo no se consideran validados.

La documentación corregida aclara que **2K es salida hosted / una ampliación separada**, aunque algunas notas antiguas de plantillas dicen «up to 2K». La aplicación debe distinguir siempre la generación nativa y el reescalado.

El VAE de audio usa 32 kHz por defecto en el código y produce audio estéreo conjunto. `VAEDecode` y `VAEDecodeAudio` deben recibir el mismo latent AV; `CreateVideo` combina imágenes y audio a 24 fps. El formato de exportación puede comprimir el audio: conservar un MP4 no implica audio PCM sin pérdidas.

Referencias de video deben normalizarse realmente a 24 fps antes de cargarse: H3 interpreta el lote de fotogramas como 24 fps. Las bandas sonoras se conectan por separado. La guía de continuación usada aquí toma los últimos 22 fotogramas y, cuando se ofrece, los últimos 22/24 segundos del audio.

**Precaución de composición:** el nodo original estira `first_frame` al lienzo y recorta al centro `last_frame`. La aplicación debe pedir confirmación o exigir coincidencia de aspecto antes de ejecutar imágenes con otra proporción; el nodo no preserva automáticamente ambas composiciones.

## Checkpoints y parámetros

Las plantillas oficiales base usan:

| Componente | Archivo |
| --- | --- |
| Texto / imagen / guía | `diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors` |
| Referencias | `diffusion_models/minimax_h3_ref2va_pruned_int8_convrot.safetensors` |
| Codificador multimodal | `text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors` |
| VAE de video | `vae/minimax_h3_video_vae_int8_convrot.safetensors` |
| VAE de audio | `vae/minimax_h3_audio_vae_fp32.safetensors` |

Los tamaños aproximados documentados son 19,53 GB por difusión, 14,61 GB para codificador, 2,62 GB video VAE y 577,2 MB audio VAE. **No son tamaños exactos de integridad**. El conjunto excede la VRAM de 24 GB: exige carga dinámica/offload y suficiente RAM/almacenamiento. No se ha medido el consumo, velocidad ni calidad en RTX 4090 en este entorno.

Base: `KSamplerSelect=res_multistep`, `BasicScheduler=simple`, `BasicGuider` sin negativo ni CFG. Las plantillas usan 20 pasos; la guía permite 25 para calidad de movimiento. La nota de R2V sugiere experimentar con beta/normal para referencias, pero este producto conserva el baseline simple para no presentar una comparación no medida como validada.

La precisión seleccionada reproduce la combinación oficial (INT8 ConvRot / NVFP4 AWQ / FP32 audio); no se afirma que sea la máxima precisión posible o que toda GPU implemente NVFP4 nativamente. No se ofrecen precisiones alternativas sin un manifiesto verificado. Turbo FL2V usa LoRA de 8 pasos y Turbo Ref2V una de 4; se excluyen del flujo base. «Vista previa» no cambia silenciosamente a Turbo. No se han medido implementaciones de atención ni activado aceleraciones opcionales.

## Imágenes separadas

`image_sdxl_simple.json` usa SDXL Base 1.0 con `CheckpointLoaderSimple`, dos `CLIPTextEncode`, `KSampler` (25 pasos, CFG 7, dpmpp_2m/karras), `EmptyLatentImage`, `VAEDecode`, `SaveImage`. Para imagen-a-imagen se sustituye el latent vacío por `LoadImage` + `VAEEncode`; el valor denoise expresa la regeneración del latent. El checkpoint verificado por nombre es `sd_xl_base_1.0.safetensors`; otros checkpoints no se sustituyen automáticamente.

SDXL se mantiene separado de H3 incluso si una plantilla H3 reciente demuestra un primer-fotograma estático: no se asume que ello sea una canalización de imagen nativa comparable.

## Licencias y bloqueo externo de pesos

La documentación oficial H3 indica que el uso comercial de resultados generados localmente requiere una [licencia comercial MiniMax a través de Comfy](https://comfy.org/minimax/license). El acceso a pesos no concede automáticamente esa licencia. ComfyUI se distribuye con GPL-3.0; la UI del estudio y el proceso backend son componentes distintos y sus obligaciones deben revisarse antes de redistribuir. SDXL Base publica CreativeML Open RAIL++-M con restricciones de uso; deben revisarse también sus componentes.

El proxy de este entorno devuelve **403 al establecer el túnel hacia huggingface.co**. Por ello no se han descargado pesos, ni verificado sus hashes, sus revisiones HF ni el texto completo de sus licencias. Los manifiestos declaran `sha256` vacío y tamaños aproximados explícitos. El instalador **debe consultar la API HF por TLS, fijar revisión completa y SHA-256 LFS/tamaño exacto, y verificar el archivo completo antes de instalarlo**. Si los metadatos no están disponibles, debe bloquear la descarga. No se admite «confirmar» un hash inventado.

La configuración de red guardada como borrador no cambia por sí misma la red de esta instancia. La inferencia real y la validación Windows/NVIDIA requieren una máquina de destino compatible y los pesos legítimamente instalados.

## Auditoría de esquemas API

No hay PyTorch instalado en la máquina de desarrollo. Se inspeccionaron por AST las definiciones `define_schema` / `INPUT_TYPES` y las salidas de los nodos usados en el commit ComfyUI fijado. `tests/fixtures/comfy-source-schema.json` guarda el esquema resultante para tests de contrato; sus listas de nombres de modelos y archivos son **entradas de test**, no detección de pesos reales. No sustituye `/object_info` de una instancia conectada ni ejecución de inferencia.

La auditoría detectó una evolución posterior a las plantillas: `SaveVideo.format` usa `COMFY_DYNAMICCOMBO_V3`; al seleccionar `mp4` el API actual requiere `format.codec=auto`, con clave aplanada con punto. El constructor y el validador implementan esta forma; ComfyUI antiguo sin este esquema debe actualizarse al commit compatible. La validación local expande también autogrow V3, comprueba tipos de enlaces, límites numéricos y dependencias cíclicas, antes de la validación autoritativa del servidor.

`ImageFromBatch` actual acepta índices negativos: suma el número de fotogramas antes de limitar y recortar. Así, `batch_index=-22,length=22` selecciona la cola de la guía, no su comienzo. `TrimAudioDuration` admite segundos negativos desde el final y se usa para alinear la cola de audio opcional.

Resultados de esta auditoría: **13 tests unitarios/contrato de workflow ejecutados y aprobados** con `node --import tsx tests/workflows.test.ts`; se incluyen los cinco modos contra el esquema de fuente fijada, soundtrack/reference numbering, errores de límites y clave dinámica SaveVideo. Ningún resultado representa inferencia GPU real.

### Compatibilidad del backend portable fijado

Se consultó también el tag **ComfyUI v0.43.0**, commit `426f5eea52a7ece1dd599fff4cb6cd1f352ddd24`, directamente en GitHub. Los esquemas de los nodos H3, los samplers usados, los cargadores de modelos, `ImageFromBatch`, `LoadVideo`, `GetVideoComponents`, `LoadAudio` y `TrimAudioDuration` coinciden por AST con las definiciones utilizadas por los tests de contrato. En `SaveVideo`, v0.43.0 ya usa el formato dinámico y `mp4` con `format.codec=auto`; los cambios posteriores agregan MOV/ProRes que este flujo no usa. `CreateVideo` conserva las entradas utilizadas; el cambio posterior es una opción adicional de submuestreo de color. La detección de H3, el tipo de encoder `minimax` y el audio VAE a 32 kHz también están presentes en ese tag. Esta auditoría confirma compatibilidad de los contratos de entrada para el backend del bootstrap; no prueba ejecución CUDA ni corrige el bloqueo de acceso a los pesos.

### Máster de audio independiente

Los cuatro modos H3 conectan además `VAEDecodeAudio` a `SaveAudioAdvanced(format=flac)`, verificado también en v0.43.0. Este archivo conserva por separado el audio nativo decodificado antes de comprimirlo al entregar MP4; FLAC es compresión sin pérdidas de las muestras PCM guardadas, pero no una promesa de identidad bit a bit con el tensor de coma flotante del VAE (el helper de ComfyUI decide la conversión PCM). La pista MP4 se sigue conservando sincronizada con el video.
