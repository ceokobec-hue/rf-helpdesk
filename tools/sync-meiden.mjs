#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────
// Meiden 진공 커패시터 데이터 수집 · 추출 · 대조
//
//   목록 JSON 2개 ──▶ 정규화 ──▶ 데이터시트 PDF 내려받기
//        │                              │
//        └────────── 대조(R2) ◀─────── 스펙 추출
//                       │
//                   models.json + sync-report.json
//
// 【R2】 목록 JSON과 PDF 양쪽에 있는 값(전압·전류·용량·외경)은 반드시 대조한다.
//        불일치는 조용히 넘기지 않고 flag로 남겨 화면에 ⚠️로 띄운다.
// 【R1】 못 읽은 항목은 null. 유추하지 않는다.
//
//   사용법:  node tools/sync-meiden.mjs [--force]
//            --force : 이미 받은 PDF도 다시 내려받음
// ─────────────────────────────────────────────────────────────
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractFromBuffer, VFC_NOT_APPLICABLE } from './lib/extract-spec.mjs';
import { computeEffective } from './lib/effective.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ORIGIN = 'https://www.meidensha.com';
const BASE = `${ORIGIN}/products/industry/prod_03/prod_03_08/pdf_search`;

const SOURCES = [
  { kind: 'VVC', label: '가변(Variable)', cat: 'psav', pageDir: 'prod_03_08_01' },
  { kind: 'VFC', label: '고정(Fixed)',    cat: 'psfv', pageDir: 'prod_03_08_02' },
];
const CATALOG = { doc: 'BA80-3116', url: `${ORIGIN}/catalog/BA80-3116.pdf`, title: 'Vacuum Capacitors Catalog' };
const UA = 'Mozilla/5.0 (compatible; rf-helpdesk internal datasheet sync)';
const CONCURRENCY = 6;                 // 상대 서버 배려
const FORCE = process.argv.includes('--force');

const log = (...a) => console.log(...a);
const num = v => { const n = Number(String(v ?? '').trim()); return Number.isFinite(n) ? n : null; };

async function getJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  const lastMod = res.headers.get('last-modified');
  const txt = (await res.text()).replace(/^﻿/, '');   // BOM 제거 (실측: 붙어 있음)
  return { data: JSON.parse(txt), lastMod };
}

/** 동시 실행 개수를 제한한 map */
async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

/** 공식 제품 페이지 — series_value가 페이지 번호와 1:1 대응 (실측 확인) */
const officialPage = (pageDir, seriesValue) =>
  `${ORIGIN}/products/industry/prod_03/prod_03_08/${pageDir}/${pageDir}_${seriesValue}/`;

/** 목록 JSON 1행 → 표준 모델 레코드 */
function normalize(row, src) {
  const isV = src.kind === 'VVC';
  return {
    id: row.part_number,
    kind: src.kind,
    type: row.type,
    part_number: row.part_number,
    series: row.series_label,
    series_value: row.series_value,
    list: {
      cap_min: isV ? num(row.capacitance_min) : num(row.capacitance),
      cap_max: isV ? num(row.capacitance_max) : num(row.capacitance),
      v_rf_working: num(row.voltage_rf_working),
      v_peak_test: num(row.voltage_peak_test),
      i_max: num(row.maximum_allowable_current),
      diameter: num(row.external_dimension),
    },
    pdf_link: row.pdf_link || null,
    official_page: officialPage(src.pageDir, row.series_value),
    source_list_url: `${BASE}/${src.cat}_json/master.json`,
  };
}

/** 목록값 ↔ PDF값 대조 (R2) */
function crossCheck(m, spec) {
  const checks = [];
  const cmp = (field, listVal, pdfVal, tol = 0.001) => {
    if (listVal == null || pdfVal == null) {
      checks.push({ field, list: listVal, pdf: pdfVal, ok: null, note: '한쪽 값 없음' });
      return;
    }
    const ok = Math.abs(listVal - pdfVal) <= Math.max(tol, Math.abs(listVal) * 0.001);
    checks.push({ field, list: listVal, pdf: pdfVal, ok });
  };
  const f = spec.fields;
  cmp('v_rf_working', m.list.v_rf_working, f.rf_working_voltage_kvp?.value ?? null);
  cmp('v_peak_test', m.list.v_peak_test, f.peak_test_voltage_kvp?.value ?? null);
  cmp('i_max', m.list.i_max, f.max_current_arms?.value ?? null);
  cmp('diameter', m.list.diameter, f.outer_diameter_mm?.value ?? null);
  const c = f.capacitance_pf;
  if (c?.kind === 'range') {
    cmp('cap_min', m.list.cap_min, c.min);
    cmp('cap_max', m.list.cap_max, c.max);
  } else if (c?.kind === 'fixed') {
    cmp('cap_nominal', m.list.cap_min, c.nominal);
  }
  return checks;
}

// ── 실행 ──────────────────────────────────────────────────────
log('━'.repeat(64));
log(' Meiden 진공 커패시터 데이터 수집');
log(' 시각:', new Date().toISOString());
log('━'.repeat(64));

const fetchedAt = new Date().toISOString();
const models = [];
const sourceMeta = {};

for (const src of SOURCES) {
  const url = `${BASE}/${src.cat}_json/master.json`;
  const { data, lastMod } = await getJson(url);
  sourceMeta[src.kind] = { url, last_modified: lastMod, count: data.length, fetched_at: fetchedAt };
  log(`\n[목록] ${src.kind} ${src.label}: ${data.length}개  (서버 최종수정 ${lastMod ?? '미제공'})`);
  for (const row of data) models.push(normalize(row, src));
}

// ── PDF 내려받기 + 스펙 추출 ─────────────────────────────────
await fs.mkdir(path.join(ROOT, 'datasheets'), { recursive: true });
await fs.mkdir(path.join(ROOT, 'data'), { recursive: true });

let dl = 0, cached = 0, failed = 0, extracted = 0, noSheet = 0;
log(`\n[데이터시트] ${models.length}개 모델 처리 시작 (동시 ${CONCURRENCY})…`);

await pool(models, CONCURRENCY, async (m) => {
  if (!m.pdf_link) { m.spec = null; m.flags = ['no_datasheet']; noSheet++; return; }

  const fname = decodeURIComponent(m.pdf_link.split('/').pop());
  const rel = path.join('datasheets', fname);
  const abs = path.join(ROOT, rel);
  let buf;

  try {
    if (!FORCE) { try { buf = await fs.readFile(abs); cached++; } catch { /* 없으면 받는다 */ } }
    if (!buf) {
      const res = await fetch(ORIGIN + m.pdf_link, { headers: { 'User-Agent': UA } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      buf = Buffer.from(await res.arrayBuffer());
      await fs.writeFile(abs, buf);
      dl++;
    }
  } catch (e) {
    m.spec = null; m.flags = [`download_failed:${e.message}`]; failed++; return;
  }

  m.pdf = {
    url: ORIGIN + m.pdf_link,
    file: rel.replace(/\\/g, '/'),
    bytes: buf.length,
    sha256: createHash('sha256').update(buf).digest('hex').slice(0, 16),
  };

  try {
    const r = await extractFromBuffer(buf);
    const na = m.kind === 'VFC' ? VFC_NOT_APPLICABLE : [];
    const realMissing = r.missing.filter(k => !na.includes(k));
    m.spec = r.fields;
    m.doc_no = r.docNo;
    m.type_label = r.typeLabel;
    m.cooling = r.cooling;
    m.pdf_part_no = r.partNo;
    m.missing = realMissing;
    m.checks = crossCheck(m, r);
    m.flags = [];
    if (realMissing.length) m.flags.push(`extract_missing:${realMissing.join('|')}`);
    for (const c of m.checks) if (c.ok === false) m.flags.push(`mismatch:${c.field}`);
    // 품번 불일치 = 링크 오류. 스펙 차이보다 심각하므로 별도 플래그.
    if (r.partNo && r.partNo.toUpperCase() !== m.part_number.toUpperCase()) {
      m.flags.push(`partno_mismatch:${r.partNo}`);
    }
    extracted++;
  } catch (e) {
    m.spec = null; m.flags = [`extract_failed:${e.message}`]; failed++;
  }
});

// ── 리포트 ────────────────────────────────────────────────────
// 유효값 산정 (보수적 채택) — 대체품 판정·계산기가 모두 이 값을 쓴다
for (const m of models) m.effective = computeEffective(m);

const mismatched = models.filter(m => (m.flags ?? []).some(f => f.startsWith('mismatch:')));
const missingF  = models.filter(m => (m.flags ?? []).some(f => f.startsWith('extract_missing:')));
const failedF   = models.filter(m => (m.flags ?? []).some(f => /failed/.test(f)));
const partnoF   = models.filter(m => (m.flags ?? []).some(f => f.startsWith('partno_mismatch:')));
const watercool = models.filter(m => m.cooling === 'water');

log('\n' + '━'.repeat(64));
log(' 수집 결과');
log('━'.repeat(64));
log(` 모델 총계        ${models.length}개  (VVC ${models.filter(m=>m.kind==='VVC').length} · VFC ${models.filter(m=>m.kind==='VFC').length})`);
log(` PDF 신규 다운로드 ${dl}개 · 기존 재사용 ${cached}개`);
log(` 스펙 추출 성공   ${extracted}개`);
log(` 데이터시트 없음   ${noSheet}개  ${noSheet ? '→ ' + models.filter(m=>!m.pdf_link).map(m=>m.id).join(', ') : ''}`);
log(` 수랭식 모델      ${watercool.length}개  (대체품 판정 시 공랭과 교차 금지)`);
log('');
log(` ❗ 추출 누락      ${missingF.length}개`);
missingF.slice(0, 15).forEach(m => log(`      · ${m.id} → ${m.missing.join(', ')}`));
log(` ❗ 목록↔PDF 불일치 ${mismatched.length}개`);
mismatched.slice(0, 20).forEach(m => {
  const bad = m.checks.filter(c => c.ok === false)
    .map(c => `${c.field}: 목록 ${c.list} vs PDF ${c.pdf}`).join(' / ');
  log(`      · ${m.id} (${m.type}) → ${bad}`);
});
log(` 🚨 품번 불일치     ${partnoF.length}개  (목록이 다른 품번의 데이터시트를 링크)`);
partnoF.forEach(m => log(`      · 목록 ${m.id} → PDF ${m.pdf_part_no}  (${path.basename(m.pdf.file)})`));
log(` ❗ 처리 실패       ${failedF.length}개`);
failedF.slice(0, 10).forEach(m => log(`      · ${m.id} → ${m.flags.join(',')}`));

const out = {
  generated_at: fetchedAt,
  source: { ...sourceMeta, catalog: CATALOG },
  summary: {
    total: models.length,
    extracted, downloaded: dl, cached,
    no_datasheet: noSheet,
    extract_missing: missingF.length,
    mismatch: mismatched.length,
    partno_mismatch: partnoF.length,
    failed: failedF.length,
    water_cooled: watercool.length,
  },
  models,
};
await fs.writeFile(path.join(ROOT, 'data/models.json'), JSON.stringify(out, null, 1));
await fs.writeFile(path.join(ROOT, 'data/sync-report.json'), JSON.stringify({
  generated_at: fetchedAt, summary: out.summary,
  mismatched: mismatched.map(m => ({ id: m.id, type: m.type, checks: m.checks.filter(c => c.ok === false) })),
  missing: missingF.map(m => ({ id: m.id, missing: m.missing })),
  partno_mismatch: partnoF.map(m => ({ list_part_no: m.id, pdf_part_no: m.pdf_part_no, pdf: m.pdf.file })),
  failed: failedF.map(m => ({ id: m.id, flags: m.flags })),
}, null, 1));

log('\n ✅ data/models.json · data/sync-report.json 저장 완료');
log('━'.repeat(64));
