const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');

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

// 일부 외부 시스템이 내보낸 엑셀은 시트의 <dimension> 메타데이터가 실제 데이터 범위보다
// 작게 남아있는 경우가 있다(예: 실제로는 4,700행인데 A1:R3로 기록됨). 이 값을 그대로 믿으면
// SheetJS가 뒤쪽 데이터를 통째로 못 읽으므로, 실제로 존재하는 셀 좌표를 스캔해 범위를 다시 계산한다.
function fixSheetRange(ws) {
  let minR = Infinity, minC = Infinity, maxR = -1, maxC = -1;
  Object.keys(ws).forEach(key => {
    if (key[0] === '!') return;
    const { r, c } = XLSX.utils.decode_cell(key);
    if (r < minR) minR = r;
    if (c < minC) minC = c;
    if (r > maxR) maxR = r;
    if (c > maxC) maxC = c;
  });
  if (maxR < 0) return;
  const trueRef = XLSX.utils.encode_range({ s: { r: minR, c: minC }, e: { r: maxR, c: maxC } });
  if (trueRef !== ws['!ref']) {
    console.warn(`  ⚠ 시트 범위 보정: ${ws['!ref'] || '(없음)'} → ${trueRef}`);
    ws['!ref'] = trueRef;
  }
}

console.log('1. Reading Excel files...');
function readRows(filePath) {
  const workbook = XLSX.readFile(filePath);
  const sheetName = workbook.SheetNames[0];
  const worksheet = workbook.Sheets[sheetName];
  fixSheetRange(worksheet);
  return XLSX.utils.sheet_to_json(worksheet, {header: 1});
}

const priceRows = readRows(priceFile);
const companyRows = readRows(companyFile);

// 브라우저 집계에 필요한 업체명·시도명·사용여부만 내장한다.
// 연락처·사업자번호·API 키 등 업체 원본의 민감정보는 정적 HTML에 포함하지 않는다.
const PUBLIC_COMPANY_FIELDS = ['업체명', '시도명', '사용여부'];
const companyHeaders = companyRows[0] || [];
const publicCompanyRows = [PUBLIC_COMPANY_FIELDS];
for (let i = 1; i < companyRows.length; i++) {
  const row = companyRows[i] || [];
  publicCompanyRows.push(PUBLIC_COMPANY_FIELDS.map(field => row[companyHeaders.indexOf(field)] ?? ''));
}

console.log(`- Price dataset: ${priceRows.length} rows`);
console.log(`- Company dataset: ${companyRows.length} rows`);

// ================= 집계 연산 로직 (index.html과 정렬) =================
const TEST_COMPANIES = ['돼지거래test'];
const REGION_GROUP_MAP = {
  '서울':'수도권', '인천':'수도권', '경기':'수도권',
  '강원':'강원권',
  '대전':'충청권', '세종':'충청권', '충남':'충청권', '충북':'충청권',
  '부산':'경상권', '대구':'경상권', '울산':'경상권', '경남':'경상권', '경북':'경상권',
  '광주':'전라권', '전남':'전라권', '전북':'전라권',
  '제주':'전라권'
};
function regionGroupOf(sido){ return REGION_GROUP_MAP[sido] || '기타'; }

// 주간 날짜 계산용 헬퍼 (해당 일요일 날짜 문자열 반환)
function getSundayDateString(dateStr) {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return '기타';
  const day = d.getDay();
  const diff = d.getDate() - day;
  const sunday = new Date(d.setDate(diff));
  
  const yyyy = sunday.getFullYear();
  let mm = sunday.getMonth() + 1;
  let dd = sunday.getDate();
  if (mm < 10) mm = '0' + mm;
  if (dd < 10) dd = '0' + dd;
  return `${yyyy}-${mm}-${dd}`;
}

console.log('2. Processing dashboard statistics...');

// 1. 업체 정보 매핑
const companyRegionMap = {};
const allRegisteredCompanies = new Set();

const compHeaders = companyRows[0] || [];
const compNameIdx = compHeaders.indexOf('업체명');
const compRegionIdx = compHeaders.indexOf('시도명');
const compUseIdx = compHeaders.indexOf('사용여부');

for (let i = 1; i < companyRows.length; i++) {
  const row = companyRows[i];
  if (!row || row.length === 0) continue;
  const name = row[compNameIdx];
  const region = row[compRegionIdx] || '';
  const useYn = row[compUseIdx] || 'Y';
  if (name && useYn === 'Y' && !TEST_COMPANIES.includes(name)) {
    companyRegionMap[name] = regionGroupOf(region);
    allRegisteredCompanies.add(name);
  }
}

// 2. 가격 정보 파싱
const validRows = [];
const rawDataQualityAnomalyList = [];
let nullRateCount = 0;

const fieldDefs = [
  { key: '두수(생돈매입)', idx: 2 },
  { key: '생체중계(kg)', idx: 3 },
  { key: '총거래금액(원)', idx: 4 },
  { key: '지급률(%)', idx: 5 },
  { key: '도체두수(계)', idx: 6 },
  { key: '도체중(계,kg)', idx: 7 },
  { key: '암 두수', idx: 8 },
  { key: '암 도체중(kg)', idx: 9 },
  { key: '거세 두수', idx: 10 },
  { key: '거세 도체중(kg)', idx: 11 },
  { key: '수 두수', idx: 12 },
  { key: '수 도체중(kg)', idx: 13 },
  { key: '적용단가 유형', idx: 14 },
  { key: '적용단가(원/kg)', idx: 15 }
];
const companyFieldMissingCounts = {};
const isBlank = v => v === null || v === undefined || v === '';

for (let i = 3; i < priceRows.length; i++) {
  const r = priceRows[i];
  if (!r || r.length < 2) continue;
  
  const company = r[0];
  const dateStr = r[1];
  if (!company || !dateStr) continue;
  if (TEST_COMPANIES.includes(company)) continue;
  
  let regDateStr = dateStr;
  if (r[16]) {
    const match = String(r[16]).match(/^(\d{4}-\d{2}-\d{2})/);
    if (match) regDateStr = match[1];
  }

  const region = companyRegionMap[company] || '기타';

  const parseNum = val => {
    if (val === null || val === undefined || val === '') return 0;
    if (typeof val === 'number') return val;
    return parseFloat(String(val).replace(/,/g, '')) || 0;
  };
  
  const headCount = parseNum(r[2]);
  const liveWeight = parseNum(r[3]);
  const totalAmount = parseNum(r[4]);
  const paymentRate = (r[5] !== null && r[5] !== undefined && r[5] !== '') ? parseFloat(r[5]) : null;
  const carcassHead = parseNum(r[6]);
  const carcassWeight = parseNum(r[7]);
  
  const femaleHead = parseNum(r[8]);
  const femaleWeight = parseNum(r[9]);
  const castratedHead = parseNum(r[10]);
  const castratedWeight = parseNum(r[11]);
  const maleHead = parseNum(r[12]);
  const maleWeight = parseNum(r[13]);
  
  const unitPrice = liveWeight > 0 ? totalAmount / liveWeight : 0;

  if (paymentRate === null) {
    nullRateCount++;
  }

  if (!companyFieldMissingCounts[company]) {
    companyFieldMissingCounts[company] = {};
    fieldDefs.forEach(f => { companyFieldMissingCounts[company][f.key] = 0; });
  }
  fieldDefs.forEach(f => {
    if (isBlank(r[f.idx])) {
      companyFieldMissingCounts[company][f.key]++;
    }
  });

  const rowObj = {
    company,
    date: dateStr,
    regDate: regDateStr,
    headCount,
    liveWeight,
    totalAmount,
    paymentRate,
    carcassHead,
    carcassWeight,
    femaleHead,
    femaleWeight,
    castratedHead,
    castratedWeight,
    maleHead,
    maleWeight,
    unitPrice,
    region
  };
  
  validRows.push(rowObj);
  
  if (unitPrice > 0 && (unitPrice < 2500 || unitPrice > 9000)) {
    rawDataQualityAnomalyList.push({
      업체: company,
      조사일자: dateStr,
      등록일자: r[16] || dateStr,
      두수: headCount,
      생체중: liveWeight,
      총거래금액: totalAmount,
      kg당가격: unitPrice
    });
  }
}

// 3. 통계 집계 산출
let totalAmountSum = 0;
let totalHeadSum = 0;
let totalLiveWeightSum = 0;
let totalCarcassWeightSum = 0;
let unitPriceWeightedSum = 0;

let validPaymentRateSum = 0;
let validPaymentRateCount = 0;

const uniqueCompanies = new Set();
const dateList = [];

let femaleHeadSum = 0;
let castratedHeadSum = 0;
let maleHeadSum = 0;
let femaleWeightSum = 0;
let castratedWeightSum = 0;
let maleWeightSum = 0;

const monthlyGroup = {};
const weeklyGroup = {};
const dailyGroup = {};
const companyGroup = {};
const regionGroup = {};

validRows.forEach(r => {
  totalAmountSum += r.totalAmount;
  totalHeadSum += r.headCount;
  totalLiveWeightSum += r.liveWeight;
  totalCarcassWeightSum += r.carcassWeight;
  unitPriceWeightedSum += (r.unitPrice * r.liveWeight);
  
  if (r.paymentRate !== null) {
    validPaymentRateSum += r.paymentRate;
    validPaymentRateCount++;
  }
  
  uniqueCompanies.add(r.company);
  dateList.push(new Date(r.date));
  
  femaleHeadSum += r.femaleHead;
  femaleWeightSum += r.femaleWeight;
  castratedHeadSum += r.castratedHead;
  castratedWeightSum += r.castratedWeight;
  maleHeadSum += r.maleHead;
  maleWeightSum += r.maleWeight;
  
  const ym = r.date.substring(0, 7);
  if (!monthlyGroup[ym]) {
    monthlyGroup[ym] = { ym, count: 0, head: 0, live: 0, amount: 0, rateSum: 0, rateCount: 0, priceWeighted: 0 };
  }
  monthlyGroup[ym].count++;
  monthlyGroup[ym].head += r.headCount;
  monthlyGroup[ym].live += r.liveWeight;
  monthlyGroup[ym].amount += r.totalAmount;
  monthlyGroup[ym].priceWeighted += (r.unitPrice * r.liveWeight);
  if (r.paymentRate !== null) {
    monthlyGroup[ym].rateSum += r.paymentRate;
    monthlyGroup[ym].rateCount++;
  }
  
  const sunStr = getSundayDateString(r.date);
  if (!weeklyGroup[sunStr]) {
    weeklyGroup[sunStr] = { week: sunStr, count: 0, head: 0, amount: 0, live: 0, carcass: 0, rateSum: 0, rateCount: 0 };
  }
  weeklyGroup[sunStr].count++;
  weeklyGroup[sunStr].head += r.headCount;
  weeklyGroup[sunStr].amount += r.totalAmount;
  weeklyGroup[sunStr].live += r.liveWeight;
  weeklyGroup[sunStr].carcass += r.carcassWeight;
  if (r.paymentRate !== null) {
    weeklyGroup[sunStr].rateSum += r.paymentRate;
    weeklyGroup[sunStr].rateCount++;
  }

  if (!dailyGroup[r.date]) {
    dailyGroup[r.date] = { day: r.date, count: 0, head: 0, amount: 0, live: 0, carcass: 0, rateSum: 0, rateCount: 0 };
  }
  dailyGroup[r.date].count++;
  dailyGroup[r.date].head += r.headCount;
  dailyGroup[r.date].amount += r.totalAmount;
  dailyGroup[r.date].live += r.liveWeight;
  dailyGroup[r.date].carcass += r.carcassWeight;
  if (r.paymentRate !== null) {
    dailyGroup[r.date].rateSum += r.paymentRate;
    dailyGroup[r.date].rateCount++;
  }

  if (!companyGroup[r.company]) {
    companyGroup[r.company] = {
      name: r.company, count: 0, head: 0, live: 0, amount: 0,
      rateSum: 0, rateCount: 0, prices: [], region: r.region, lastRegDate: r.regDate, dateSet: new Set()
    };
  }
  companyGroup[r.company].count++;
  companyGroup[r.company].head += r.headCount;
  companyGroup[r.company].live += r.liveWeight;
  companyGroup[r.company].amount += r.totalAmount;
  companyGroup[r.company].prices.push(r.unitPrice);
  companyGroup[r.company].dateSet.add(r.date);
  if (r.regDate > companyGroup[r.company].lastRegDate) {
    companyGroup[r.company].lastRegDate = r.regDate;
  }
  if (r.paymentRate !== null) {
    companyGroup[r.company].rateSum += r.paymentRate;
    companyGroup[r.company].rateCount++;
  }
  
  if (!regionGroup[r.region]) {
    regionGroup[r.region] = { name: r.region, count: 0, head: 0, live: 0, amount: 0, comps: new Set(), priceWeighted: 0 };
  }
  regionGroup[r.region].count++;
  regionGroup[r.region].head += r.headCount;
  regionGroup[r.region].live += r.liveWeight;
  regionGroup[r.region].amount += r.totalAmount;
  regionGroup[r.region].comps.add(r.company);
  regionGroup[r.region].priceWeighted += (r.unitPrice * r.liveWeight);
});

dateList.sort((a,b)=>a-b);
const formatDate = d => {
  const y = d.getFullYear();
  let m = d.getMonth() + 1;
  let dd = d.getDate();
  return `${y}-${m < 10 ? '0'+m : m}-${dd < 10 ? '0'+dd : dd}`;
};
const startDateStr = dateList.length > 0 ? formatDate(dateList[0]) : '';
const endDateStr = dateList.length > 0 ? formatDate(dateList[dateList.length - 1]) : '';

const avgPaymentRateGlobal = validPaymentRateCount > 0 ? parseFloat((validPaymentRateSum / validPaymentRateCount).toFixed(2)) : 0;
const avgCarcassRateGlobal = totalLiveWeightSum > 0 ? parseFloat((totalCarcassWeightSum / totalLiveWeightSum * 100).toFixed(2)) : 0;

const monthlyList = Object.values(monthlyGroup).map(g => ({
  "연월": g.ym,
  "거래건수": g.count,
  "총두수": g.head,
  "총생체중": g.live,
  "총거래금액": g.amount,
  "평균지급률": g.rateCount > 0 ? g.rateSum / g.rateCount : null,
  "평균kg당가격": g.live > 0 ? Math.round(g.priceWeighted / g.live) : 0
})).sort((a,b)=>a.연월.localeCompare(b.연월));

const weeklyList = Object.values(weeklyGroup).map(g => ({
  "주": g.week,
  "거래건수": g.count,
  "총두수": g.head,
  "총생체중": g.live,
  "총거래금액": g.amount,
  "평균단가": g.live > 0 ? Math.round(g.amount / g.live) : 0,
  "도체율": g.live > 0 ? parseFloat((g.carcass / g.live * 100).toFixed(2)) : 0,
  "평균지급률": g.rateCount > 0 ? parseFloat((g.rateSum / g.rateCount).toFixed(2)) : null
})).sort((a,b)=>a.주.localeCompare(b.주));

const dailyList = Object.values(dailyGroup).map(g => ({
  "일자": g.day,
  "거래건수": g.count,
  "총두수": g.head,
  "총생체중": g.live,
  "총거래금액": g.amount,
  "평균kg당가격": g.live > 0 ? Math.round(g.amount / g.live) : 0,
  "도체율": g.live > 0 ? parseFloat((g.carcass / g.live * 100).toFixed(2)) : 0,
  "평균지급률": g.rateCount > 0 ? parseFloat((g.rateSum / g.rateCount).toFixed(2)) : null
})).sort((a,b)=>a.일자.localeCompare(b.일자));

const companyList = Object.values(companyGroup).map(g => {
  const meanPrice = g.live > 0 ? g.amount / g.live : 0;
  let variance = 0;
  if (g.prices.length > 1) {
    const avg = g.prices.reduce((sum,p)=>sum+p, 0) / g.prices.length;
    const squaredDiffs = g.prices.map(p => Math.pow(p - avg, 2));
    variance = squaredDiffs.reduce((sum,v)=>sum+v, 0) / (g.prices.length - 1);
  }
  const stdDev = Math.sqrt(variance);
  
  return {
    "업체": g.name,
    "거래건수": g.count,
    "총두수": g.head,
    "총생체중": g.live,
    "총거래금액": g.amount,
    "평균지급률": g.rateCount > 0 ? parseFloat((g.rateSum / g.rateCount).toFixed(2)) : null,
    "권역": g.region,
    "평균kg당가격": Math.round(meanPrice),
    "가격변동성": parseFloat(stdDev.toFixed(1)),
    "거래일수": g.dateSet.size
  };
});

const NON_REQUIRED_FIELD_KEYS = ['암 두수', '암 도체중(kg)', '거세 두수', '거세 도체중(kg)', '수 두수', '수 도체중(kg)'];
const requiredFieldDefs = fieldDefs.filter(f => !NON_REQUIRED_FIELD_KEYS.includes(f.key));
const companyFieldQualityList = Object.values(companyGroup)
  .sort((a,b)=>b.count-a.count)
  .map(g => {
    const missingByField = companyFieldMissingCounts[g.name] || {};
    const 항목목록 = requiredFieldDefs.map(f => {
      const missing = missingByField[f.key] || 0;
      const filled = g.count - missing;
      return {
        "항목": f.key,
        "입력건수": filled,
        "총건수": g.count,
        "입력비율": g.count > 0 ? parseFloat((filled / g.count * 100).toFixed(1)) : 0
      };
    });
    return { "업체": g.name, "총건수": g.count, "최근등록일": g.lastRegDate, "항목목록": 항목목록 };
  });

const regionList = Object.values(regionGroup).map(g => ({
  "권역": g.name,
  "거래건수": g.count,
  "총두수": g.head,
  "총생체중": g.live,
  "총거래금액": g.amount,
  "업체수": g.comps.size,
  "평균kg당가격": g.live > 0 ? Math.round(g.priceWeighted / g.live) : 0
})).sort((a,b)=>b.총거래금액 - a.총거래금액);

const monthlyRateList = monthlyList.map(m => ({
  "연월": m.연월,
  "지급률": m.평균지급률 ? parseFloat(m.평균지급률.toFixed(2)) : 0
}));

const monthlyYieldList = Object.keys(monthlyGroup).sort().map(ym => {
  const rowsInMonth = validRows.filter(r => r.date.substring(0,7) === ym);
  const liveSum = rowsInMonth.reduce((sum,r)=>sum+r.liveWeight, 0);
  const carcassSum = rowsInMonth.reduce((sum,r)=>sum+r.carcassWeight, 0);
  return {
    "연월": ym,
    "도체율": liveSum > 0 ? parseFloat((carcassSum / liveSum * 100).toFixed(2)) : 0
  };
});

const companyRateList = companyList.filter(c => c.평균지급률 !== null).map(c => {
  const rawRowsForComp = validRows.filter(r => r.company === c.업체 && r.paymentRate !== null);
  const compRates = rawRowsForComp.map(r=>r.paymentRate);
  const minRate = compRates.length > 0 ? Math.min(...compRates) : 0;
  const maxRate = compRates.length > 0 ? Math.max(...compRates) : 0;
  return {
    "업체": c.업체,
    "평균": c.평균지급률,
    "min": parseFloat(minRate.toFixed(1)),
    "max": parseFloat(maxRate.toFixed(1)),
    "건수": rawRowsForComp.length
  };
}).sort((a,b)=>b.평균 - a.평균);

const rateBins = [
  { label: "65~70%", min: 65, max: 70 },
  { label: "70~72%", min: 70, max: 72 },
  { label: "72~74%", min: 72, max: 74 },
  { label: "74~75%", min: 74, max: 75 },
  { label: "75~76%", min: 75, max: 76 },
  { label: "76~77%", min: 76, max: 77 },
  { label: "77~78%", min: 77, max: 78 },
  { label: "78~79%", min: 78, max: 79 },
  { label: "79~80%", min: 79, max: 80 },
  { label: "80~81%", min: 80, max: 81 }
];
const rateHistogramList = rateBins.map(bin => {
  const count = validRows.filter(r => r.paymentRate !== null && r.paymentRate >= bin.min && r.paymentRate < bin.max).length;
  return {
    "구간": bin.label,
    "건수": count
  };
});
rateHistogramList.push({ "구간": "미입력", "건수": nullRateCount });

const transactedCompanies = new Set();
Object.keys(companyGroup).forEach(name => {
  transactedCompanies.add(name);
});

const inactiveCompanies = [];
allRegisteredCompanies.forEach(c => {
  if (!transactedCompanies.has(c)) {
    inactiveCompanies.push(c);
  }
});

const companyGroupValues = Object.values(companyGroup);
const referenceDateStr = companyGroupValues.reduce((max, g) => g.lastRegDate > max ? g.lastRegDate : max, companyGroupValues[0] ? companyGroupValues[0].lastRegDate : startDateStr);
const referenceDateObj = new Date(referenceDateStr + 'T00:00:00');

const recentlyInactiveCompanies = companyGroupValues.map(g => {
  const lastDateObj = new Date(g.lastRegDate + 'T00:00:00');
  const diffDays = Math.round((referenceDateObj - lastDateObj) / 86400000);
  return { "업체": g.name, "권역": g.region, "최근등록일": g.lastRegDate, "경과일수": diffDays };
}).filter(d => d.경과일수 >= 30).sort((a,b)=>b.경과일수 - a.경과일수);

const companyRegistrationIssues = [
  ...inactiveCompanies.map(c => ({ "업체": c, "권역": companyRegionMap[c] || '-', "상태": "거래가격 미등록", "최근등록일": '-', "경과일수": '-' })),
  ...recentlyInactiveCompanies.map(d => ({ "업체": d.업체, "권역": d.권역, "상태": "최근 1개월 이상 미등록", "최근등록일": d.최근등록일, "경과일수": d.경과일수 }))
];

const DATA = {
  kpi: {
    "총거래건수": validRows.length,
    "총거래금액_원": totalAmountSum,
    "총두수": totalHeadSum,
    "평균kg당가격": totalLiveWeightSum > 0 ? Math.round(unitPriceWeightedSum / totalLiveWeightSum) : 0,
    "총업체수": uniqueCompanies.size,
    "평균도체율": avgCarcassRateGlobal,
    "평균지급률": avgPaymentRateGlobal,
    "조사시작일": startDateStr,
    "조사종료일": endDateStr
  },
  monthly: monthlyList,
  weekly_price: weeklyList,
  daily: dailyList,
  company: companyList,
  region: regionList,
  gender: {
    "두수": {
      "암": femaleHeadSum,
      "거세": castratedHeadSum,
      "수": maleHeadSum
    },
    "도체중": {
      "암": femaleWeightSum,
      "거세": castratedWeightSum,
      "수": maleWeightSum
    },
    "두당평균도체중": {
      "암": femaleHeadSum > 0 ? parseFloat((femaleWeightSum / femaleHeadSum).toFixed(1)) : 0,
      "거세": castratedHeadSum > 0 ? parseFloat((castratedWeightSum / castratedHeadSum).toFixed(1)) : 0,
      "수": maleHeadSum > 0 ? parseFloat((maleWeightSum / maleHeadSum).toFixed(1)) : 0
    }
  },
  monthly_yield: monthlyYieldList,
  rate_histogram: rateHistogramList,
  monthly_rate: monthlyRateList,
  company_rate: companyRateList,
  data_quality: {
    "이상치건수": rawDataQualityAnomalyList.length,
    "이상치목록": rawDataQualityAnomalyList,
    "지급률결측_전체건수": nullRateCount,
    "지급률결측_비율": parseFloat((nullRateCount / validRows.length * 100).toFixed(1)),
    "업체별항목입력현황": companyFieldQualityList,
    "미참여등록업체": inactiveCompanies,
    "총등록업체수": allRegisteredCompanies.size,
    "기준일": referenceDateStr,
    "최근미등록업체목록": recentlyInactiveCompanies,
    "업체등록현황": companyRegistrationIssues
  }
};

console.log('3. Injecting new datasets into index.html...');
const htmlPath = path.join(__dirname, 'index.html');
if (!fs.existsSync(htmlPath)) {
  console.error(`Error: index.html not found at ${htmlPath}`);
  process.exit(1);
}

let htmlContent = fs.readFileSync(htmlPath, 'utf8');

const dataHolderRegex = /<script id="DATA_HOLDER" type="application\/json">[\s\S]*?<\/script>/;
const rawPriceRegex = /<script id="RAW_PRICE_HOLDER" type="application\/json">[\s\S]*?<\/script>/;
const rawCompanyRegex = /<script id="RAW_COMPANY_HOLDER" type="application\/json">[\s\S]*?<\/script>/;

if (!dataHolderRegex.test(htmlContent) || !rawPriceRegex.test(htmlContent) || !rawCompanyRegex.test(htmlContent)) {
  console.error('Error: Could not locate data holder tags in index.html.');
  process.exit(1);
}

htmlContent = htmlContent.replace(dataHolderRegex, `<script id="DATA_HOLDER" type="application/json">${JSON.stringify(DATA)}</script>`);
htmlContent = htmlContent.replace(rawPriceRegex, `<script id="RAW_PRICE_HOLDER" type="application/json">${JSON.stringify(priceRows)}</script>`);
htmlContent = htmlContent.replace(rawCompanyRegex, `<script id="RAW_COMPANY_HOLDER" type="application/json">${JSON.stringify(publicCompanyRows)}</script>`);

fs.writeFileSync(htmlPath, htmlContent, 'utf8');
console.log('🟢 Success: index.html has been updated with the compiled Excel data!');
