# Hardware y perfiles

Objetivo: Windows11 x64 y NVIDIA compatible con PyTorch CUDA12.6 del paquete ComfyUI elegido. El instalador comprueba un tensor CUDA real antes de dar por preparado el runtime. El máximo CUDA del controlador mostrado por `nvidia-smi` no valida ese runtime.

RTX4090/24GiB es el equipo objetivo, **no se ha medido en esta máquina**. El pipeline incluye un checkpoint H3 de ~19,5GB, codificador de ~14,6GB y VAEs; sus pesos combinados exceden24GB. Tamaños aproximados, autoritativos solo tras resolver metadatos. ComfyUI administra carga/offload; RAM, almacenamiento y concurrencia importan. No se promete operación en una GPU concreta sin pruebas. Un SSD rápido y RAM abundante ayudan al offload; no hay un mínimo de RAM validado aquí.

Máxima calidad usa base25pasos; Equilibrado base20. Ambos mantienen pesos oficiales INT8/NVFP4/FP32 según componente. No se fuerza una cuantización distinta ni se aplica Turbo. Interpolación desactivada; no se ha validado una mejora temporal. Si ocurre OOM, Studio conserva parámetros e indica liberar cargas o cambiar explícitamente el perfil. No hay cambio automático a menor calidad.

La detección solo consulta ubicaciones comunes y las carpetas seleccionadas, excluye symlinks y limita profundidad/archivos. Un archivo detectado no es un modelo verificado. El instalador puede reutilizar un archivo existente cuando tamaño y SHA-256 coinciden con metadatos de la fuente oficial. No se han descargado pesos aquí.
