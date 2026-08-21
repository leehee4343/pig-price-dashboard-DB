const fs = require('fs');
const path = require('path');
const { readRowsFromFile, computeDashboardData, injectIntoHtml } = require('./lib/aggregate');

// 엑셀 파일 탐색: 정확한 파일명 대신 접두어로 찾는다(조사기간이 바뀌거나 "(new)"처럼
// 파일명이 매번 달라질 수 있어서). 같은 접두어의 파일이 여러 개면 가장 최근에 수정된
// 파일을 최신본으로 사용한다.
function findLatestExcel(prefix) {
  const candidates = fs.readdirSync(__dirname)
    .filter(f => f.startsWith(prefix) && f.toLowerCase().endsWith('.xlsx'))
    .map(f => ({ name: f, mtime: fs.statSync(path.join(__dirname, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return candidates.length ? path.join(__dirname, candidates[0].name) : null;
}

const priceFile = findLatestExcel('돼지 거래가격정보');
const companyFile = findLatestExcel('업체정보');

if (!priceFile || !companyFile) {
  console.error('Error: Required Excel files do not exist in the directory.');
  console.error('Expected file name prefixes:\n- 돼지 거래가격정보*.xlsx\n- 업체정보*.xlsx');
  process.exit(1);
}
console.log(`- 가격정보 파일: ${path.basename(priceFile)}`);
console.log(`- 업체정보 파일: ${path.basename(companyFile)}`);

console.log('1. Reading Excel files...');
const priceRows = readRowsFromFile(priceFile);
const companyRows = readRowsFromFile(companyFile);

console.log(`- Price dataset: ${priceRows.length} rows`);
console.log(`- Company dataset: ${companyRows.length} rows`);

console.log('2. Processing dashboard statistics...');
const { DATA, publicCompanyRows } = computeDashboardData(priceRows, companyRows);

console.log('3. Injecting new datasets into index.html...');
const htmlPath = path.join(__dirname, 'index.html');
if (!fs.existsSync(htmlPath)) {
  console.error(`Error: index.html not found at ${htmlPath}`);
  process.exit(1);
}

const htmlContent = fs.readFileSync(htmlPath, 'utf8');
const newHtmlContent = injectIntoHtml(htmlContent, DATA, priceRows, publicCompanyRows);

fs.writeFileSync(htmlPath, newHtmlContent, 'utf8');
console.log('🟢 Success: index.html has been updated with the compiled Excel data!');
