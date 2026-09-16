# Launcher: start dev without inheriting ELECTRON_RUN_AS_NODE
Set-Location "E:\Projects\tongguanbao-proxy-desktop"
if ($env:ELECTRON_RUN_AS_NODE) { Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue }
$env:MIMO_NODE_MODULES = ""
$node = "E:\xiaomiMiMo\Xiaomi MiMo\resources\runtimes\win32-x64\node\node.exe"
& $node scripts\dev.mjs
