# Windows portátil: compilación y validación

Objetivo: Windows 11 x64, GPU NVIDIA y controlador compatible con el PyTorch CUDA
del paquete seleccionado. El desarrollo actual se ejecuta en Linux sin GPU:
**ninguna prueba de lanzamiento Windows, CUDA ni inferencia H3 está validada por
el mero hecho de compilar o empaquetar los archivos.**

En esta máquina se comprobaron cuatro pruebas automatizadas de detección y la
sintaxis de los tres scripts PowerShell mediante el parser oficial PowerShell
7.5.4 para Linux. El paquete de ese parser se verificó con su SHA256 publicado.
Analizar la sintaxis no valida el comportamiento de Windows PowerShell 5.1 ni
ejecuta las descargas, extracción, CUDA o inferencia en Windows.

## Compilar

En una máquina de desarrollo con Node.js y npm (el usuario final no los necesita):

```powershell
npm ci
npm test
npm run package:win
```

El empaquetador produce un ZIP en `release/` y una carpeta `release/win-unpacked/`.
Extrae todo el ZIP, conserva `resources/` junto al ejecutable y ejecuta
`MiniMax H3 Studio.exe`. La carpeta debe admitir escritura. No la instales en
`Program Files`: los datos portátiles deben permanecer junto a la aplicación.
La distribución Electron requiere los avisos de licencia que el empaquetador
incluye. No se afirma firma Authenticode de esta versión.

## ComfyUI sin Python global

La aplicación incluye `scripts/bootstrap-comfy.ps1` y el extractor 7za para
descargar, verificar y extraer el paquete oficial **v0.43.0 NVIDIA CUDA 12.6**.
No necesita Node, Python, Docker, WSL ni permisos de administrador en destino.
Antes de instalar, la interfaz debe mostrar el origen y la licencia y pedir la
confirmación explícita del usuario.

- Fuente: <https://github.com/Comfy-Org/ComfyUI/releases/tag/v0.43.0>
- Archivo: `ComfyUI_windows_portable_nvidia_cu126.7z`, aproximadamente 1.8 GB.
- SHA256 publicado por GitHub:
  `691dcb5295e73594c6530ff7f3fca8dbe7dfb45114b951328c5dd3df0fff6c6b`.
- Evidencia del digest:
  <https://github.com/Comfy-Org/ComfyUI/releases/expanded_assets/v0.43.0>.
- ComfyUI: GPL-3.0; PyTorch, Python y otras dependencias conservan sus propias
  licencias. Los modelos no vienen incluidos ni comparten necesariamente esa
  licencia.

La comprobación del nodo H3 se hizo también en el archivo oficial de esa versión:
<https://raw.githubusercontent.com/Comfy-Org/ComfyUI/v0.43.0/comfy_extras/nodes_minimax_h3.py>.
El instalador conserva parciales para reanudar, rechaza sumas incorrectas y no
ejecuta el contenido antes de verificarlo. Nunca sobrescribe una instalación
incompatible que ya exista. Tras extraer, ejecuta una operación tensorial real
con el PyTorch CUDA integrado; si falla, conserva el backend para diagnóstico.
Este ensayo no es una generación ni un benchmark H3.

Uso manual equivalente para diagnóstico, dentro de la distribución extraída:

```powershell
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File .\resources\scripts\bootstrap-comfy.ps1 -Root .\data -SevenZip .\resources\tools\7za.exe
```

`ExecutionPolicy Bypass` se limita a ese proceso y permite ejecutar el script
incluido; no modifica la política del equipo. La descarga mantiene validación
TLS. Los archivos terminan en `data/comfyui/` y `data/runtime.paths.json` informa
las rutas detectadas. Ese fichero contiene rutas locales, no credenciales.

Una instalación existente puede seleccionarse en Ajustes. Usa su `ComfyUI/`
(donde están `main.py` y `comfy/`) y el `python_embeded/python.exe` del mismo
paquete. La aplicación no actualiza automáticamente una instalación ajena.
FFmpeg y FFprobe pueden seleccionarse en Ajustes o instalarse portátiles con el
segundo bootstrap, después de revisar su origen y GPL v3+:

```powershell
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File .\resources\scripts\bootstrap-ffmpeg.ps1 -Root .\data
```

Este script fija la compilación BtbN `autobuild-2026-11-02-12-51`, FFmpeg 8.1,
archivo `ffmpeg-n8.1.3-32-g760d10603e-win64-gpl-8.1.zip`, con SHA256
`29da2b3b4f1db458df12abc04b6297be11335547fa3f39646419b9d5293dd72a` publicado en
<https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-11-02-12-51/checksums.sha256>.
No utiliza `latest`, comprueba la suma antes de extraer, conserva las licencias
incluidas y escribe `data/ffmpeg.paths.json`. No instala FFmpeg en el sistema.
Las versiones Windows de ambos scripts requieren validación real en destino.

## Hardware y calidad

La detección ejecuta `nvidia-smi` con argumentos fijos para leer nombre, VRAM
total/libre y controlador. El campo CUDA de `nvidia-smi` es el máximo soportado
por el controlador, **no demuestra** que funcione el runtime PyTorch concreto.
La memoria RAM y el disco se miden en la máquina real. No se recorre cada disco:
se inspeccionan ubicaciones comunes concretas y los directorios seleccionados.
La búsqueda de modelos tiene profundidad máxima de cuatro niveles y límite de
5 000 archivos, excluye enlaces simbólicos y no considera un nombre de archivo
como prueba de arquitectura o integridad. Los modelos encontrados se etiquetan
como no verificados hasta comprobar su manifiesto/hash.

24 GB de VRAM no significan que H3 completo quepa en la GPU. ComfyUI puede
descargar capas a RAM; la necesidad real depende del checkpoint y workflow.
La aplicación no reduce calidad automáticamente ante OOM. Cierra otras cargas,
libera modelos o selecciona conscientemente un perfil compatible.

## Aceptación real en la máquina objetivo

1. Inicia el ejecutable y verifica que la interfaz funciona; selecciona/instala
   ComfyUI y comprueba la operación CUDA del runtime.
2. Instala los modelos indicados con su licencia y espera verificación completa.
3. Ejecuta cada modo y exporta sus workflows API desde la biblioteca. Para los
   modos que requieren referencias, los archivos deben estar subidos al backend
   y los nodos deben apuntar a esos nombres. No utilices el JSON visual del editor.
4. Guarda fixtures reales con estos nombres: `text-video.json`,
   `image-video.json`, `reference-video.json`, `extend-video.json`, `image.json`.
5. Ejecuta las pruebas optativas (pueden tardar horas y consumir GPU/disco):

```powershell
powershell.exe -NoProfile -File .\resources\scripts\test-windows-inference.ps1 -WorkflowDirectory .\acceptance-fixtures -FFprobe C:\ruta\ffprobe.exe
```

El runner usa `/object_info`, `/prompt`, `/history/{prompt_id}` y `/view`, guarda
metadatos de la ejecución actual y abre cada salida con FFprobe. Exige salida
audiovisual con audio para H3. Un fixture ausente es un fallo, nunca un pase ni
un sustituto simulado. La sincronía perceptual, preservación de referencias y
calidad visual requieren además evaluación humana del resultado: un contenedor
válido no demuestra esas propiedades.

Verifica también reinicio con proyectos conservados, cancelación durante carga
y sampling, falta de VRAM, desconexión del backend y una exportación reproducible.
Cierra la aplicación, mueve la **carpeta completa** a otra ubicación/escritura o
SSD externo, arráncala y repite una generación. Rutas externas de modelos elegidas
por el usuario deben seguir existiendo o seleccionarse de nuevo. No declares
portabilidad validada antes de realizar esa prueba de traslado.
