@echo off
setlocal
cd /d "%~dp0"
if defined VSCMD_ARG_TGT_ARCH goto build
for /f "usebackq tokens=*" %%i in (`"%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set "VSROOT=%%i"
if not defined VSROOT exit /b 2
call "%VSROOT%\VC\Auxiliary\Build\vcvars64.bat" >nul
if errorlevel 1 exit /b 2
:build
if not exist bin\win-x64 mkdir bin\win-x64
cl /nologo /std:c++17 /EHsc /O2 /MT /D_SILENCE_EXPERIMENTAL_COROUTINE_DEPRECATION_WARNINGS /DUNICODE /D_UNICODE main.cpp /Fo:bin\win-x64\main.obj /Fe:bin\win-x64\dsh-window-capture.exe /link windowsapp.lib d3d11.lib dxgi.lib windowscodecs.lib ole32.lib user32.lib dwmapi.lib
exit /b %errorlevel%
