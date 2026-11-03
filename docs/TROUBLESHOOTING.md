# Solución de problemas

- **Sin conexión:** selecciona ComfyUI (carpeta con main.py), su propio Python y una dirección `http://127.0.0.1:8188`. Guarda e inicia. Solo se admiten loopback literal y HTTP; no proxy remoto. Consulta `data/logs/comfyui.log`. Si la instancia es externa, Studio la reutiliza pero no la detiene.
- **Faltan nodos/modelos:** se muestran sus nombres reales. Instala dependencias de ese modo y reconecta. Reinicia el backend si cambian las rutas externas. No instales custom nodes no verificados para sustituir H3.
- **Hugging Face403/licencia:** revisa acceso de red, permisos del repositorio y licencia. Nunca desactives TLS/hash ni introduzcas credenciales en código o chat. En la nube, los cambios de borrador no aplican automáticamente la red. No se ha confirmado que el modelo requiera token.
- **SHA incorrecto o modelo existente distinto:** no se instala/sobrescribe. Conserva el existente y revisa la fuente/revisión. Los parciales completos corruptos se eliminan o aíslan según instalador. Los parciales interrumpidos válidos pueden reanudarse.
- **CUDA/VRAM:** comprueba el controlador NVIDIA y el PyTorch del backend, cierra otras cargas y libera modelos. La aplicación no reduce calidad después de un fallo.24GB no garantizan que todos los pesos entren en GPU.
- **FFmpeg:** el bootstrap instala binarios portátiles verificados. Una instalación externa puede seleccionarse en Ajustes. Se necesita FFprobe y decodificación FFmpeg para aceptar salidas, no basta con que el archivo exista.
- **Exportación:** el encoder H.265 puede no estar en tu FFmpeg. Usa H.264 si decides cambiar formato. El destino debe ser nuevo; se conservan originales. AAC es con pérdida, WAV/FLAC conservan la señal decodificada, no recuperan información perdida previamente.
- **Sesión interrumpida:** los parámetros/biblioteca se recuperan de JSON/copia.bak; el borrador del prompt se recupera por separado. Los trabajos activos se marcan interrumpidos, no se reenvían: revisa el historial ComfyUI para evitar duplicarlos. Si ambos JSON están corruptos, no los borres; cópialos antes de reparar.
- **Traslado:** cierra Studio, mueve la carpeta completa incluida `data/`. Las rutas externas elegidas siguen dependiendo de su ubicación. La prueba de traslado del almacén pasó en Linux; el paquete completo debe probarse todavía en Windows/SSD.

Registros y proyectos pueden contener prompts/rutas personales. Revisa su contenido antes de compartirlos.
