<#
.SYNOPSIS
  Golden Prompt regression gate for CI (PowerShell).
.DESCRIPTION
  Runs every golden prompt registered in the gateway against the given model(s)
  and exits non-zero when the pass rate drops below the threshold, so model or
  prompt changes that regress known-good behaviour fail the build.
.EXAMPLE
  $env:GATEWAY_URL="http://localhost:8080"; $env:ADMIN_TOKEN="..."
  ./scripts/golden-regression.ps1 -Models "gpt-4.1-mini,gpt-4.1" -MinPassRate 1.0
#>
param(
  [string]$Models = $env:GOLDEN_MODELS,
  [double]$MinPassRate = 1.0,
  [string]$Tag = ""
)
$ErrorActionPreference = "Stop"

$gateway = if ($env:GATEWAY_URL) { $env:GATEWAY_URL } else { "http://localhost:8080" }
if ([string]::IsNullOrWhiteSpace($Models)) {
  Write-Error "no models given (-Models or `$env:GOLDEN_MODELS)"; exit 2
}

$modelList = $Models.Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ }
$body = @{ models = @($modelList); min_pass_rate = $MinPassRate }
if ($Tag) { $body.tag = $Tag }
$json = $body | ConvertTo-Json -Compress

$headers = @{ "Content-Type" = "application/json" }
if ($env:ADMIN_TOKEN) { $headers["Authorization"] = "Bearer $($env:ADMIN_TOKEN)" }

Write-Host "Running golden regression against: $Models (min_pass_rate=$MinPassRate$(if($Tag){", tag=$Tag"}))"
try {
  $resp = Invoke-WebRequest -Uri "$gateway/admin/golden-prompts/run?fail_on_regression=1" `
    -Method Post -Headers $headers -Body $json -SkipHttpErrorCheck
} catch {
  Write-Error "gateway request failed: $_"; exit 1
}

Write-Host $resp.Content
if ($resp.StatusCode -eq 422) {
  Write-Error "Golden prompt regression detected (pass rate below $MinPassRate)."; exit 1
}
if ($resp.StatusCode -ne 200) {
  Write-Error "gateway returned HTTP $($resp.StatusCode)"; exit 1
}
Write-Host "Golden regression gate passed."
