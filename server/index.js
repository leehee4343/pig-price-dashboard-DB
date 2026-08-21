require('dotenv').config();

const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const { Octokit } = require('@octokit/rest');
const { readRowsFromBuffer, computeDashboardData, injectIntoHtml } = require('../lib/aggregate');

const {
  UPLOAD_PASSWORD,
  SESSION_SECRET,
  GITHUB_TOKEN,
  GITHUB_OWNER = 'leehee4343',
  GITHUB_REPO = 'pig-price-dashboard',
  PORT = 3000
} = process.env;

if (!UPLOAD_PASSWORD || !SESSION_SECRET || !GITHUB_TOKEN) {
  console.error('필수 환경변수(UPLOAD_PASSWORD, SESSION_SECRET, GITHUB_TOKEN)가 설정되지 않았습니다.');
  process.exit(1);
}

const octokit = new Octokit({ auth: GITHUB_TOKEN });
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } });

// 브라우저가 multipart Content-Disposition의 파일명을 latin1으로 실어 보내는 경우가 많아
// (RFC 2388 시절 관행), 한글 파일명이 busboy/multer를 거치면 깨진다. UTF-8로 재해석해준다.
function fixFilename(name) {
  if (!name) return name;
  return Buffer.from(name, 'latin1').toString('utf8');
}

// ================= 세션 (서명된 쿠키, 서버 상태 없음) =================
const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8시간

function signSession(expiresAt) {
  const payload = String(expiresAt);
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
  return `${payload}.${sig}`;
}
function verifySession(token) {
  if (!token) return false;
  const dot = token.lastIndexOf('.');
  if (dot < 0) return false;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
  const sigBuf = Buffer.from(sig, 'hex');
  const expectedBuf = Buffer.from(expected, 'hex');
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) return false;
  return Number(payload) > Date.now();
}
function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  header.split(';').forEach(part => {
    const idx = part.indexOf('=');
    if (idx < 0) return;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  });
  return out;
}
function requireAuth(req, res, next) {
  const cookies = parseCookies(req);
  if (verifySession(cookies.session)) return next();
  res.redirect('/login');
}

// ================= 업로드 미리보기 임시 보관 (메모리, TTL) =================
const PENDING_TTL_MS = 10 * 60 * 1000; // 10분
const pendingUpdates = new Map();
function cleanupPending() {
  const now = Date.now();
  for (const [key, value] of pendingUpdates) {
    if (value.expiresAt < now) pendingUpdates.delete(key);
  }
}

// ================= 화면 (인라인 HTML, 별도 뷰 엔진 없음) =================
const PAGE_STYLE = `
  body{font-family:'Malgun Gothic','Noto Sans KR',sans-serif;background:#EEF3F7;color:#1D2B36;margin:0;}
  .wrap{max-width:640px;margin:0 auto;padding:48px 20px;}
  .box{background:#fff;padding:32px;border-radius:14px;box-shadow:0 14px 34px rgba(24,54,83,.08);}
  h1{font-size:19px;color:#16466F;margin:0 0 20px;}
  input[type=password],input[type=file]{width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #D9E3EC;border-radius:8px;margin-bottom:14px;font-size:14px;background:#fff;}
  label{display:block;font-size:13px;font-weight:700;color:#314252;margin-bottom:6px;}
  button{padding:10px 20px;border:none;border-radius:8px;background:#16466F;color:#fff;font-weight:700;cursor:pointer;font-size:14px;}
  button.secondary{background:#EEF1F4;color:#314252;}
  .err{background:#FBEAEA;color:#A03A36;padding:10px 14px;border-radius:8px;font-size:13px;margin-bottom:16px;}
  .ok{background:#E7F3EC;color:#1E6B4F;padding:10px 14px;border-radius:8px;font-size:13px;margin-bottom:16px;}
  table{width:100%;border-collapse:collapse;margin:16px 0;font-size:13px;}
  td{padding:6px 4px;border-bottom:1px solid #EEF1F4;}
  td:first-child{color:#617284;width:45%;}
  td:last-child{font-weight:700;color:#16466F;}
  .actions{display:flex;gap:10px;margin-top:20px;}
  a{color:#256E9F;}
`;
function escapeHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function pageShell(title, bodyHtml) {
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title><style>${PAGE_STYLE}</style></head><body><div class="wrap"><div class="box">${bodyHtml}</div></div></body></html>`;
}

function loginPageHtml(error) {
  return pageShell('로그인 - 돼지거래가격 데이터 관리', `
    <h1>돼지거래가격 데이터 관리</h1>
    ${error ? `<div class="err">${error}</div>` : ''}
    <form method="POST" action="/login">
      <input type="password" name="password" placeholder="팀 비밀번호" autofocus required>
      <button type="submit">로그인</button>
    </form>`);
}

function uploadPageHtml(message) {
  return pageShell('엑셀 업로드 - 돼지거래가격 데이터 관리', `
    <h1>엑셀 업로드</h1>
    ${message ? `<div class="err">${escapeHtml(message)}</div>` : ''}
    <form method="POST" action="/upload" enctype="multipart/form-data">
      <label>돼지 거래가격정보 엑셀 (.xlsx)</label>
      <input type="file" name="priceFile" accept=".xlsx" required>
      <label>업체정보 엑셀 (.xlsx)</label>
      <input type="file" name="companyFile" accept=".xlsx" required>
      <div class="actions">
        <button type="submit">업로드 및 미리보기</button>
      </div>
    </form>
    <p style="margin-top:20px;"><a href="/logout">로그아웃</a></p>`);
}

function previewPageHtml(token, info) {
  const k = info.DATA.kpi;
  const dq = info.DATA.data_quality;
  const rows = [
    ['가격정보 파일', info.priceFileName],
    ['가격정보 행 수', `${info.priceRowCount.toLocaleString()}행`],
    ['업체정보 파일', info.companyFileName],
    ['업체정보 행 수', `${info.companyRowCount.toLocaleString()}행`],
    ['총 거래건수', `${k.총거래건수.toLocaleString()}건`],
    ['참여업체 수', `${k.총업체수}개사`],
    ['조사기간', `${k.조사시작일} ~ ${k.조사종료일}`],
    ['이상치 건수', `${dq.이상치건수}건`],
    ['지급률 결측 비율', `${dq.지급률결측_비율}%`]
  ].map(([a, b]) => `<tr><td>${escapeHtml(a)}</td><td>${escapeHtml(b)}</td></tr>`).join('');

  return pageShell('미리보기 - 돼지거래가격 데이터 관리', `
    <h1>반영 전 확인</h1>
    <p style="font-size:13px;color:#617284;">아래 내용을 확인하고, 문제없으면 "GitHub에 반영"을 눌러주세요.
    반영하면 몇 분 내로 실제 사이트에 공개됩니다.</p>
    <table>${rows}</table>
    <form method="POST" action="/confirm">
      <input type="hidden" name="token" value="${token}">
      <div class="actions">
        <button type="submit">GitHub에 반영</button>
        <button type="button" class="secondary" onclick="location.href='/upload'">취소</button>
      </div>
    </form>`);
}

function resultPageHtml(success, message, commitUrl) {
  return pageShell('결과 - 돼지거래가격 데이터 관리', `
    <h1>${success ? '반영 완료' : '반영 실패'}</h1>
    ${success
      ? `<div class="ok">GitHub에 정상적으로 반영되었습니다. 몇 분 내로 사이트에 새 데이터가 보입니다.</div>
         ${commitUrl ? `<p style="font-size:13px;"><a href="${escapeHtml(commitUrl)}" target="_blank">커밋 확인하기</a></p>` : ''}`
      : `<div class="err">${escapeHtml(message)}</div>`}
    <div class="actions">
      <button onclick="location.href='/upload'">돌아가기</button>
    </div>`);
}

// ================= 앱 =================
const app = express();
app.use(express.urlencoded({ extended: true }));

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 5, standardHeaders: true, legacyHeaders: false });

app.get('/', (req, res) => res.redirect('/upload'));

app.get('/login', (req, res) => res.send(loginPageHtml()));

app.post('/login', loginLimiter, (req, res) => {
  const password = req.body && req.body.password;
  if (password && password === UPLOAD_PASSWORD) {
    const expiresAt = Date.now() + SESSION_TTL_MS;
    res.setHeader(
      'Set-Cookie',
      `session=${signSession(expiresAt)}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`
    );
    return res.redirect('/upload');
  }
  res.status(401).send(loginPageHtml('비밀번호가 올바르지 않습니다.'));
});

app.get('/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0');
  res.redirect('/login');
});

app.get('/upload', requireAuth, (req, res) => res.send(uploadPageHtml()));

app.post(
  '/upload',
  requireAuth,
  upload.fields([{ name: 'priceFile', maxCount: 1 }, { name: 'companyFile', maxCount: 1 }]),
  (req, res) => {
    try {
      const priceFile = req.files && req.files.priceFile && req.files.priceFile[0];
      const companyFile = req.files && req.files.companyFile && req.files.companyFile[0];
      if (!priceFile || !companyFile) {
        return res.status(400).send(uploadPageHtml('돼지 거래가격정보·업체정보 두 파일을 모두 선택해주세요.'));
      }

      const priceRows = readRowsFromBuffer(priceFile.buffer);
      const companyRows = readRowsFromBuffer(companyFile.buffer);
      const { DATA, publicCompanyRows } = computeDashboardData(priceRows, companyRows);

      cleanupPending();
      const token = crypto.randomBytes(16).toString('hex');
      pendingUpdates.set(token, {
        priceRows,
        publicCompanyRows,
        DATA,
        expiresAt: Date.now() + PENDING_TTL_MS
      });

      res.send(previewPageHtml(token, {
        priceFileName: fixFilename(priceFile.originalname),
        companyFileName: fixFilename(companyFile.originalname),
        priceRowCount: priceRows.length,
        companyRowCount: companyRows.length,
        DATA
      }));
    } catch (err) {
      console.error(err);
      res.status(500).send(uploadPageHtml('엑셀 처리 중 오류가 발생했습니다: ' + err.message));
    }
  }
);

app.post('/confirm', requireAuth, async (req, res) => {
  const token = req.body && req.body.token;
  const pending = token && pendingUpdates.get(token);
  if (!pending || pending.expiresAt < Date.now()) {
    if (token) pendingUpdates.delete(token);
    return res.status(410).send(resultPageHtml(false, '미리보기가 만료되었습니다(10분). 다시 업로드해주세요.'));
  }
  pendingUpdates.delete(token);

  try {
    // Contents API는 1MB가 넘는 파일은 응답에 content를 담아주지 않는다(sha만 옴).
    // index.html이 이미 1MB를 넘으므로, sha는 여기서 받고 실제 내용은 Git Blob API로 따로 가져온다.
    const { data: fileMeta } = await octokit.repos.getContent({
      owner: GITHUB_OWNER,
      repo: GITHUB_REPO,
      path: 'index.html'
    });
    const { data: blob } = await octokit.git.getBlob({
      owner: GITHUB_OWNER,
      repo: GITHUB_REPO,
      file_sha: fileMeta.sha
    });
    const currentHtml = Buffer.from(blob.content, blob.encoding || 'base64').toString('utf8');
    const newHtml = injectIntoHtml(currentHtml, pending.DATA, pending.priceRows, pending.publicCompanyRows);

    const { data: commitResult } = await octokit.repos.createOrUpdateFileContents({
      owner: GITHUB_OWNER,
      repo: GITHUB_REPO,
      path: 'index.html',
      message: `데이터 갱신 (웹 업로드, ${new Date().toISOString()})`,
      content: Buffer.from(newHtml, 'utf8').toString('base64'),
      sha: fileMeta.sha
    });

    res.send(resultPageHtml(true, null, commitResult.commit.html_url));
  } catch (err) {
    console.error(err);
    const conflict = err.status === 409 || err.status === 422;
    const msg = conflict
      ? '다른 사람이 방금 반영했습니다. 새로고침 후 다시 시도해주세요.'
      : ('반영 중 오류가 발생했습니다: ' + err.message);
    res.status(conflict ? 409 : 500).send(resultPageHtml(false, msg));
  }
});

app.listen(PORT, () => {
  console.log(`서버 실행 중: http://localhost:${PORT}`);
});
