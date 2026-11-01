@echo off
REM ============================================================
REM  琴湖基地智慧农业数字孪生 —— 一键启动
REM  用法：双击本文件，或在此目录执行 start.bat
REM ============================================================
chcp 65001 >nul
cd /d "%~dp0"

set PY=python
where python >nul 2>nul
if errorlevel 1 (
    echo [错误] 未找到 python，请确认已安装 Python 3.10+ 并加入 PATH
    pause
    exit /b 1
)

REM 首次运行自动安装依赖
python -c "import fastapi, uvicorn" >nul 2>nul
if errorlevel 1 (
    echo [1/3] 首次运行，正在安装依赖...
    python -m pip install -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple
)

echo.
echo  琴湖基地 · 智慧农业数字孪生
echo  ---------------------------------------------
echo   完整大屏： http://127.0.0.1:8848/
echo   纯模型：   http://127.0.0.1:8848/model.html
echo   按 Ctrl+C 停止服务
echo  ---------------------------------------------
echo.

start "" http://127.0.0.1:8848
python -m uvicorn backend.app:app --host 127.0.0.1 --port 8848
pause
