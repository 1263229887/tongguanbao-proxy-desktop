@echo off
setlocal
cd /d E:\Projects\tongguanbao-proxy-desktop
set "MIMO_NODE=E:\xiaomiMiMo\Xiaomi MiMo\resources\runtimes\win32-x64\node\node.exe"
echo [%date% %time%] start local pack > pack-local.log
"%MIMO_NODE%" scripts\build.mjs --env=test --platforms=win >> pack-local.log 2>&1
echo [%date% %time%] exit=%errorlevel% >> pack-local.log
endlocal
