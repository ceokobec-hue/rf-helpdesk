// ─────────────────────────────────────────────────────────────
// 대체품(호환 후보) 판정
//
// 진공 커패시터를 바꿔 끼우려면 네 가지가 동시에 맞아야 한다.
//   ① 전기  전압·전류 정격이 원본 이상, 용량 범위가 원본을 덮을 것
//   ② 기계  외경·장착길이가 같을 것 (매처 하우징에 들어가야 한다)
//   ③ 제어  튜너 회전수가 같을 것 — 다르면 매처의 「포지션 ↔ 용량」
//           대응이 통째로 바뀌어 재캘리브레이션 없이는 매칭이 안 잡힌다
//   ④ 냉각  수랭 ↔ 공랭 교차 금지 (냉각수 배관 자체가 없다)
//
// 판정에 쓰는 값은 effective(보수적 유효값)다. 목록↔PDF 불일치 22건에서
// 높은 쪽을 믿으면 정격 미달 부품을 고르게 된다.
//
// ⚠️ 이 판정은 「후보 제시」다. 최종 적용 가부는 제조사 확인이 필요하다.
//    (당사는 대리점·서비스 위치 — 제조사 사양을 넘어선 단정을 하지 않는다)
// ─────────────────────────────────────────────────────────────

const V = (m, k) => m.effective?.[k]?.value ?? null;
const turns = m => m.spec?.tuner_turns?.value ?? null;
const near = (a, b, tol) => a != null && b != null && Math.abs(a - b) <= tol;

/**
 * 전기 판정 — 「정격」과 「용량 커버리지」를 나눈다.
 *   정격 미달(전압·전류)  = 안전 문제. 후보에서 아예 제외한다.
 *   커버리지 부족(용량)   = 운전 구간에 따라 쓸 수도 있다. C등급으로 남긴다.
 */
function electrical(src, cand, requiredCap) {
  const rating = [], coverage = [];
  const need = [
    ['v_peak_test',  '내전압(Peak test)', 'kVp'],
    ['v_rf_working', 'RF 사용전압',        'kVp'],
    ['i_max',        '최대전류',           'Arms'],
  ];
  for (const [k, label, unit] of need) {
    const sv = V(src, k), cv = V(cand, k);
    if (sv == null || cv == null) { rating.push({ key: k, label, note: '값 없음', unit }); continue; }
    if (cv < sv) rating.push({ key: k, label, need: sv, has: cv, unit, deficit: +(((sv - cv) / sv) * 100).toFixed(1) });
  }

  if (src.kind === 'VVC') {
    // 덮어야 할 구간: 기본은 원본 전 범위, 지정하면 실제 운전 구간
    const sMin = requiredCap?.min ?? V(src, 'cap_min');
    const sMax = requiredCap?.max ?? V(src, 'cap_max');
    const cMin = V(cand, 'cap_min'), cMax = V(cand, 'cap_max');
    if ([sMin, sMax, cMin, cMax].some(x => x == null)) coverage.push({ key: 'cap', label: '용량 범위', note: '값 없음', unit: 'pF' });
    else {
      if (cMin > sMin) coverage.push({ key: 'cap_min', label: '용량 하한', need: sMin, has: cMin, unit: 'pF', deficit: +(((cMin - sMin) / sMin) * 100).toFixed(1) });
      if (cMax < sMax) coverage.push({ key: 'cap_max', label: '용량 상한', need: sMax, has: cMax, unit: 'pF', deficit: +(((sMax - cMax) / sMax) * 100).toFixed(1) });
    }
  } else {
    // 고정: 용량값이 다르면 애초에 다른 부품 — 후보에서 제외한다
    const sv = V(src, 'cap_min'), cv = V(cand, 'cap_min');
    if (sv == null || cv == null) rating.push({ key: 'cap', label: '용량', note: '값 없음', unit: 'pF' });
    else if (Math.abs(cv - sv) / sv > 0.02) rating.push({ key: 'cap', label: '용량', need: sv, has: cv, unit: 'pF', mismatch: true });
  }
  return { rating, coverage };
}

/** 기계·제어·냉각 차이 */
function physical(src, cand) {
  const diffs = [];
  const sD = V(src, 'diameter'), cD = V(cand, 'diameter');
  if (!near(sD, cD, 0.5)) diffs.push({ key: 'diameter', label: '외경', from: sD, to: cD, unit: 'mm' });

  const sM = V(src, 'mounting_length'), cM = V(cand, 'mounting_length');
  if (sM != null && cM != null && !near(sM, cM, 0.5)) diffs.push({ key: 'mounting', label: '장착길이', from: sM, to: cM, unit: 'mm' });

  if (src.kind === 'VVC') {
    const sT = turns(src), cT = turns(cand);
    if (sT != null && cT != null && !near(sT, cT, 0.05)) {
      diffs.push({ key: 'turns', label: '튜너 회전수', from: sT, to: cT, unit: 'Turns', critical: true,
                   note: '매처 포지션↔용량 대응이 바뀜 → 재캘리브레이션 필요' });
    }
  }
  if (src.cooling !== cand.cooling) {
    diffs.push({ key: 'cooling', label: '냉각 방식', from: src.cooling, to: cand.cooling, critical: true,
                 note: '수랭↔공랭은 냉각 배관이 달라 그대로 교체 불가' });
  }
  return diffs;
}

/**
 * @param {object} src   원본 모델
 * @param {object[]} all 전체 모델
 * @returns {{A:[],B:[],C:[]}} 등급별 후보
 */
export function findSubstitutes(src, all, { limitB = 30, limitC = 15, requiredCap = null } = {}) {
  const A = [], B = [], C = [];
  let excludedByRating = 0;

  for (const cand of all) {
    if (cand.id === src.id) continue;
    if (cand.kind !== src.kind) continue;          // 가변↔고정 교차 금지
    if (!cand.effective) continue;

    const { rating, coverage } = electrical(src, cand, requiredCap);

    // 【안전선】 정격 미달은 대체품으로 제시하지 않는다. 목록에 띄우지도 않는다.
    if (rating.length > 0) { excludedByRating++; continue; }

    const diffs = physical(src, cand);
    const row = {
      id: cand.id, type: cand.type, series: cand.series, kind: cand.kind,
      cooling: cand.cooling,
      spec: {
        cap_min: V(cand, 'cap_min'), cap_max: V(cand, 'cap_max'),
        v_rf_working: V(cand, 'v_rf_working'), v_peak_test: V(cand, 'v_peak_test'),
        i_max: V(cand, 'i_max'), diameter: V(cand, 'diameter'),
        mounting_length: V(cand, 'mounting_length'), turns: turns(cand),
      },
      shortfalls: coverage, differences: diffs,
      has_disagreement: (cand.effective.disagree ?? []).length > 0,
      doc_no: cand.doc_no ?? null,
      pdf: cand.pdf?.file ?? null,
    };
    // 여유도 = 얼마나 넉넉히 넘는가 (작을수록 원본에 가까움 → 우선)
    row.margin = ['v_peak_test', 'i_max'].reduce((s2, k) => {
      const a = V(src, k), b = V(cand, k);
      return s2 + (a && b ? (b - a) / a : 0);
    }, 0);

    if (coverage.length > 0) {
      row.worst_deficit = Math.max(...coverage.map(x => x.deficit ?? 999));
      C.push(row);
    } else if (diffs.length === 0) A.push(row);
    else B.push(row);
  }

  A.sort((a, b) => a.margin - b.margin);
  B.sort((a, b) => (a.differences.some(d => d.critical) ? 1 : 0) - (b.differences.some(d => d.critical) ? 1 : 0)
                || a.differences.length - b.differences.length || a.margin - b.margin);
  C.sort((a, b) => a.worst_deficit - b.worst_deficit);

  return {
    A, B: B.slice(0, limitB), C: C.slice(0, limitC),
    truncated: { B: Math.max(0, B.length - limitB), C: Math.max(0, C.length - limitC) },
    excluded_by_rating: excludedByRating,   // 정격 미달로 제외한 수 (숨기지 않고 알린다)
    required_cap: requiredCap,
  };
}
