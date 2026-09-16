@echo off
setlocal
cd /d E:\Projects\tongguanbao-proxy-desktop
set "ELECTRON_RUN_AS_NODE="
set "ELECTRON_RENDERER_URL="
echo [%date% %time%] starting pnpm-run-dev equivalent > dev-start.log
"E:\xiaomiMiMo\Xiaomi MiMo\resources\runtimes\win32-x64\node\node.exe" scripts\dev.mjs >> dev-start.log 2>&1
echo [%date% %time%] exit=%errorlevel% >> dev-start.log
endlocal
