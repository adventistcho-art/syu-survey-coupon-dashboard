/**
 * 「학과 교육환경 이용 실태와 개선 수요 조사」 설문 연동 스크립트
 * 설문지에 붙은(바인딩된) Apps Script 프로젝트에 붙여넣어 사용합니다.
 *
 * 하는 일
 *  1) 응답이 들어올 때마다 학과별 참여 인원을 집계합니다.
 *     재학생 명부와 학번·학과가 맞고, 그 학번으로 처음 낸 응답만 셉니다.
 *     명부는 학번을 비밀 키로 해시한 값만 스크립트 속성(ROSTER_*)에 보관합니다. 원래 학번은 저장하지 않습니다.
 *  2) 설문 선택지의 "현재 참여 학생 비율"을 갱신하고, 10%를 채운 학과는 목록에서 뺍니다.
 *     설문 안의 "학과별 실시간 참여 현황" 그래프 이미지도 다시 그립니다.
 *  3) GitHub 대시보드가 읽어 갈 집계 JSON을 웹앱 주소(/exec)로 내보냅니다.
 *     내보내는 값은 학과명 · 참여 인원 · 쿠폰 수뿐이고, 학번 · 전화번호는 내보내지 않습니다.
 *
 * 처음 설정
 *  ① 아래 ENROLLMENT에 학과별 재학생 수를 채웁니다.
 *  ② 편집기에서 setup 함수를 한 번 실행하고 권한을 허용합니다. (응답 트리거 설치 + 첫 집계)
 *  ②-1 명부 올리기: makeUploadToken 실행 → 로그의 토큰으로 /exec에 POST {token, key, roster} (doPost 참고)
 *  ③ 배포 → 새 배포 → 웹 앱 (실행: 나 / 액세스: 모든 사용자) → /exec 주소를 대시보드 index.html의 API_URL에 넣습니다.
 */

const CONFIG = {
  DEPT_TITLE: '0-1. 소속 학과', // 학과 문항 제목 (앞부분만 맞아도 됨)
  RATE: 0.1,                    // 재학생 대비 목표 비율 (10%)
  CLOSE_FULL_DEPTS: true,       // 목표를 채운 학과를 선택지에서 뺄지
  UPDATE_LABELS: true,          // 선택지 옆 "현재 참여 학생 비율"을 갱신할지
  UPDATE_CHART: true,           // 설문 안의 참여 현황 그래프 이미지를 다시 그릴지
  CHART_TITLE: '학과별 실시간 참여 현황', // 그래프 이미지 항목 제목 (앞부분)
  ID_TITLE: '0-3. 학번',        // 학번 문항 제목 (앞부분)
  VERIFY: true,                 // 명부 대조로 통과한 응답만 셀지
  ID_PATTERN: '^20[0-9]{8}$',   // 설문 학번 형식 검사 (10자리 숫자)
  TEST_IDS: {},                 // 테스트용 가짜 학번 → 학과 (테스트 끝나면 비워 둘 것)
};

/** 2026학년도 2학기 재학생 수 (IR 학적현황월별 2026-10-01 기준, 학적상태=재학). 학과명은 선택지 괄호 앞 이름과 같아야 합니다.
 *  합산: 건축=4년+5년, 약학=약학+6년제, 자유전공학부=미래융합+창의융합, 경영·동물자원·영어영문은 구 학과명 재학생 포함
 *  글로벌자유전공학부는 설문 대상에서 제외(2026-11-05) */
const ENROLLMENT = {
  '간호학과': 318,
  '건축학과': 242,
  '경영학과': 740,
  '글로벌한국학과': 201,
  '데이터클라우드공학과': 54,
  '동물자원과학과': 116,
  '물리치료학과': 190,
  '바이오융합공학과': 125,
  '보건관리학과': 127,
  '사회복지학과': 120,
  '상담심리학과': 188,
  '식품영양학과': 162,
  '신학과': 165,
  '아트앤디자인학과': 312,
  '약학과': 199,
  '영어영문학과': 166,
  '유아교육과': 156,
  '음악학과': 130,
  '인공지능융합학부': 433,
  '자유전공학부': 106,
  '체육학과': 149,
  '컴퓨터공학부': 313,
  '항공관광외국어학부': 195,
  '화학생명과학과': 267,
  '환경디자인원예학과': 205,
};

const STATS_KEY = 'DASHBOARD_STATS';

/* ───────────── 설정 · 트리거 ───────────── */

function setup() {
  const missing = Object.keys(ENROLLMENT).filter(k => !(ENROLLMENT[k] > 0));
  if (missing.length) throw new Error('재학생 수가 비어 있는 학과: ' + missing.join(', '));

  const form = FormApp.getActiveForm();
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'handleSubmit')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('handleSubmit').forForm(form).onFormSubmit().create();

  refresh();
  Logger.log(JSON.stringify(readStats_(), null, 2));
}

/** 응답 제출 시 자동 실행 */
function handleSubmit() {
  refresh();
}

/** 집계 → 선택지 갱신 → 대시보드용 JSON 저장 (수동 실행도 가능) */
function refresh() {
  const lock = LockService.getScriptLock();
  lock.waitLock(30 * 1000);
  try {
    const form = FormApp.getActiveForm();
    const item = findDeptItem_(form);
    const stats = computeStats_(form, item);
    if (CONFIG.UPDATE_LABELS || CONFIG.CLOSE_FULL_DEPTS) updateChoices_(item, stats);
    if (CONFIG.UPDATE_CHART) updateChart_(form, stats);
    PropertiesService.getScriptProperties().setProperty(STATS_KEY, JSON.stringify(stats));
    return stats;
  } finally {
    lock.releaseLock();
  }
}

/* ───────────── 대시보드용 웹앱 ───────────── */

function doGet() {
  const stats = readStats_() || refresh();
  return ContentService.createTextOutput(JSON.stringify(stats))
    .setMimeType(ContentService.MimeType.JSON);
}

/* ───────────── 내부 함수 ───────────── */

function quotaOf_(enrolled) {
  return Math.ceil(enrolled * CONFIG.RATE);
}

function deptName_(label) {
  return String(label || '').split(' (')[0].trim();
}

function findDeptItem_(form) {
  const item = form.getItems(FormApp.ItemType.LIST)
    .concat(form.getItems(FormApp.ItemType.MULTIPLE_CHOICE))
    .find(it => it.getTitle().trim().indexOf(CONFIG.DEPT_TITLE) === 0);
  if (!item) throw new Error(`'${CONFIG.DEPT_TITLE}' 문항을 찾지 못했습니다.`);
  return item;
}

function computeStats_(form, item) {
  const counts = {};
  verifyAll_(form, item).forEach(v => {
    if (v.result !== 'ok' || !v.dept) return;
    counts[v.dept] = (counts[v.dept] || 0) + 1;
  });
  return {
    updatedAt: new Date().toISOString(),
    acceptingResponses: form.isAcceptingResponses(),
    departments: Object.keys(ENROLLMENT).map(name => ({
      name: name,
      count: counts[name] || 0,
      quota: quotaOf_(ENROLLMENT[name]),
    })),
  };
}

function updateChoices_(item, stats) {
  const typed = item.getType() === FormApp.ItemType.LIST ? item.asListItem() : item.asMultipleChoiceItem();
  const open = stats.departments.filter(d => !CONFIG.CLOSE_FULL_DEPTS || d.count < d.quota);
  if (!open.length) {
    FormApp.getActiveForm().setAcceptingResponses(false); // 모든 학과 마감 시 설문 종료
    return;
  }
  const pct = Math.round(CONFIG.RATE * 100);
  const choices = open.map(d => {
    const label = CONFIG.UPDATE_LABELS
      ? `${d.name} (현재 참여 학생 비율: ${(d.count / ENROLLMENT[d.name] * 100).toFixed(1)}% / 목표: ${pct}%)`
      : d.name;
    return typed.createChoice(label);
  });
  typed.setChoices(choices);
}

/** 학과별 참여율(%) 가로 막대그래프를 그려 설문의 이미지 항목을 교체 */
function updateChart_(form, stats) {
  const imageItem = form.getItems(FormApp.ItemType.IMAGE)
    .find(it => it.getTitle().trim().indexOf(CONFIG.CHART_TITLE) === 0);
  if (!imageItem) return;
  const goal = CONFIG.RATE * 100;
  const rows = stats.departments
    .map(d => [d.name, Math.round(Math.min(goal, d.count / ENROLLMENT[d.name] * 100) * 10) / 10])
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ko'));
  const table = Charts.newDataTable()
    .addColumn(Charts.ColumnType.STRING, '학과')
    .addColumn(Charts.ColumnType.NUMBER, '참여율(%)');
  rows.forEach(r => table.addRow(r));
  const chart = Charts.newBarChart()
    .setDataTable(table.build())
    .setDimensions(740, 880)
    .setRange(0, goal)
    .setLegendPosition(Charts.Position.NONE)
    .setColors(['#2a78d6'])
    .setOption('chartArea', { left: 170, top: 16, width: 540, height: 820 })
    .setOption('vAxis', { textStyle: { fontSize: 13 } })
    .setOption('hAxis', { textStyle: { fontSize: 12 }, ticks: [0, 2, 4, 6, 8, 10] })
    .build();
  imageItem.asImageItem().setImage(chart.getAs('image/png'));
}

/* ───────────── 학번 · 학과 대조 ───────────── */

/** 모든 응답을 제출 순서대로 판정. result: ok | no_id | not_found | dept_mismatch | duplicate */
function verifyAll_(form, deptItem) {
  const idItem = findItem_(form, CONFIG.ID_TITLE, [FormApp.ItemType.TEXT]);
  const key = CONFIG.VERIFY ? rosterKey_() : null;
  const seen = {};
  return form.getResponses()
    .sort((a, b) => a.getTimestamp() - b.getTimestamp())
    .map(r => {
      const dr = r.getResponseForItem(deptItem);
      const ir = r.getResponseForItem(idItem);
      const dept = dr ? deptName_(dr.getResponse()) : '';
      const id = ir ? normalizeId_(ir.getResponse()) : '';
      return { response: r, dept: dept, id: id, result: CONFIG.VERIFY ? checkId_(dept, id, key, seen) : 'ok' };
    });
}

function checkId_(dept, id, key, seen) {
  if (!id) return 'no_id';
  let expected;
  if (CONFIG.TEST_IDS[id]) {
    expected = CONFIG.TEST_IDS[id];
  } else {
    const code = roster_()[idHash_(id, key)];
    if (!code) return 'not_found';
    expected = code === '*' ? dept : Object.keys(ENROLLMENT)[parseInt(code, 36)]; // '*' = 소속 학과가 따로 없는 학생
  }
  if (expected !== dept) return 'dept_mismatch';
  if (seen[id]) return 'duplicate';
  seen[id] = true;
  return 'ok';
}

/** 명부: 항목마다 [해시 앞 8자리 + 학과 코드 1자리], 학과 코드는 ENROLLMENT 순서(36진수), '*'는 학과 무관 */
let rosterMap_ = null;
function roster_() {
  if (rosterMap_) return rosterMap_;
  const props = PropertiesService.getScriptProperties().getProperties();
  const n = Number(props.ROSTER_N || 0);
  if (!n) throw new Error('명부(ROSTER_*)가 올라가 있지 않습니다.');
  let all = '';
  for (let i = 0; i < n; i++) all += props['ROSTER_' + i] || '';
  const m = {};
  for (let i = 0; i < all.length; i += 9) m[all.substr(i, 8)] = all.charAt(i + 8);
  return (rosterMap_ = m);
}

/** 명부 업로드용 일회용 토큰 발급 (편집기에서 실행 → 로그의 토큰 사용, 한 번 쓰면 사라짐) */
function makeUploadToken() {
  const t = Utilities.getUuid();
  PropertiesService.getScriptProperties().setProperty('UPLOAD_TOKEN', t);
  Logger.log(t);
}

/** 명부 업로드 입구. 일회용 토큰이 맞을 때만 키와 명부를 저장하고 바로 집계를 다시 합니다. */
function doPost(e) {
  const props = PropertiesService.getScriptProperties();
  const token = props.getProperty('UPLOAD_TOKEN');
  let body = {};
  try { body = JSON.parse(e.postData.contents); } catch (err) {}
  const out = o => ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
  if (!token || body.token !== token) return out({ ok: false });
  props.deleteProperty('UPLOAD_TOKEN');
  const roster = String(body.roster || '');
  if (!body.key || !roster || roster.length % 9) return out({ ok: false, error: 'bad payload' });
  Object.keys(props.getProperties()).filter(k => /^ROSTER_\d+$/.test(k)).forEach(k => props.deleteProperty(k));
  const CHUNK = 8001; // 9의 배수, 속성 값 한도(9KB) 이내
  let n = 0;
  for (let i = 0; i < roster.length; i += CHUNK) props.setProperty('ROSTER_' + n++, roster.substr(i, CHUNK));
  props.setProperties({ ROSTER_N: String(n), ROSTER_KEY: String(body.key) });
  rosterMap_ = null;
  refresh();
  return out({ ok: true, entries: roster.length / 9 });
}

function rosterKey_() {
  const k = PropertiesService.getScriptProperties().getProperty('ROSTER_KEY');
  if (!k) throw new Error('스크립트 속성 ROSTER_KEY가 없습니다.');
  return k;
}

function normalizeId_(v) {
  return String(v || '').replace(/[^0-9]/g, '');
}

function idHash_(id, key) {
  return Utilities.computeHmacSha256Signature(id, key).slice(0, 4)
    .map(b => ('0' + ((b + 256) % 256).toString(16)).slice(-2)).join('');
}

function findItem_(form, title, types) {
  const item = types.reduce((all, t) => all.concat(form.getItems(t)), [])
    .find(it => it.getTitle().trim().indexOf(title) === 0);
  if (!item) throw new Error(`'${title}' 문항을 찾지 못했습니다.`);
  return item;
}

/** 설문 학번 문항에 10자리 숫자 형식 검사를 건다 (편집기에서 한 번 실행) */
function applyIdValidation() {
  const item = findItem_(FormApp.getActiveForm(), CONFIG.ID_TITLE, [FormApp.ItemType.TEXT]).asTextItem();
  item.setValidation(FormApp.createTextValidation()
    .requireTextMatchesPattern(CONFIG.ID_PATTERN)
    .setHelpText('학번 10자리를 숫자로만 입력해 주세요. (예: 2025123456)')
    .build());
}

/** 판정 결과를 붙인 응답 전체를 새 스프레드시트로 내보냄 (쿠폰 명단 · 결과 분석용, 편집기에서 실행) */
function exportVerified() {
  const form = FormApp.getActiveForm();
  const deptItem = findDeptItem_(form);
  const LABEL = { ok: '통과', no_id: '학번 없음', not_found: '명부에 없음', dept_mismatch: '학과 불일치', duplicate: '중복 응답' };
  const items = form.getItems().filter(it => [FormApp.ItemType.LIST, FormApp.ItemType.MULTIPLE_CHOICE,
    FormApp.ItemType.CHECKBOX, FormApp.ItemType.TEXT, FormApp.ItemType.PARAGRAPH_TEXT].indexOf(it.getType()) >= 0);
  const rows = [['판정', '제출 시각'].concat(items.map(it => it.getTitle()))];
  verifyAll_(form, deptItem).forEach(v => {
    rows.push([LABEL[v.result], v.response.getTimestamp()].concat(items.map(it => {
      const ir = v.response.getResponseForItem(it);
      const a = ir ? ir.getResponse() : '';
      return Array.isArray(a) ? a.join(', ') : a;
    })));
  });
  const name = '설문 응답 판정 ' + Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd HH:mm');
  const ss = SpreadsheetApp.create(name);
  ss.getSheets()[0].getRange(1, 1, rows.length, rows[0].length).setValues(rows);
  ss.getSheets()[0].setFrozenRows(1);
  const n = rows.slice(1).filter(r => r[0] === '통과').length;
  Logger.log(`${name}: 전체 ${rows.length - 1}건, 통과 ${n}건 → ${ss.getUrl()}`);
}

/** 판정 결과 요약을 로그로 출력 (개인정보 없이 건수만, 편집기에서 실행) */
function verifySummary() {
  const form = FormApp.getActiveForm();
  const list = verifyAll_(form, findDeptItem_(form));
  const byResult = {}, byDept = {};
  list.forEach(v => {
    byResult[v.result] = (byResult[v.result] || 0) + 1;
    const d = byDept[v.dept] = byDept[v.dept] || { 전체: 0, 통과: 0 };
    d.전체++; if (v.result === 'ok') d.통과++;
  });
  Logger.log('전체 응답 ' + list.length + '건 / 판정별 ' + JSON.stringify(byResult));
  Logger.log('학과별 ' + JSON.stringify(byDept));
  Logger.log('테스트 학번 응답 ' + list.filter(v => CONFIG.TEST_IDS[v.id] || /^2099/.test(v.id)).map(v => v.dept + ':' + v.result).join(', '));
}

function readStats_() {
  const raw = PropertiesService.getScriptProperties().getProperty(STATS_KEY);
  return raw ? JSON.parse(raw) : null;
}

/** 설문 첫 안내문을 확정 문구로 되돌림 (다른 스크립트가 덮어썼을 때 편집기에서 수동 실행) */
const INTRO_TEXT = [
  '안녕하세요, 삼육대학교 기획처·학생혁신기획단입니다.',
  '',
  '이 설문은 학생들이 강의실과 교육 기자재를 이용하며 겪는 불편을 조사해, 학교가 시설 개선 우선순위를 정할 때 근거 자료로 쓰기 위해 진행합니다. 실제로 겪은 일을 기준으로 답해 주시고, 불편했던 장소와 상황을 적어 주시면 개선 대상을 정하는 데 큰 도움이 됩니다.',
  '',
  '· 응답 기준: 2026학년도 2학기 개강 이후 지금까지',
  '· 필수 10문항(리커트 9문항, 우선순위 1문항), 선택 3문항(주관식), 약 3분',
  "· 해당 기자재나 공간을 이용하지 않아 불편이 없었다면 '전혀 없었다'를 골라 주세요.",
  '· 설문 기간: 2026년 11월 15일(일)까지',
  '· 참여 경품: 음료 쿠폰(모바일) — 학과별 재학생의 10%까지 선착순 지급, 수량이 다 차면 해당 학과는 마감됩니다.',
  '· 학번과 소속 학과가 학적과 일치하는 응답만 참여 인원과 쿠폰 대상으로 인정됩니다. (1인 1회)',
].join('\n');

function restoreIntro() {
  FormApp.getActiveForm().setDescription(INTRO_TEXT);
}
