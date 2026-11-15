@echo off
chcp 65001 >nul
cd /d "%~dp0"
start "" http://localhost:8765
echo Repeat It: http://localhost:8765  (close this window to stop)
python -m http.server 8765 2>nul || py -m http.server 8765
