$port = 3100

$ipv4List = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
  Where-Object {
    $_.IPAddress -notlike "127.*" -and
    $_.IPAddress -notlike "169.254.*" -and
    $_.PrefixOrigin -ne "WellKnown"
  } |
  Select-Object -ExpandProperty IPAddress -Unique

if (-not $ipv4List) {
  Write-Output "Server started."
  Write-Output "Open locally: http://127.0.0.1:$port"
  exit 0
}

Write-Output ""
Write-Output "Server started."
Write-Output "Local: http://127.0.0.1:$port"
Write-Output ""
Write-Output "LAN URLs:"
$ipv4List | ForEach-Object { Write-Output ("http://{0}:{1}" -f $_, $port) }
Write-Output ""
Write-Output "Let coworkers open one of the LAN URLs on the same office network."
