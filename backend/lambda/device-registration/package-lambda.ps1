# PowerShell script to package AWS Lambda function into function.zip
$ErrorActionPreference = "Stop"

$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $dir

Write-Host "Packaging AWS Lambda function..." -ForegroundColor Cyan

# Remove old zip if present
if (Test-Path "function.zip") {
    Remove-Item "function.zip" -Force
}

# Compress files
$filesToCompress = @("index.js", "package.json", "node_modules")
Compress-Archive -Path $filesToCompress -DestinationPath "function.zip" -CompressionLevel Optimal

Write-Host "Success! Created: $(Join-Path $dir 'function.zip')" -ForegroundColor Green
Write-Host "You can now upload 'function.zip' directly to AWS Lambda in the AWS Console." -ForegroundColor Yellow
