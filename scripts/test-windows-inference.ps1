# Real, opt-in acceptance runner. It never substitutes mocked output.
# Supply API-format JSON exports for all five modes, containing model filenames
# installed on this target and references uploaded through ComfyUI's upload API.
[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$WorkflowDirectory,
  [string]$BaseUrl = 'http://127.0.0.1:8188',
  [string]$FFprobe = 'ffprobe.exe',
  [string]$ResultsDirectory = (Join-Path $PWD 'windows-inference-results'),
  [int]$TimeoutSeconds = 7200
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$uri = [Uri]$BaseUrl
if ($uri.Scheme -ne 'http' -or !$uri.IsLoopback -or $uri.UserInfo -or $uri.Query) { throw 'El backend debe usar HTTP localhost sin credenciales ni parámetros.' }
$BaseUrl = $BaseUrl.TrimEnd('/')
if ([Environment]::OSVersion.Platform -ne 'Win32NT') { throw 'Esta aceptación debe ejecutarse en Windows.' }
$WorkflowDirectory = [IO.Path]::GetFullPath($WorkflowDirectory)
$ResultsDirectory = [IO.Path]::GetFullPath($ResultsDirectory)
New-Item -ItemType Directory -Force -Path $ResultsDirectory | Out-Null
$runDirectory = Join-Path $ResultsDirectory ([DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ') + '-' + [Guid]::NewGuid().ToString('N').Substring(0,8))
New-Item -ItemType Directory -Path $runDirectory | Out-Null
$results = New-Object System.Collections.Generic.List[object]
$stats = Invoke-RestMethod -Uri "$BaseUrl/system_stats" -Method Get
$stats | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath (Join-Path $runDirectory 'system-stats.json') -Encoding UTF8
$nodeTypes = Invoke-RestMethod -Uri "$BaseUrl/object_info" -Method Get
$requiredModes = @('text-video', 'image-video', 'reference-video', 'extend-video', 'image')
foreach ($mode in $requiredModes) {
  $started = [DateTime]::UtcNow
  $record = @{ mode=$mode; status='unrun'; mocked=$false; startedAt=$started.ToString('o'); error=$null; outputs=@() }
  try {
    $workflowFile = Join-Path $WorkflowDirectory "$mode.json"
    if (!(Test-Path -LiteralPath $workflowFile -PathType Leaf)) { throw "Falta el fixture API real: $workflowFile. No se sustituirá por otro modo." }
    $graph = Get-Content -LiteralPath $workflowFile -Raw | ConvertFrom-Json
    # Accept plain API-format graph, ComfyUI API request, or Studio workflow export.
    if ($graph.PSObject.Properties.Name -contains 'prompt') { $graph = $graph.prompt }
    if ($graph.PSObject.Properties.Name -contains 'workflow') { $graph = $graph.workflow }
    if (@($graph.PSObject.Properties).Count -eq 0) { throw 'El workflow está vacío.' }
    foreach ($node in $graph.PSObject.Properties) {
      if (!($node.Value.PSObject.Properties.Name -contains 'class_type')) { throw 'Se requiere el formato API de ComfyUI, no el JSON visual del editor.' }
      if (!($nodeTypes.PSObject.Properties.Name -contains $node.Value.class_type)) { throw "Nodo no disponible: $($node.Value.class_type)" }
    }
    $body = @{ prompt=$graph; client_id=[Guid]::NewGuid().ToString() } | ConvertTo-Json -Depth 100 -Compress
    $submitted = Invoke-RestMethod -Uri "$BaseUrl/prompt" -Method Post -ContentType 'application/json' -Body ([Text.Encoding]::UTF8.GetBytes($body))
    if (!$submitted.prompt_id) { throw 'ComfyUI no devolvió prompt_id.' }
    $record.promptId = $submitted.prompt_id
    $record.status = 'running'
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    $completed = $null
    while ([DateTime]::UtcNow -lt $deadline) {
      $history = Invoke-RestMethod -Uri "$BaseUrl/history/$($submitted.prompt_id)" -Method Get
      $property = $history.PSObject.Properties[$submitted.prompt_id]
      if ($null -ne $property) {
        $completed = $property.Value
        if ($completed.status.status_str -eq 'error') { throw ('La inferencia falló: ' + ($completed.status.messages | ConvertTo-Json -Depth 30 -Compress)) }
        if ($completed.status.completed) { break }
      }
      Start-Sleep -Seconds 2
    }
    if ($null -eq $completed -or !$completed.status.completed) { throw 'Tiempo de inferencia agotado. Revisa la cola: el runner no cancela trabajos de otros clientes.' }
    $completed | ConvertTo-Json -Depth 100 | Set-Content -LiteralPath (Join-Path $runDirectory "$mode-history.json") -Encoding UTF8
    $files = New-Object System.Collections.Generic.List[object]
    foreach ($outputNode in $completed.outputs.PSObject.Properties) {
      foreach ($outputGroup in $outputNode.Value.PSObject.Properties) {
        foreach ($item in @($outputGroup.Value)) {
          if ($null -eq $item -or !($item.PSObject.Properties.Name -contains 'filename')) { continue }
          if ($item.type -ne 'output') { continue }
          $filename = [IO.Path]::GetFileName($item.filename)
          if (!$filename) { continue }
          $destination = Join-Path $runDirectory ($mode + '-' + $files.Count + '-' + $filename)
          $query = 'filename=' + [Uri]::EscapeDataString($item.filename) + '&subfolder=' + [Uri]::EscapeDataString($item.subfolder) + '&type=output'
          Invoke-WebRequest -Uri "$BaseUrl/view?$query" -OutFile $destination -UseBasicParsing
          if ((Get-Item -LiteralPath $destination).Length -le 0) { throw 'ComfyUI devolvió un archivo vacío.' }
          $probeJson = & $FFprobe -v error -show_format -show_streams -of json $destination
          if ($LASTEXITCODE -ne 0) { throw "FFprobe no puede abrir $filename." }
          $probe = ($probeJson -join "`n") | ConvertFrom-Json
          $video = @($probe.streams | Where-Object { $_.codec_type -eq 'video' })
          $audio = @($probe.streams | Where-Object { $_.codec_type -eq 'audio' })
          $files.Add(@{ path=$destination; bytes=(Get-Item -LiteralPath $destination).Length; sha256=(Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant(); videoStreams=$video.Count; audioStreams=$audio.Count; probe=$probe })
        }
      }
    }
    if ($files.Count -eq 0) { throw 'La ejecución no produjo archivos persistentes comprobables.' }
    if ($mode -ne 'image') {
      $av = @($files | Where-Object { $_.videoStreams -gt 0 -and $_.audioStreams -gt 0 })
      if ($av.Count -eq 0) { throw 'El workflow H3 no produjo un archivo audiovisual con audio nativo.' }
    }
    $record.outputs = @($files)
    $record.status = 'passed'
    Write-Output "${mode}: inferencia real completada y medios abiertos por FFprobe."
  } catch {
    $record.status = 'failed'
    $record.error = $_.Exception.Message
    Write-Warning ($mode + ': ' + $record.error)
  }
  $record.elapsedSeconds = ([DateTime]::UtcNow - $started).TotalSeconds
  $results.Add($record)
  @{ platform=[Environment]::OSVersion.VersionString; mocked=$false; tests=@($results) } | ConvertTo-Json -Depth 100 | Set-Content -LiteralPath (Join-Path $runDirectory 'results.json') -Encoding UTF8
}
$failed = @($results | Where-Object { $_.status -ne 'passed' }).Count
Write-Output ('Resultados: ' + (Join-Path $runDirectory 'results.json'))
if ($failed -gt 0) { throw "$failed de $($requiredModes.Count) pruebas no superadas. No se debe declarar aceptación completa." }
