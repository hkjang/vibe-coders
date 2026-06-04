<#
.SYNOPSIS
운영 중인 게이트웨이 데이터(SQLite 파일 + fallback ndjson)를 안전하게 백업합니다.

.DESCRIPTION
1. data/ 폴더의 SQLite 파일을 .backup 명령으로 일관성 있는 사본으로 만든 뒤
2. fallback ndjson + provider audit 도 함께 묶어
3. backups/<yyyymmdd-HHmm>.tar.gz 로 압축하고
4. -KeepDays 만큼만 남기고 오래된 백업을 정리합니다.

.PARAMETER DataDir
대상 데이터 디렉토리. 기본값은 ./data .

.PARAMETER OutDir
백업 산출 디렉토리. 기본값은 ./backups .

.PARAMETER KeepDays
보존 일수. 기본 14일.

.EXAMPLE
pwsh -File scripts/backup.ps1
#>
[CmdletBinding()]
param(
    [string]$DataDir = "data",
    [string]$OutDir  = "backups",
    [int]$KeepDays  = 14
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

if (-not (Test-Path $DataDir)) {
    throw "$DataDir 가 존재하지 않습니다."
}
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$stamp     = (Get-Date).ToString("yyyyMMdd-HHmm")
$workDir   = Join-Path ([System.IO.Path]::GetTempPath()) ("gateway-backup-" + $stamp)
$payload   = Join-Path $workDir "data"
$outArchive = Join-Path $OutDir "gateway-$stamp.tar.gz"
New-Item -ItemType Directory -Force -Path $payload | Out-Null

try {
    $sqliteFile = Join-Path $DataDir "gateway.db"
    if (Test-Path $sqliteFile) {
        $sqliteBackup = Join-Path $payload "gateway.db"
        if (Get-Command sqlite3 -ErrorAction SilentlyContinue) {
            Write-Host "[1/3] sqlite3 .backup 으로 일관 사본 생성"
            & sqlite3 $sqliteFile ".backup '$sqliteBackup'"
            if ($LASTEXITCODE -ne 0) { throw "sqlite3 .backup 실패" }
        } else {
            Write-Warning "sqlite3 가 PATH 에 없습니다 - file copy 로 대체 (락 위험)"
            Copy-Item $sqliteFile $sqliteBackup -Force
        }
    } else {
        Write-Warning "$sqliteFile 가 없습니다 - SQLite 백업 생략"
    }

    foreach ($extra in @("fallback.ndjson", "audit.ndjson")) {
        $src = Join-Path $DataDir $extra
        if (Test-Path $src) {
            Copy-Item $src (Join-Path $payload $extra) -Force
        }
    }

    Write-Host "[2/3] tar.gz 묶기 -> $outArchive"
    if (Get-Command tar -ErrorAction SilentlyContinue) {
        tar -czf $outArchive -C $workDir "data"
        if ($LASTEXITCODE -ne 0) { throw "tar 실패" }
    } else {
        # tar 가 없으면 zip 으로 대체
        $outZip = [System.IO.Path]::ChangeExtension($outArchive, ".zip")
        Compress-Archive -Path (Join-Path $payload "*") -DestinationPath $outZip -Force
        $outArchive = $outZip
    }

    Write-Host "[3/3] $KeepDays 일 보존 정책 적용"
    $cutoff = (Get-Date).AddDays(-$KeepDays)
    Get-ChildItem $OutDir -File | Where-Object { $_.LastWriteTime -lt $cutoff } | ForEach-Object {
        Write-Host "  삭제: $($_.Name)"
        Remove-Item $_.FullName -Force
    }
}
finally {
    if (Test-Path $workDir) { Remove-Item $workDir -Recurse -Force }
}

Write-Host ""
Write-Host "백업 완료: $outArchive" -ForegroundColor Green
