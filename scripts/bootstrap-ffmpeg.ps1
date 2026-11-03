# Explicit opt-in portable media dependency; no system-wide install or PATH edits.
[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$Root)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ([Environment]::OSVersion.Platform -ne 'Win32NT' -or ![Environment]::Is64BitOperatingSystem) { throw 'Se requiere Windows x64.' }
$Root = [IO.Path]::GetFullPath($Root)
New-Item -ItemType Directory -Force -Path $Root | Out-Null
$target = Join-Path $Root 'ffmpeg'
$ffmpeg = Join-Path $target 'bin\ffmpeg.exe'
$ffprobe = Join-Path $target 'bin\ffprobe.exe'
if (Test-Path -LiteralPath $target) {
  if ((Test-Path -LiteralPath $ffmpeg -PathType Leaf) -and (Test-Path -LiteralPath $ffprobe -PathType Leaf)) {
    Write-Output 'FFmpeg existente conservado. No se ha sobrescrito.'
    & $ffmpeg -version
    if ($LASTEXITCODE -ne 0) { throw 'El FFmpeg existente no puede ejecutarse.' }
    & $ffprobe -version
    if ($LASTEXITCODE -ne 0) { throw 'El FFprobe existente no puede ejecutarse.' }
    @{ ffmpegPath=$ffmpeg; ffprobePath=$ffprobe } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $Root 'ffmpeg.paths.json') -Encoding UTF8
    exit 0
  }
  throw 'El directorio ffmpeg ya existe pero está incompleto. No se sobrescribirá; revisa su contenido.'
}
$tag = 'autobuild-2026-11-02-12-51'
$filename = 'ffmpeg-n8.1.3-32-g760d10603e-win64-gpl-8.1.zip'
$url = "https://github.com/BtbN/FFmpeg-Builds/releases/download/$tag/$filename"
$sha256 = '29da2b3b4f1db458df12abc04b6297be11335547fa3f39646419b9d5293dd72a'
# Authoritative checksum: same release's checksums.sha256. Never latest.
$cache = Join-Path $Root 'downloads'
New-Item -ItemType Directory -Force -Path $cache | Out-Null
$archive = Join-Path $cache ($filename + '.partial')
$curl = Join-Path $env:SystemRoot 'System32\curl.exe'
if (!(Test-Path -LiteralPath $curl -PathType Leaf)) { throw 'Falta curl.exe de Windows 11.' }
Write-Output "Origen: $url"
Write-Output 'Licencia: FFmpeg GPL v3+ (compilación BtbN GPL; véanse los avisos incluidos en el archivo).'
if (!(Test-Path -LiteralPath $archive) -or (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $sha256) {
  & $curl --fail --location --retry 3 --retry-delay 2 --connect-timeout 30 --proto '=https' --tlsv1.2 --continue-at - --output $archive $url
  if ($LASTEXITCODE -ne 0) { throw "Falló la descarga FFmpeg (curl $LASTEXITCODE); el parcial se conserva para reanudar." }
}
if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $sha256) {
  $quarantine = $archive + '.invalid-' + [DateTime]::UtcNow.ToString('yyyyMMddHHmmss')
  Move-Item -LiteralPath $archive -Destination $quarantine
  throw "SHA256 de FFmpeg incorrecto. Archivo aislado en $quarantine; no se ha ejecutado."
}
Add-Type -AssemblyName System.IO.Compression.FileSystem
$staging = Join-Path $Root ('ffmpeg-install-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $staging | Out-Null
try {
  [IO.Compression.ZipFile]::ExtractToDirectory($archive, $staging)
  $extracted = Join-Path $staging ([IO.Path]::GetFileNameWithoutExtension($filename))
  if (!(Test-Path -LiteralPath (Join-Path $extracted 'bin\ffmpeg.exe')) -or !(Test-Path -LiteralPath (Join-Path $extracted 'bin\ffprobe.exe'))) { throw 'Estructura FFmpeg inesperada.' }
  Move-Item -LiteralPath $extracted -Destination $target
} finally { if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force } }
& $ffmpeg -version
if ($LASTEXITCODE -ne 0) { throw 'El binario FFmpeg verificado no pudo ejecutarse.' }
& $ffprobe -version
if ($LASTEXITCODE -ne 0) { throw 'El binario FFprobe verificado no pudo ejecutarse.' }
@{ ffmpegPath=$ffmpeg; ffprobePath=$ffprobe; source=$url; archiveSha256=$sha256 } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $Root 'ffmpeg.paths.json') -Encoding UTF8
Write-Output 'FFmpeg y FFprobe portátiles instalados y comprobados con -version.'
