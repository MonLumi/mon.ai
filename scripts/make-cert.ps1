# Creates the HTTPS certificate for mon.ai (local use only) and trusts it for your Windows user.
#
# - Self-signed, valid for mon.ai, localhost and 127.0.0.1 only, for 2 years.
# - Marked "not a certificate authority" (CA=false): even though it's trusted, it can't be used
#   to vouch for any other website.
# - Trusted in CurrentUser\Root (your account only, not the whole machine). Windows shows a
#   security prompt for this; click Yes.
# - The private key is saved only to data\tls\mon.ai.pfx (password in data\tls\pfx-pass.txt) and
#   removed from the Windows certificate store.
#
# Run from the mon-ai folder:   npm run cert
# Re-running replaces the certificate (the old one is removed from your trusted list).

$ErrorActionPreference = 'Stop'
$dir = Join-Path $PSScriptRoot '..\data\tls'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$dir = (Resolve-Path $dir).Path

# Remove certificates from a previous run (matched by our friendly name).
foreach ($store in 'Cert:\CurrentUser\My', 'Cert:\CurrentUser\Root') {
  Get-ChildItem $store | Where-Object { $_.FriendlyName -eq 'mon.ai local HTTPS' } | ForEach-Object {
    Write-Host "Removing old certificate $($_.Thumbprint) from $store"
    Remove-Item $_.PSPath
  }
}

$cert = New-SelfSignedCertificate `
  -Subject 'CN=mon.ai' `
  -FriendlyName 'mon.ai local HTTPS' `
  -CertStoreLocation 'Cert:\CurrentUser\My' `
  -KeyAlgorithm RSA -KeyLength 2048 -HashAlgorithm SHA256 `
  -KeyUsage DigitalSignature, KeyEncipherment `
  -KeyExportPolicy Exportable `
  -NotAfter (Get-Date).AddYears(2) `
  -TextExtension @(
    '2.5.29.17={text}DNS=mon.ai&DNS=localhost&IPAddress=127.0.0.1',  # names it is valid for
    '2.5.29.37={text}1.3.6.1.5.5.7.3.1',                              # server authentication only
    '2.5.29.19={critical}{text}ca=0'                                  # not a certificate authority
  )

# Private key + certificate for the Node server, protected by a random password.
$pass = -join ((48..57) + (65..90) + (97..122) | Get-Random -Count 32 | ForEach-Object { [char]$_ })
Set-Content -Path (Join-Path $dir 'pfx-pass.txt') -Value $pass -NoNewline
Export-PfxCertificate -Cert $cert -FilePath (Join-Path $dir 'mon.ai.pfx') -Password (ConvertTo-SecureString $pass -AsPlainText -Force) | Out-Null

# Trust the public certificate for this Windows user (Edge and Chrome use this store).
$cer = Join-Path $dir 'mon.ai.cer'
Export-Certificate -Cert $cert -FilePath $cer | Out-Null
Write-Host 'Windows will now ask you to confirm trusting the mon.ai certificate. Click Yes.' -ForegroundColor Yellow
Import-Certificate -FilePath $cer -CertStoreLocation 'Cert:\CurrentUser\Root' | Out-Null

# The key only needs to live in the .pfx file.
Remove-Item "Cert:\CurrentUser\My\$($cert.Thumbprint)"

Write-Host ''
Write-Host "Done. Certificate $($cert.Thumbprint), valid until $($cert.NotAfter.ToString('d MMM yyyy'))." -ForegroundColor Green
Write-Host 'Restart mon.ai (npm start) and open https://mon.ai'
