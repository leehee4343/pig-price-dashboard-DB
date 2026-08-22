const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const dbDir = path.join(__dirname, 'db');
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}
const dbPath = path.join(dbDir, 'pig_dashboard.db');
let db;

// DB 인스턴스 초기화
async function initDb() {
  const SQL = await initSqlJs();
  
  if (fs.existsSync(dbPath)) {
    const filebuffer = fs.readFileSync(dbPath);
    db = new SQL.Database(filebuffer);
  } else {
    db = new SQL.Database();
    // 스키마 생성
    db.run(`
      CREATE TABLE IF NOT EXISTS companies (
        company_name TEXT PRIMARY KEY,
        sido_name TEXT,
        use_yn TEXT DEFAULT 'Y'
      );
    `);
    db.run(`
      CREATE TABLE IF NOT EXISTS price_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        company_name TEXT,
        date_str TEXT,
        reg_date_str TEXT,
        head_count REAL,
        live_weight REAL,
        total_amount REAL,
        payment_rate REAL,
        carcass_head REAL,
        carcass_weight REAL,
        female_head REAL,
        female_weight REAL,
        castrated_head REAL,
        castrated_weight REAL,
        male_head REAL,
        male_weight REAL,
        price_type TEXT,
        applied_price REAL,
        region_group TEXT
      );
    `);
    db.run(`CREATE INDEX IF NOT EXISTS idx_price_records_company ON price_records(company_name);`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_price_records_date ON price_records(date_str);`);
    saveDb();
  }
  console.log('🟢 Database initialized (sql.js) successfully.');
}

// 메모리 DB 내용을 파일에 저장
function saveDb() {
  if (!db) return;
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(dbPath, buffer);
}

// Promise 기반 SQL 실행 및 변환 헬퍼 함수들 (기존 sqlite3의 리턴 구조와 일치시키기 위해)
// sql.js의 db.exec()는 [{columns:[], values:[[]]}] 형태를 리턴하므로,
// 객체 배열 [{key: val}] 로 변환해줍니다.
function dbAll(query, params = []) {
  if (!db) throw new Error('Database is not initialized. Call initDb() first.');
  const stmt = db.prepare(query);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return Promise.resolve(rows);
}

function dbRun(query, params = []) {
  if (!db) throw new Error('Database is not initialized. Call initDb() first.');
  db.run(query, params);
  saveDb();
  return Promise.resolve({ lastID: 0 }); // lastID는 특별히 안 써도 되므로 mock
}

function dbGet(query, params = []) {
  return dbAll(query, params).then(rows => rows[0] || null);
}

module.exports = {
  initDb,
  dbAll,
  dbRun,
  dbGet,
  saveDb
};
