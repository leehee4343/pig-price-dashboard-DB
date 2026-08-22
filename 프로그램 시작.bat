@echo off
:: CMD 한글 깨짐 방지를 위해 코드페이지를 UTF-8로 전환
chcp 65001 > nul
title 돼지 거래가격 대시보드 프로그램 구동

echo ===================================================
echo   돼지 거래가격정보 통계/분석 대시보드 구동기
echo ===================================================
echo.

:: 3000번 포트가 이미 사용 중인지 확인
netstat -ano | findstr :3000 > nul
if %errorlevel% equ 0 (
    echo [안내] 대시보드 서버가 이미 백그라운드에서 실행 중입니다.
    echo [안내] 기본 브라우저를 열어 화면을 띄웁니다...
    echo.
    start http://localhost:3000
    timeout /t 3 > nul
) else (
    echo [안내] 대시보드 서버를 시작합니다...
    echo [안내] 기본 브라우저를 열어 화면을 띄웁니다...
    echo.
    :: 브라우저 오픈
    start http://localhost:3000
    :: Express Node.js 서버 실행
    node server.js
)
