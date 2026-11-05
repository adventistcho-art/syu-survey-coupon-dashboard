/**
 * 「학과 교육환경 이용 실태와 개선 수요 조사」 설문 연동 스크립트
 * 설문지에 붙은(바인딩된) Apps Script 프로젝트에 붙여넣어 사용합니다.
 *
 * 하는 일
 *  1) 응답이 들어올 때마다 학과별 참여 인원을 집계합니다.
 *  2) 설문 선택지의 "현재 참여 학생 비율"을 갱신하고, 10%를 채운 학과는 목록에서 뺍니다.
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

function readStats_() {
  const raw = PropertiesService.getScriptProperties().getProperty(STATS_KEY);
  return raw ? JSON.parse(raw) : null;
}
