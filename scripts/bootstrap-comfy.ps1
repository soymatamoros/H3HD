# MiniMax H3 Studio: official portable ComfyUI installation. PowerShell 5.1+.
# This script downloads no weights. Run only after reviewing the source/license.
[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$Root,
  [Parameter(Mandatory=$true)][string]$SevenZip
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ([Environment]::OSVersion.Platform -ne 'Win32NT') { throw 'Este instalador requiere Windows x64.' }
if (![Environment]::Is64BitOperatingSystem) { throw 'Windows x64 es obligatorio.' }
$Root = [IO.Path]::GetFullPath($Root)
$SevenZip = [IO.Path]::GetFullPath($SevenZip)
if (!(Test-Path -LiteralPath $SevenZip -PathType Leaf)) { throw 'Falta el extractor 7za.exe incluido en la aplicación.' }
New-Item -ItemType Directory -Force -Path $Root | Out-Null
$target = Join-Path $Root 'comfyui'
$runtimeFile = Join-Path $Root 'runtime.paths.json'
function Assert-CudaRuntime([string]$Python) {
  & $Python -s -c 'import torch; print("PyTorch",torch.__version__,"CUDA runtime",torch.version.cuda); assert torch.cuda.is_available(), "CUDA no disponible en el runtime integrado"; x=torch.ones(1,device="cuda"); print(torch.cuda.get_device_name(0), x.item())'
  if ($LASTEXITCODE -ne 0) { throw 'El runtime CUDA no pasó la prueba. Revisa el controlador NVIDIA; la instalación se conserva para diagnóstico.' }
}
if (Test-Path -LiteralPath $target) {
  if ((Test-Path -LiteralPath (Join-Path $target 'ComfyUI\main.py')) -and (Test-Path -LiteralPath (Join-Path $target 'python_embeded\python.exe'))) {
    Write-Output 'ComfyUI ya existe. No se ha sobrescrito ni actualizado.'
    Assert-CudaRuntime (Join-Path $target 'python_embeded\python.exe')
    @{ comfyPath=(Join-Path $target 'ComfyUI'); pythonPath=(Join-Path $target 'python_embeded\python.exe') } | ConvertTo-Json | Set-Content -LiteralPath $runtimeFile -Encoding UTF8
    exit 0
  }
  throw "El destino $target ya existe y no es un paquete válido. Selecciona una instalación existente o mueve ese directorio; no se sobrescribirá."
}
$url = 'https://github.com/Comfy-Org/ComfyUI/releases/download/v0.43.0/ComfyUI_windows_portable_nvidia_cu126.7z'
$digest = '691dcb5295e73594c6530ff7f3fca8dbe7dfb45114b951328c5dd3df0fff6c6b'
# Digest published by GitHub at /Comfy-Org/ComfyUI/releases/expanded_assets/v0.43.0.
# CUDA 12.6 package is chosen for broad Ada/RTX4090 compatibility; driver/runtime
# compatibility must still pass the actual embedded PyTorch check below.
$cache = Join-Path $Root 'downloads'
New-Item -ItemType Directory -Force -Path $cache | Out-Null
$archive = Join-Path $cache 'ComfyUI-v0.43.0-nvidia-cu126.7z.partial'
$curl = Join-Path $env:SystemRoot 'System32\curl.exe'
if (!(Test-Path -LiteralPath $curl -PathType Leaf)) { throw 'Falta curl.exe de Windows 11; restaura el componente del sistema.' }
Write-Output "Origen oficial: $url"
Write-Output 'Licencia ComfyUI GPL-3.0; el paquete también contiene dependencias con sus propias licencias.'
Write-Output 'Descarga aproximada: 1.8 GB; se requiere espacio adicional para extracción y modelos.'
$drive = [IO.DriveInfo]::new([IO.Path]::GetPathRoot($Root))
if ($drive.AvailableFreeSpace -lt 12GB) { throw 'Se requieren al menos 12 GB libres para descargar y extraer el backend (sin modelos).' }
if ((Test-Path -LiteralPath $archive) -and ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -eq $digest)) {
  Write-Output 'Archivo íntegro reutilizado.'
} else {
  & $curl --fail --location --retry 3 --retry-delay 2 --connect-timeout 30 --proto '=https' --tlsv1.2 --continue-at - --output $archive $url
  if ($LASTEXITCODE -ne 0) { throw "Falló la descarga (curl $LASTEXITCODE). El archivo parcial se conserva para reanudar." }
}
Write-Output 'Verificando SHA256 oficial antes de extraer o ejecutar...'
$actual = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actual -ne $digest) {
  $quarantine = $archive + '.invalid-' + [DateTime]::UtcNow.ToString('yyyyMMddHHmmss')
  Move-Item -LiteralPath $archive -Destination $quarantine
  throw "SHA256 incorrecto. Archivo aislado en $quarantine. No se ha extraído ni ejecutado."
}
$staging = Join-Path $Root ('comfyui-install-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $staging | Out-Null
try {
  & $SevenZip x $archive "-o$staging" -y
  if ($LASTEXITCODE -ne 0) { throw "Falló la extracción: $LASTEXITCODE" }
  $portable = Join-Path $staging 'ComfyUI_windows_portable'
  if (!(Test-Path -LiteralPath (Join-Path $portable 'ComfyUI\main.py'))) { throw 'Estructura del paquete inesperada: falta ComfyUI/main.py.' }
  if (!(Test-Path -LiteralPath (Join-Path $portable 'python_embeded\python.exe'))) { throw 'Falta el runtime Python integrado.' }
  if (!(Test-Path -LiteralPath (Join-Path $portable 'ComfyUI\comfy_extras\nodes_minimax_h3.py'))) { throw 'Este paquete no incluye los nodos H3 esperados.' }
  Move-Item -LiteralPath $portable -Destination $target
} finally {
  if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
}
$python = Join-Path $target 'python_embeded\python.exe'
$comfy = Join-Path $target 'ComfyUI'
# This is a real runtime test, not an inference benchmark or quality claim.
Assert-CudaRuntime $python
@{ comfyPath=$comfy; pythonPath=$python; release='v0.43.0'; archiveSha256=$digest } | ConvertTo-Json | Set-Content -LiteralPath $runtimeFile -Encoding UTF8
Write-Output 'Backend portátil instalado y prueba básica PyTorch CUDA superada. No se ha ejecutado inferencia H3 ni instalado modelos.'
