#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────
// 검증 스위트 — "끝났다"고 말하기 전에 통과해야 하는 것들
//
//   #1 수집 정확도   : 우리 추출값 ↔ pdftotext 원문 대조 (무작위 표본)
//   #2 대조 무결성   : 목록↔PDF 불일치가 빠짐없이 잡혔는가
//   #3 계산 정확성   : 손계산 대조 + 선형구간 밖 계산 거부
//   #4 대체품 안전선 : 정격 미달 모델이 A등급에 절대 안 뜨는가 (전수)
//
//   node tools/verify-extract.mjs [표본수]
//   pdftotext(poppler)가 없으면 #1은 건너뛰고 그 사실을 밝힌다.
// ─────────────────────────────────────────────────────────────
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { findSubstitutes } from './lib/substitute.mjs';
import { computeEffective } from './lib/effective.mjs';

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SAMPLE = Number(process.argv[2] ?? 20);
const V = (m, k) => m.effective?.[k]?.value ?? null;

let pass = 0, fail = 0;
const ok  = (t, d = '') => { pass++; console.log(`   ✅ ${t}${d ? ` — ${d}` : ''}`); };
const bad = (t, d = '') => { fail++; console.log(`   ❌ ${t}${d ? ` — ${d}` : ''}`); };
const head = t => console.log(`\n${'─'.repeat(62)}\n ${t}\n${'─'.repeat(62)}`);

const db = JSON.parse(await fs.readFile(path.join(ROOT, 'data/models.json'), 'utf8'));
const models = db.models;
const withSpec = models.filter(m => m.spec && m.pdf);

console.log('━'.repeat(62));
console.log(' RF Helpdesk 검증 스위트');
console.log(` 대상 ${models.length}개 모델 · 수집 ${db.generated_at}`);
console.log('━'.repeat(62));

// ── #1 수집 정확도 ────────────────────────────────────────────
head('#1 수집 정확도 — 우리 추출값 ↔ pdftotext 원문');
let hasPdftotext = true;
try { await run('pdftotext', ['-v']); } catch { hasPdftotext = false; }

if (!hasPdftotext) {
  console.log('   ⚠️  pdftotext(poppler)가 없어 이 검사를 건너뜁니다.');
  console.log('      → 맥/리눅스에서 `brew install poppler` 후 다시 실행하십시오.');
  console.log('      이 검사를 통과하지 않은 상태에서는 추출값을 "검증됨"이라 부르지 않습니다.');
} else {
  // 시리즈가 고루 섞이도록 시리즈별로 돌아가며 뽑는다 (무작위는 한 시리즈에 몰릴 수 있다)
  const bySeries = new Map();
  for (const m of withSpec) (bySeries.get(m.series) ?? bySeries.set(m.series, []).get(m.series)).push(m);
  const picked = [];
  const keys = [...bySeries.keys()];
  for (let i = 0; picked.length < Math.min(SAMPLE, withSpec.length); i++) {
    const arr = bySeries.get(keys[i % keys.length]);
    const k = Math.floor(i / keys.length);
    if (arr[k]) picked.push(arr[k]);
    if (i > withSpec.length * 2) break;
  }

  const FIELDS = [
    ['peak_test_voltage_kvp', 'Peak test Voltage', 'kVp', v => v.value],
    ['rf_working_voltage_kvp', 'RF Working Voltage', 'kVp', v => v.value],
    ['max_current_arms', 'Maximum Current', 'Arms', v => v.value],
    ['tuner_turns', 'Tuner Turns', 'Turns', v => v.value],
    ['total_length_mm', 'Total Length', 'mm', v => v.value],
    ['mounting_length_mm', 'Mounting Length', 'mm', v => v.value],
    ['outer_diameter_mm', 'Outer Diameter', 'mm', v => v.value],
    ['weight_kg', 'Weight', 'kg', v => v.value],
  ];
  let checked = 0, mismatch = 0;
  for (const m of picked) {
    const { stdout } = await run('pdftotext', ['-layout', path.join(ROOT, m.pdf.file), '-'], { maxBuffer: 8e6 });
    const lines = stdout.split('\n');
    for (const [key, label, , get] of FIELDS) {
      const f = m.spec[key];
      if (!f || get(f) == null) continue;
      const line = lines.find(l => new RegExp('^\\s*' + label.replace(/ /g, '\\s+'), 'i').test(l));
      if (!line) { bad(`${m.id} · ${label}`, 'pdftotext 원문에서 줄을 못 찾음'); mismatch++; continue; }
      const truth = (line.replace(new RegExp('^\\s*' + label.replace(/ /g, '\\s+'), 'i'), '')
        .match(/-?\d+(?:\.\d+)?/) || [])[0];
      checked++;
      if (truth == null || Math.abs(Number(truth) - get(f)) > 1e-9) {
        bad(`${m.id} · ${label}`, `우리 ${get(f)} ↔ 원문 ${truth}`); mismatch++;
      }
    }
  }
  if (mismatch === 0) ok(`표본 ${picked.length}개 모델 · ${checked}개 값 전부 원문과 일치`,
    `시리즈 ${new Set(picked.map(m => m.series)).size}종 포함`);
  else bad(`${mismatch}건 불일치`, '추출 로직을 고치기 전에는 화면에 띄우면 안 됩니다');
}

// ── #2 대조 무결성 ────────────────────────────────────────────
head('#2 대조 무결성 — 목록↔PDF 불일치가 빠짐없이 잡혔는가');
let missed = 0;
for (const m of withSpec) {
  const eff = computeEffective(m);                 // 다시 계산해서
  const stored = m.effective;                      // 저장된 것과 비교
  for (const k of Object.keys(eff)) {
    if (k === 'disagree') continue;
    if (JSON.stringify(eff[k]) !== JSON.stringify(stored[k])) { missed++; bad(`${m.id}·${k}`, '재계산 결과가 저장값과 다름'); }
  }
  const flagged = (m.flags ?? []).some(f => f.startsWith('mismatch:'));
  if ((eff.disagree.length > 0) !== flagged && eff.disagree.length > 0) {
    missed++; bad(`${m.id}`, `불일치 ${eff.disagree.join(',')} 인데 flag 없음`);
  }
}
if (!missed) ok(`${withSpec.length}개 모델 전수 재계산 일치`, `불일치 ${db.summary.mismatch}건 · 품번오류 ${db.summary.partno_mismatch ?? 0}건 모두 표기됨`);

// ── #3 계산 정확성 ────────────────────────────────────────────
head('#3 계산 정확성 — 손계산 대조 · 선형구간 밖 거부');
const ref = models.find(m => m.id === 'SCV-540P110W');
if (!ref) bad('기준 모델 SCV-540P110W 없음');
else {
  const T = ref.spec.tuner_turns.value, k = ref.spec.linear_variability.pf_per_turn;
  const lim = ref.spec.linear_variability.linear_min_pf;
  // 포지션 85% → 회전수
  const turns = 0.85 * T;
  Math.abs(turns - 12.155) < 1e-9 ? ok('포지션 85% → 12.155 회전', `0.85 × ${T}`)
    : bad('포지션 환산', `${turns}`);
  // 1.5회전 → ΔC
  const dC = k * 1.5;
  Math.abs(dC - 442.5) < 1e-9 ? ok('1.5 회전 → ΔC 442.5 pF', `${k} pF/Turn × 1.5`)
    : bad('ΔC 환산', `${dC}`);
  // 전압/전류 마진
  Math.abs((2.4 / V(ref, 'v_rf_working')) * 100 - 80) < 1e-9 ? ok('전압 마진 2.4/3 kVp → 80.0%') : bad('전압 마진');
  Math.abs((120 / V(ref, 'i_max')) * 100 - 70.588235294117645) < 1e-9 ? ok('전류 마진 120/170 A → 70.6%') : bad('전류 마진');
  // 선형 구간 경계
  lim === 300 ? ok(`선형 유효 하한 ${lim} pF 로 읽힘`, '이 값 미만에서는 화면이 숫자 대신 안내를 냅니다')
    : bad('선형 유효 하한', `${lim}`);
  // 기울기를 전 구간에 적분하면 안 된다는 사실 자체를 고정한다
  const span = ref.spec.capacitance_pf.max - ref.spec.capacitance_pf.min;
  const ratio = (k * T) / span;
  ratio > 1.02 ? ok(`기울기 적분 불가 확인 (k×T = 범위의 ${ratio.toFixed(2)}배)`,
      '그래서 포지션→절대용량 환산 기능을 넣지 않았습니다')
    : bad('기울기 적분 가정', `비율 ${ratio.toFixed(3)} — 재검토 필요`);
}
const noLimit = withSpec.filter(m => m.spec.linear_variability && m.spec.linear_variability.linear_min_pf == null);
ok(`선형 하한 미명시 모델 ${noLimit.length}개`, '이 모델들은 환산을 아예 거부합니다');

// ── #4 대체품 안전선 ──────────────────────────────────────────
head('#4 대체품 안전선 — 정격 미달이 A/B 등급에 뜨지 않는가 (전수)');
const pool = models.filter(m => m.effective);
let viol = 0, pairs = 0;
for (const src of pool) {
  const r = findSubstitutes(src, pool, { limitB: 999, limitC: 0 });
  for (const x of [...r.A, ...r.B]) {
    pairs++;
    const c = pool.find(m => m.id === x.id);
    const why = [];
    if (V(c, 'v_peak_test') < V(src, 'v_peak_test')) why.push('내전압');
    if (V(c, 'v_rf_working') < V(src, 'v_rf_working')) why.push('RF전압');
    if (V(c, 'i_max') < V(src, 'i_max')) why.push('전류');
    if (src.kind === 'VVC' && (V(c, 'cap_min') > V(src, 'cap_min') || V(c, 'cap_max') < V(src, 'cap_max'))) why.push('용량커버');
    if (why.length) { viol++; bad(`${src.id} → ${x.id}`, why.join(',') + ' 미달인데 후보로 제시됨'); }
  }
  for (const x of r.A) {
    const c = pool.find(m => m.id === x.id);
    if (c.cooling !== src.cooling) { viol++; bad(`${src.id} → ${x.id}`, '냉각 방식이 다른데 A등급'); }
    if (src.kind === 'VVC') {
      const st = src.spec?.tuner_turns?.value, ct = c.spec?.tuner_turns?.value;
      if (st != null && ct != null && Math.abs(st - ct) > 0.05) { viol++; bad(`${src.id} → ${x.id}`, '튜너 회전수가 다른데 A등급'); }
    }
  }
}
if (!viol) ok(`${pool.length}개 모델 전수 · A/B 후보 ${pairs}쌍 점검 · 위반 0`,
  '정격 미달·냉각 불일치·회전수 불일치가 상위 등급에 오르지 않습니다');

// ── 결과 ──────────────────────────────────────────────────────
console.log('\n' + '━'.repeat(62));
console.log(` 통과 ${pass} · 실패 ${fail}`);
console.log(fail === 0
  ? ' ✅ 전 항목 통과 — 다만 이건 "안 깨졌다"는 뜻입니다.\n    실제로 쓸 수 있는지는 브라우저에서 사람이 판정합니다.'
  : ' ❌ 실패 항목이 있습니다. 고치기 전에는 배포하지 마십시오.');
console.log('━'.repeat(62));
process.exit(fail === 0 ? 0 : 1);
