# Medios y límites de validación

Los medios se procesan con procesos FFmpeg/FFprobe sin shell. Las rutas de entrada deben resolverse desde los activos registrados por el proceso principal; el renderer no puede ejecutar comandos ni suministrar argumentos FFmpeg. Nunca se sobrescribe un original ni un archivo de destino existente.

Antes de aceptar una generación, `validatePlayableMedia` comprueba dimensiones/canales/frecuencia válidos y decodifica completamente las primeras pistas de audio y video con FFmpeg `-xerror`. Esto detecta contenedores con metadatos válidos pero payload truncado. El proceso tiene un límite de 180 segundos: excederlo rechaza la verificación, sin fingir que el archivo es correcto. Esta comprobación confirma decodificación, no la calidad perceptual del resultado.

La exportación MP4 usa libx264 o libx265 (si el ejecutable instalado incluye el codificador), CRF 16, preset slow, YUV 4:2:0 y AAC a 320 kb/s cuando existe audio. AAC es con pérdida. WAV PCM de 24 bits y FLAC evitan una nueva compresión con pérdida, pero no recuperan información ya perdida en el original. La copia original conserva los bytes. PNG, JPEG y WebP exportan el primer fotograma; WebP usa su modo sin pérdida. Los tamaños se cambian con Lanczos, conservando la composición y la proporción salvo el redondeo de un píxel necesario para dimensiones pares. Esta operación es escalado convencional, no restauración mediante IA, y no cambia la resolución de generación nativa.

La nitidez opcional usa `unsharp=5:5:0.25:5:5:0`. El audio puede aplicar, por solicitud explícita, `afftdn=nf=-25`, normalización EBU R128 `loudnorm=I=-16:TP=-1.5:LRA=11` y volumen de 0 a 4. No se aplica reducción de ruido ni normalización de forma automática. La normalización es de una pasada; no se promete exactitud de dos pasadas. Se conserva la frecuencia de muestreo nativa de entrada al exportar. Los originales permanecen disponibles. No existe mejora de voz neuronal ni interpolación RIFE validada: cambiar FPS se rechaza, en vez de duplicar fotogramas o fingir interpolación.

El análisis usa datos decodificados reales, con límites explícitos:

- Audio: hasta los primeros 120 segundos, muestras PCM flotantes a la frecuencia nativa, pico/RMS dBFS, número de muestras con magnitud >= 1 − 1/32768 y 128 máximos para dibujar forma de onda. Silencio devuelve nivel nulo (−infinito), nunca un valor ficticio. Alcanzar escala completa es una alerta candidata de recorte, no prueba concluyente de distorsión.
- Video: hasta los primeros 30 segundos y 900 fotogramas. Se reduce cada fotograma a 160 px de ancho, escala de grises. La diferencia absoluta media de luminancia estima cambios de imagen. Una transición <0.5/255 cuenta como casi duplicada; >30/255 cuenta como cambio brusco candidato. La desviación estándar de los cambios de luminancia media permite observar variación temporal. Una toma estática produce duplicados legítimos y los cortes producen cambios bruscos legítimos.
- Suavidad: varianza del Laplaciano discreto de cuatro vecinos sobre el fotograma reducido. Un valor bajo puede corresponder a desenfoque o una escena sin textura. No permite comparar detalle nativo entre resoluciones diferentes y no califica la estética.
- Sincronía: diferencia de timestamp inicial y, cuando están disponibles, duraciones de pistas. Es una comprobación de contenedor, no de sincronía labial perceptual. Offset >100 ms o duración diferente >150 ms solicita revisión.

No se afirma detectar ghosting, identidad inestable, deformaciones, calidad absoluta ni ausencia de artefactos. Las métricas no alteran automáticamente el archivo ni los ajustes de inferencia.

Referencias de algoritmos y filtros: [FFmpeg filters](https://ffmpeg.org/ffmpeg-filters.html), [FFprobe](https://ffmpeg.org/ffprobe.html), [EBU R128](https://tech.ebu.ch/publications/r128).
