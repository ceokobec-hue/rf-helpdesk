// ─────────────────────────────────────────────────────────────
// Meiden 진공 커패시터 데이터시트 PDF → 구조화 스펙
//
// 【절대 규칙 R1】 추측하지 않는다.
//   못 읽은 항목은 null로 두고 missing[]에 남긴다.
//   비슷한 모델에서 유추하거나 기본값을 채워 넣지 않는다.
// 【추적성】 모든 값은 원문 줄(raw)을 함께 보관한다.
//   → 화면/문서에서 "이 숫자는 이 줄에서 나왔다"를 보여주기 위함.
// ─────────────────────────────────────────────────────────────
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

const NUM = '[-+]?\\d+(?:\\.\\d+)?';
// 하이픈·엔대시·물결(범위 구분자)
const DASH = '[-–—~〜]';

/** PDF 버퍼 → 페이지별 줄 배열 (좌표로 줄 재구성) */
export async function pdfToLines(buf, { maxPages = 2 } = {}) {
  const task = pdfjs.getDocument({
    data: new Uint8Array(buf),
    useSystemFonts: false,
    isEvalSupported: false,
  });
  const doc = await task.promise;

  const pages = [];
  const n = Math.min(doc.numPages, maxPages);
  for (let p = 1; p <= n; p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    // ── 줄 재구성 ──────────────────────────────────────────
    // 【함정】 같은 줄이라도 라벨과 값의 Y가 미세하게 다르다.
    //   실측: "Peak test Voltage"=680.82 / "5 kVp"=680.44 (0.38pt 차)
    //   반올림으로 묶으면 라벨과 값이 갈라져 전 항목 추출이 실패한다.
    //   → 허용오차(±2.5pt) 군집화로 묶는다. 줄 간격이 약 19pt라
    //     인접한 다른 줄과 섞일 위험은 없다.
    const items = [];
    for (const it of tc.items) {
      if (typeof it.str !== 'string' || it.str === '') continue;
      items.push({ x: it.transform[4], y: it.transform[5], s: it.str });
    }
    items.sort((a, b) => b.y - a.y);                    // 위 → 아래
    const clusters = [];
    const TOL = 2.5;
    for (const it of items) {
      const last = clusters[clusters.length - 1];
      if (last && Math.abs(last.y - it.y) <= TOL) last.cells.push(it);
      else clusters.push({ y: it.y, cells: [it] });
    }
    const lines = clusters
      .map(c => c.cells.sort((a, b) => a.x - b.x)
        .map(z => z.s).join(' ')
        .replace(/\s+/g, ' ').trim())
      .filter(Boolean);
    pages.push(lines);
    page.cleanup?.();
  }
  await task.destroy();   // v6: 정리는 loadingTask 쪽
  return pages;
}

/** 라벨로 시작하는 줄 찾기 (공백 개수 무관, 대소문자 무관) */
function lineFor(lines, label) {
  const re = new RegExp('^\\s*' + label.split(/\s+/).map(esc).join('\\s+') + '\\b', 'i');
  return lines.find(l => re.test(l)) ?? null;
}
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 라벨 뒤 부분만 남기기 */
function tail(line, label) {
  if (!line) return null;
  const re = new RegExp('^\\s*' + label.split(/\s+/).map(esc).join('\\s+') + '\\s*', 'i');
  return line.replace(re, '').trim();
}

/**
 * 데이터시트 1장 → 스펙 객체
 * @returns {{fields:Object, missing:string[], docNo:string|null, title:string|null}}
 */
export function parseSpec(pages) {
  const p1 = pages[0] ?? [];
  const fields = {};
  const missing = [];

  // 값 + 원문줄을 함께 담는다
  const put = (key, label, parser) => {
    const line = lineFor(p1, label);
    const rest = tail(line, label);
    const v = rest == null ? null : parser(rest);
    if (v == null) { fields[key] = null; missing.push(key); }
    else fields[key] = { ...v, raw: line };
  };

  const one = unit => rest => {
    const m = rest.match(new RegExp(`^\\s*φ?\\s*(${NUM})\\s*${unit}`, 'i'));
    return m ? { value: Number(m[1]) } : null;
  };

  put('peak_test_voltage_kvp', 'Peak test Voltage', one('kVp'));
  put('rf_working_voltage_kvp', 'RF Working Voltage', one('kVp'));

  // 가변: "45 - 4000 pF" / 고정: "1000 ± 50.0 pF"
  put('capacitance_pf', 'Capacitance nominal', rest => {
    let m = rest.match(new RegExp(`^\\s*(${NUM})\\s*${DASH}\\s*(${NUM})\\s*pF`, 'i'));
    if (m) return { kind: 'range', min: Number(m[1]), max: Number(m[2]) };
    m = rest.match(new RegExp(`^\\s*(${NUM})\\s*±\\s*(${NUM})\\s*pF`, 'i'));
    if (m) return { kind: 'fixed', nominal: Number(m[1]), tolerance: Number(m[2]) };
    m = rest.match(new RegExp(`^\\s*(${NUM})\\s*pF`, 'i'));
    if (m) return { kind: 'fixed', nominal: Number(m[1]), tolerance: null };
    return null;
  });

  // "295 ± 15 pF/Turn (C≧ 300 pF)"  ← 선형 유효 하한이 모델마다 다름 (규칙 R3)
  put('linear_variability', 'Linear Variability', rest => {
    const m = rest.match(new RegExp(`^\\s*(${NUM})\\s*(?:±\\s*(${NUM}))?\\s*pF\\s*/\\s*Turn`, 'i'));
    if (!m) return null;
    const lin = rest.match(new RegExp(`C\\s*[≧≥>=]+\\s*(${NUM})\\s*pF`, 'i'));
    return {
      pf_per_turn: Number(m[1]),
      tolerance: m[2] != null ? Number(m[2]) : null,
      linear_min_pf: lin ? Number(lin[1]) : null,   // null이면 계산기에서 환산 거부
    };
  });

  put('max_current_arms', 'Maximum Current', rest => {
    const m = rest.match(new RegExp(`^\\s*(${NUM})\\s*Arms`, 'i'));
    if (!m) return null;
    const f = rest.match(new RegExp(`\\(\\s*(${NUM})\\s*MHz`, 'i'));
    return { value: Number(m[1]), freq_mhz: f ? Number(f[1]) : null };
  });

  put('tuner_turns', 'Tuner Turns', rest => {
    const m = rest.match(new RegExp(`^\\s*(${NUM})\\s*(?:±\\s*(${NUM}))?\\s*Turns`, 'i'));
    return m ? { value: Number(m[1]), tolerance: m[2] != null ? Number(m[2]) : null } : null;
  });

  // "- Nm" (미규정)은 0이 아니라 null. 0으로 두면 "토크 0"이라는 거짓이 된다.
  put('tuner_torque_nm', 'Tuner Operating Torque', rest => {
    if (/^\s*[-–—]\s*Nm/i.test(rest)) return { value: null, note: '데이터시트 미규정' };
    const m = rest.match(new RegExp(`^\\s*(${NUM})\\s*Nm`, 'i'));
    return m ? { value: Number(m[1]) } : null;
  });

  put('total_length_mm', 'Total Length', one('mm'));
  put('mounting_length_mm', 'Mounting Length', one('mm'));
  put('outer_diameter_mm', 'Outer Diameter', one('mm'));
  put('weight_kg', 'Weight', one('kg'));

  // 문서번호 — 개정 접미사가 붙는다 (실측: MQ90A40146A = rev A).
  // \b로 끝을 막으면 접미사 때문에 매칭이 깨진다.
  const docNo = (p1.join('\n').match(/\b(MQ\d{2}[A-Z]\d{4,6}[A-Z]?)/) || [])[1] ?? null;

  // 제목 예: "Variable Type Vacuum Capacitor (VP115 Water Cooling Type)"
  const title = p1.find(l => /Type Vacuum Capacitor/i.test(l)) ?? null;
  const typeLabel = title ? (title.match(/\(([^)]+)\)/) || [])[1]?.trim() ?? null : null;

  // 냉각 방식 — 대체품 판정에 결정적(수랭↔공랭은 배관이 달라 교체 불가).
  // 【R1】 "수랭"이라고 적힌 것만 water. 안 적혀 있으면 'air'로 단정하지 않고
  //        unspecified로 남긴다. 화면에서 "데이터시트 미명시"로 표시한다.
  const cooling = title && /water\s*cool/i.test(title) ? 'water' : 'unspecified';

  // PDF 표지의 품번 — 목록이 엉뚱한 데이터시트를 링크한 경우를 잡는다.
  //   실측: 목록 'SCF-151.15Z' 행이 'SCF-151.5Z' 데이터시트를 가리키고 있었다.
  //   스펙 오타보다 심각한 유형이라 따로 표시한다.
  const partNo = (p1.slice(0, 6).join(' ').match(/\bSC[VTF]W?-[0-9][0-9A-Za-z.\-]*/) || [])[0] ?? null;

  return { fields, missing, docNo, title, typeLabel, cooling, partNo };
}

/** 고정형(VFC)에는 원래 없는 항목 — 누락으로 세지 않는다 */
export const VFC_NOT_APPLICABLE = ['linear_variability', 'tuner_turns', 'tuner_torque_nm'];

export async function extractFromBuffer(buf) {
  const pages = await pdfToLines(buf);
  return { ...parseSpec(pages), lineCount: pages[0]?.length ?? 0 };
}
