/**
 * 「학과 교육환경 이용 실태와 개선 수요 조사」 설문 연동 스크립트
 * 설문지에 붙은(바인딩된) Apps Script 프로젝트에 붙여넣어 사용합니다.
 *
 * 하는 일
 *  1) 응답이 들어올 때마다 학과별 참여 인원을 집계합니다.
 *  2) 설문 선택지의 "현재 참여 학생 비율"을 갱신하고, 10%를 채운 학과는 목록에서 뺍니다.
 *     설문 안의 "학과별 실시간 참여 현황" 그래프 이미지도 다시 그립니다.
 *  3) GitHub 대시보드가 읽어 갈 집계 JSON을 웹앱 주소(/exec)로 내보냅니다.
 *     내보내는 값은 학과명 · 참여 인원 · 쿠폰 수뿐이고, 학번 · 전화번호는 내보내지 않습니다.
 *
 * 처음 설정
 *  ① 아래 ENROLLMENT에 학과별 재학생 수를 채웁니다.
 *  ② 편집기에서 setup 함수를 한 번 실행하고 권한을 허용합니다. (응답 트리거 설치 + 첫 집계)
 *  ③ 배포 → 새 배포 → 웹 앱 (실행: 나 / 액세스: 모든 사용자) → /exec 주소를 대시보드 index.html의 API_URL에 넣습니다.
 */

const CONFIG = {
  DEPT_TITLE: '0-1. 소속 학과', // 학과 문항 제목 (앞부분만 맞아도 됨)
  RATE: 0.1,                    // 재학생 대비 목표 비율 (10%)
  CLOSE_FULL_DEPTS: true,       // 목표를 채운 학과를 선택지에서 뺄지
  UPDATE_LABELS: true,          // 선택지 옆 "현재 참여 학생 비율"을 갱신할지
  UPDATE_CHART: true,           // 설문 안의 참여 현황 그래프 이미지를 다시 그릴지
  CHART_TITLE: '학과별 실시간 참여 현황', // 그래프 이미지 항목 제목 (앞부분)
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
  form.getResponses().forEach(r => {
    const ir = r.getResponseForItem(item);
    if (!ir) return;
    const name = deptName_(ir.getResponse());
    counts[name] = (counts[name] || 0) + 1;
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
].join('\n');

function restoreIntro() {
  FormApp.getActiveForm().setDescription(INTRO_TEXT);
}
