[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

Set-Location -Path $PSScriptRoot

Write-Host "================================================"
Write-Host "  돼지 거래가격 대시보드 - 엑셀 데이터 업데이트"
Write-Host "================================================"
Write-Host ""
Write-Host "이 폴더($PSScriptRoot)에서"
Write-Host "'돼지 거래가격정보'로 시작하는 xlsx 파일과"
Write-Host "'업체정보'로 시작하는 xlsx 파일 중"
Write-Host "가장 최근에 수정된 파일을 자동으로 찾아서 반영합니다."
Write-Host "(파일명은 예전 파일과 달라도 상관없습니다.)"
Write-Host ""
Write-Host "새 엑셀 파일을 이미 이 폴더에 넣어두셨다면 Enter를 눌러 계속하세요."
Write-Host "아직이라면 지금 이 창을 닫고 파일을 넣은 뒤 다시 실행해주세요."
Read-Host "계속하려면 Enter"

Write-Host ""
Write-Host "[1/3] 엑셀 데이터를 읽어서 대시보드에 반영하는 중..."
Write-Host "------------------------------------------------"
npm run update
Write-Host "------------------------------------------------"
if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "[오류] 데이터 반영에 실패했습니다. 위 오류 메시지를 확인해주세요."
    Read-Host "종료하려면 Enter"
    exit 1
}

Write-Host ""
Write-Host "[2/3] 위에 표시된 '가격정보 파일 / 업체정보 파일' 이름과 행(row) 수를 확인하세요."
Write-Host "  - 파일명이 방금 넣으신 새 파일이 맞는지"
Write-Host "  - 행 수가 너무 적거나 이상하지 않은지 (시트 범위 보정 경고가 떴다면 정상 보정된 것입니다)"
Write-Host ""
Write-Host "문제없으면 Enter를 눌러 GitHub 반영을 계속 진행합니다."
Write-Host "이상하면 지금 이 창을 닫아 중단하세요 (여기까지는 아직 GitHub에 반영되지 않았습니다)."
Read-Host "계속하려면 Enter"

Write-Host ""
Write-Host "[3/3] GitHub(공개 배포 사이트)에 반영하는 중..."
git add index.html
$commitMsg = "데이터 갱신 (엑셀 업데이트 스크립트 실행, $(Get-Date -Format 'yyyy-MM-dd HH:mm'))"
git commit -m $commitMsg
if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "커밋할 변경사항이 없습니다. (엑셀 내용이 이전과 동일하거나 이미 반영된 상태일 수 있습니다.)"
    Read-Host "종료하려면 Enter"
    exit 0
}

git push origin master
if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "[오류] GitHub 업로드에 실패했습니다. 인터넷 연결 상태를 확인하거나, 문의해주세요."
    Read-Host "종료하려면 Enter"
    exit 1
}

Write-Host ""
Write-Host "================================================"
Write-Host "  완료되었습니다!"
Write-Host "  몇 분 내로 아래 웹사이트에 새 데이터가 반영됩니다."
Write-Host "  https://leehee4343.github.io/pig-price-dashboard/"
Write-Host "================================================"
Read-Host "종료하려면 Enter"
