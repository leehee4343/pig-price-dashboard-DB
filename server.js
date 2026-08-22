const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const path = require('path');
const fs = require('fs');
const { initDb, dbAll, dbRun, dbGet, saveDb } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

// 메모리 업로드 설정
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ================= 권역 매핑 정의 =================
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

// 엑셀 시트 크기 보정 헬퍼
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
    ws['!ref'] = trueRef;
  }
}

// ================= DB 적재 로직 (파싱 및 저장) =================
async function importCompanyData(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const worksheet = workbook.Sheets[workbook.SheetNames[0]];
  fixSheetRange(worksheet);
  const rows = XLSX.utils.sheet_to_json(worksheet, { header: 1 });
  
  const headers = rows[0] || [];
  const nameIdx = headers.indexOf('업체명');
  const regionIdx = headers.indexOf('시도명');
  const useIdx = headers.indexOf('사용여부');

  if (nameIdx === -1) throw new Error('업체정보 시트에 "업체명" 컬럼이 없습니다.');

  await dbRun("DELETE FROM companies");
  await dbRun("BEGIN TRANSACTION");
  try {
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      if (!r || r.length === 0) continue;
      const name = r[nameIdx];
      const region = r[regionIdx] || '';
      const useYn = r[useIdx] || 'Y';
      if (name) {
        await dbRun(
          "INSERT OR REPLACE INTO companies (company_name, sido_name, use_yn) VALUES (?, ?, ?)",
          [name, region, useYn]
        );
      }
    }
    await dbRun("COMMIT");
  } catch (err) {
    await dbRun("ROLLBACK");
    throw err;
  }
  saveDb();
}

async function importPriceData(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const worksheet = workbook.Sheets[workbook.SheetNames[0]];
  fixSheetRange(worksheet);
  const rows = XLSX.utils.sheet_to_json(worksheet, { header: 1 });

  // 업체별 권역 맵 조회
  const companies = await dbAll("SELECT * FROM companies");
  const compRegionMap = {};
  companies.forEach(c => {
    compRegionMap[c.company_name] = regionGroupOf(c.sido_name);
  });

  await dbRun("DELETE FROM price_records");
  
  const parseNum = val => {
    if (val === null || val === undefined || val === '') return 0;
    if (typeof val === 'number') return val;
    return parseFloat(String(val).replace(/,/g, '')) || 0;
  };

  await dbRun("BEGIN TRANSACTION");
  try {
    for (let i = 3; i < rows.length; i++) {
      const r = rows[i];
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

      const regionGroup = compRegionMap[company] || '기타';

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
      const priceType = r[14] || '';
      const appliedPrice = parseNum(r[15]);

      await dbRun(`
        INSERT INTO price_records (
          company_name, date_str, reg_date_str, head_count, live_weight, total_amount, payment_rate,
          carcass_head, carcass_weight, female_head, female_weight, castrated_head, castrated_weight,
          male_head, male_weight, price_type, applied_price, region_group
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        company, dateStr, regDateStr, headCount, liveWeight, totalAmount, paymentRate,
        carcassHead, carcassWeight, femaleHead, femaleWeight, castratedHead, castratedWeight,
        maleHead, maleWeight, priceType, appliedPrice, regionGroup
      ]);
    }
    await dbRun("COMMIT");
  } catch (err) {
    await dbRun("ROLLBACK");
    throw err;
  }
  saveDb();
}

function findLatestExcel(prefix) {
  const dataDir = path.join(__dirname, 'data');
  if (!fs.existsSync(dataDir)) return null;
  const candidates = fs.readdirSync(dataDir)
    .filter(f => f.startsWith(prefix) && f.toLowerCase().endsWith('.xlsx'))
    .map(f => ({ name: f, mtime: fs.statSync(path.join(dataDir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return candidates.length ? path.join(dataDir, candidates[0].name) : null;
}

async function seedDatabase() {
  const companiesCount = await dbGet("SELECT COUNT(*) as cnt FROM companies");
  const priceCount = await dbGet("SELECT COUNT(*) as cnt FROM price_records");

  if (companiesCount.cnt === 0 || priceCount.cnt === 0) {
    console.log('🌱 Database is empty. Seeding with local excel files...');
    const priceFile = findLatestExcel('돼지 거래가격정보');
    const companyFile = findLatestExcel('업체정보');

    if (companyFile && priceFile) {
      console.log(`- Seeding companies from: ${path.basename(companyFile)}`);
      await importCompanyData(fs.readFileSync(companyFile));
      console.log(`- Seeding prices from: ${path.basename(priceFile)}`);
      await importPriceData(fs.readFileSync(priceFile));
      console.log('🟢 Seeding completed.');
    } else {
      console.warn('⚠ Seeding failed: Excel files not found.');
    }
  }
}

// ================= 통계 집계 연산 로직 =================
function compileDashboardData(records, activeCompanies) {
  const allRegisteredCompanies = new Set(activeCompanies.map(c => c.company_name));
  const companyRegionMap = {};
  activeCompanies.forEach(c => {
    companyRegionMap[c.company_name] = regionGroupOf(c.sido_name);
  });

  const validRows = [];
  const rawDataQualityAnomalyList = [];
  let nullRateCount = 0;

  const fieldDefs = [
    { key: '두수(생돈매입)', col: 'head_count' },
    { key: '생체중계(kg)', col: 'live_weight' },
    { key: '총거래금액(원)', col: 'total_amount' },
    { key: '지급률(%)', col: 'payment_rate' },
    { key: '도체두수(계)', col: 'carcass_head' },
    { key: '도체중(계,kg)', col: 'carcass_weight' },
    { key: '암 두수', col: 'female_head' },
    { key: '암 도체중(kg)', col: 'female_weight' },
    { key: '거세 두수', col: 'castrated_head' },
    { key: '거세 도체중(kg)', col: 'castrated_weight' },
    { key: '수 두수', col: 'male_head' },
    { key: '수 도체중(kg)', col: 'male_weight' },
    { key: '적용단가 유형', col: 'price_type' },
    { key: '적용단가(원/kg)', col: 'applied_price' }
  ];
  const companyFieldMissingCounts = {};
  const isBlank = v => v === null || v === undefined || v === '';

  records.forEach(r => {
    const unitPrice = r.live_weight > 0 ? r.total_amount / r.live_weight : 0;
    
    if (r.payment_rate === null) nullRateCount++;

    const company = r.company_name;
    if (!companyFieldMissingCounts[company]) {
      companyFieldMissingCounts[company] = {};
      fieldDefs.forEach(f => { companyFieldMissingCounts[company][f.key] = 0; });
    }
    fieldDefs.forEach(f => {
      if (isBlank(r[f.col])) {
        companyFieldMissingCounts[company][f.key]++;
      }
    });

    const rowObj = {
      company: r.company_name,
      date: r.date_str,
      regDate: r.reg_date_str,
      headCount: r.head_count,
      liveWeight: r.live_weight,
      totalAmount: r.total_amount,
      paymentRate: r.payment_rate,
      carcassHead: r.carcass_head,
      carcassWeight: r.carcass_weight,
      femaleHead: r.female_head,
      femaleWeight: r.female_weight,
      castratedHead: r.castrated_head,
      castratedWeight: r.castrated_weight,
      maleHead: r.male_head,
      maleWeight: r.male_weight,
      unitPrice,
      region: r.region_group
    };
    validRows.push(rowObj);

    if (unitPrice > 0 && (unitPrice < 2500 || unitPrice > 9000)) {
      rawDataQualityAnomalyList.push({
        업체: r.company_name,
        조사일자: r.date_str,
        등록일자: r.reg_date_str,
        두수: r.head_count,
        생체중: r.live_weight,
        총거래금액: r.total_amount,
        kg당가격: unitPrice
      });
    }
  });

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

  const transactedCompanies = new Set(Object.keys(companyGroup));
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

  return {
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
}

// P8 업체 상세 분석을 위한 백엔드 계산 로직
function computeBizStats(companyName, startDate, endDate, records) {
  const list = records.filter(r => r.company_name === companyName);
  if (list.length === 0) return null;

  const count = list.length;
  const head = list.reduce((sum, r) => sum + r.head_count, 0);
  const live = list.reduce((sum, r) => sum + r.live_weight, 0);
  const carcass = list.reduce((sum, r) => sum + r.carcass_weight, 0);
  const amount = list.reduce((sum, r) => sum + r.total_amount, 0);
  const rateRows = list.filter(r => r.payment_rate !== null);
  const rateAvg = rateRows.length ? rateRows.reduce((sum, r) => sum + r.payment_rate, 0) / rateRows.length : null;

  // 시계열 그룹화 (일별)
  const dailyMap = {};
  list.forEach(r => {
    if (!dailyMap[r.date_str]) {
      dailyMap[r.date_str] = { date: r.date_str, count: 0, head: 0, live: 0, carcass: 0, amount: 0, rateSum: 0, rateCount: 0 };
    }
    const d = dailyMap[r.date_str];
    d.count++;
    d.head += r.head_count;
    d.live += r.live_weight;
    d.carcass += r.carcass_weight;
    d.amount += r.total_amount;
    if (r.payment_rate !== null) {
      d.rateSum += r.payment_rate;
      d.rateCount++;
    }
  });
  const daily = Object.values(dailyMap).map(d => ({
    "일자": d.date,
    "거래건수": d.count,
    "총두수": d.head,
    "총생체중": d.live,
    "총거래금액": d.amount,
    "평균kg당가격": d.live > 0 ? Math.round(d.amount / d.live) : 0,
    "도체율": d.live > 0 ? parseFloat((d.carcass / d.live * 100).toFixed(2)) : 0,
    "평균지급률": d.rateCount > 0 ? parseFloat((d.rateSum / d.rateCount).toFixed(2)) : null
  })).sort((a,b) => a.일자.localeCompare(b.일자));

  // 시계열 그룹화 (주별)
  const weeklyMap = {};
  list.forEach(r => {
    const sunStr = getSundayDateString(r.date_str);
    if (!weeklyMap[sunStr]) {
      weeklyMap[sunStr] = { week: sunStr, count: 0, head: 0, live: 0, carcass: 0, amount: 0, rateSum: 0, rateCount: 0 };
    }
    const w = weeklyMap[sunStr];
    w.count++;
    w.head += r.head_count;
    w.live += r.live_weight;
    w.carcass += r.carcass_weight;
    w.amount += r.total_amount;
    if (r.payment_rate !== null) {
      w.rateSum += r.payment_rate;
      w.rateCount++;
    }
  });
  const weekly = Object.values(weeklyMap).map(w => ({
    "주": w.week,
    "거래건수": w.count,
    "총두수": w.head,
    "총생체중": w.live,
    "총거래금액": w.amount,
    "평균단가": w.live > 0 ? Math.round(w.amount / w.live) : 0,
    "도체율": w.live > 0 ? parseFloat((w.carcass / w.live * 100).toFixed(2)) : 0,
    "평균지급률": w.rateCount > 0 ? parseFloat((w.rateSum / w.rateCount).toFixed(2)) : null
  })).sort((a,b) => a.주.localeCompare(b.주));

  // 시계열 그룹화 (월별)
  const monthlyMap = {};
  list.forEach(r => {
    const ym = r.date_str.substring(0, 7);
    if (!monthlyMap[ym]) {
      monthlyMap[ym] = { ym, count: 0, head: 0, live: 0, carcass: 0, amount: 0, rateSum: 0, rateCount: 0 };
    }
    const m = monthlyMap[ym];
    m.count++;
    m.head += r.head_count;
    m.live += r.live_weight;
    m.carcass += r.carcass_weight;
    m.amount += r.total_amount;
    if (r.payment_rate !== null) {
      m.rateSum += r.payment_rate;
      m.rateCount++;
    }
  });
  const monthly = Object.values(monthlyMap).map(m => ({
    "연월": m.ym,
    "거래건수": m.count,
    "총두수": m.head,
    "총생체중": m.live,
    "총거래금액": m.amount,
    "평균kg당가격": m.live > 0 ? Math.round(m.amount / m.live) : 0,
    "도체율": m.live > 0 ? parseFloat((m.carcass / m.live * 100).toFixed(2)) : 0,
    "평균지급률": m.rateCount > 0 ? parseFloat((m.rateSum / m.rateCount).toFixed(2)) : null
  })).sort((a,b) => a.연월.localeCompare(b.연월));

  return {
    "업체": companyName,
    "거래건수": count,
    "총두수": head,
    "총생체중": live,
    "총거래금액": amount,
    "평균지급률": rateAvg !== null ? parseFloat(rateAvg.toFixed(2)) : null,
    "평균kg당가격": live > 0 ? Math.round(amount / live) : 0,
    "도체율": live > 0 ? parseFloat((carcass / live * 100).toFixed(2)) : 0,
    "daily": daily,
    "weekly": weekly,
    "monthly": monthly
  };
}

// ================= Express API 라우트 구성 =================

// 1. 대시보드 통계 조회 API (P1~P7, P10 통합 데이터 제공)
app.get('/api/dashboard-data', async (req, res) => {
  try {
    const { startDate, endDate, region, company } = req.query;

    const companies = await dbAll("SELECT * FROM companies WHERE use_yn = 'Y'");
    
    let query = "SELECT * FROM price_records WHERE date_str BETWEEN ? AND ?";
    const params = [startDate || '1970-01-01', endDate || '2999-12-31'];

    if (region && region !== '') {
      query += " AND region_group = ?";
      params.push(region);
    }
    if (company && company !== '') {
      query += " AND company_name = ?";
      params.push(company);
    }

    const records = await dbAll(query, params);
    const data = compileDashboardData(records, companies);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. 필터 데이터 제공 API (Select box를 채우기 위한 동적 distinct 쿼리)
app.get('/api/filters', async (req, res) => {
  try {
    const regions = await dbAll("SELECT DISTINCT region_group FROM price_records WHERE region_group != '기타'");
    const companies = await dbAll("SELECT company_name, sido_name FROM companies WHERE use_yn = 'Y' ORDER BY company_name ASC");
    const months = await dbAll("SELECT DISTINCT substr(date_str, 1, 7) as ym FROM price_records ORDER BY ym ASC");
    res.json({
      regions: regions.map(r => r.region_group),
      companies: companies.map(c => ({ name: c.company_name, region: regionGroupOf(c.sido_name) })),
      months: months.map(m => m.ym)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. P8 업체 상세 분석 데이터 API
app.get('/api/biz-stats', async (req, res) => {
  try {
    const { company, startDate, endDate } = req.query;
    if (!company) return res.status(400).json({ error: 'company is required' });

    let query = "SELECT * FROM price_records WHERE date_str BETWEEN ? AND ?";
    const params = [startDate || '1970-01-01', endDate || '2999-12-31'];

    const records = await dbAll(query, params);
    const data = computeBizStats(company, startDate, endDate, records);
    if (!data) return res.status(404).json({ error: 'Company data not found in range' });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. P11 가격 등록현황(업체별) 시계열 트렌드 API
app.get('/api/company-reg-trend', async (req, res) => {
  try {
    const { company, startDate, endDate } = req.query;
    if (!company) return res.status(400).json({ error: 'company is required' });

    const records = await dbAll(
      "SELECT * FROM price_records WHERE company_name = ? AND date_str BETWEEN ? AND ? ORDER BY date_str ASC",
      [company, startDate || '1970-01-01', endDate || '2999-12-31']
    );

    // 일별, 주별, 월별 등록 횟수 및 거래일수 집계
    const daily = {};
    const weekly = {};
    const monthly = {};

    records.forEach(r => {
      const d = r.date_str;
      const w = getSundayDateString(d);
      const m = d.substring(0, 7);

      if (!daily[d]) daily[d] = { date: d, count: 0, dateSet: new Set() };
      daily[d].count++;
      daily[d].dateSet.add(d);

      if (!weekly[w]) weekly[w] = { week: w, count: 0, dateSet: new Set() };
      weekly[w].count++;
      weekly[w].dateSet.add(d);

      if (!monthly[m]) monthly[m] = { month: m, count: 0, dateSet: new Set() };
      monthly[m].count++;
      monthly[m].dateSet.add(d);
    });

    const formatList = (obj, labelKey, type) => {
      return Object.values(obj).map(v => ({
        "구간": v[labelKey],
        "등록횟수": v.count,
        "거래일수": v.dateSet.size
      })).sort((a,b) => a.구간.localeCompare(b.구간));
    };

    res.json({
      daily: formatList(daily, 'date', 'day'),
      weekly: formatList(weekly, 'week', 'week'),
      monthly: formatList(monthly, 'month', 'month')
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5. 엑셀 데이터 파일 업로드 적재 API (관리자용 비밀번호 'KaPePig7!' 인증 추가)
app.post('/api/upload', upload.fields([
  { name: 'priceExcel', maxCount: 1 },
  { name: 'companyExcel', maxCount: 1 }
]), async (req, res) => {
  try {
    const password = req.body.password;
    if (password !== 'KaPePig7!') {
      return res.status(401).json({ success: false, error: 'Unauthorized: Invalid upload password.' });
    }

    let message = '';
    if (req.files['companyExcel']) {
      const file = req.files['companyExcel'][0];
      await importCompanyData(file.buffer);
      message += '업체 정보 적재 완료. ';
    }

    if (req.files['priceExcel']) {
      const file = req.files['priceExcel'][0];
      await importPriceData(file.buffer);
      message += '가격 거래 레코드 적재 완료. ';
    }

    if (!message) {
      return res.status(400).json({ success: false, error: 'No files were uploaded.' });
    }

    res.json({ success: true, message: message.trim() });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ================= 서버 기동 =================
async function startServer() {
  await initDb();
  await seedDatabase();

  app.listen(PORT, () => {
    console.log(`🚀 DB-backed Dashboard Server is running at http://localhost:${PORT}`);
  });
}

startServer().catch(err => {
  console.error('❌ Server failed to start:', err);
});
