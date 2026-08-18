// ─────────────────────────────────────────────────────────────
// 「유효값(effective)」 산정 — 두 출처가 다를 때 무엇을 믿을 것인가
//
// 목록 JSON과 데이터시트 PDF가 22건 실제로 어긋난다(2026-08-18 전수 대조).
// 예) SCV-55D55W  전류: 목록 40 A vs PDF 80 A
//     SCV-155P70W 용량: 목록 최대 1500 pF vs PDF 500 pF
//
// 【판단 원칙 — 보수적 채택】
//   · 정격(전압·전류)  → 둘 중 **낮은 값**을 쓴다.  과대평가 금지.
//   · 용량 범위        → 둘 중 **좁은 범위**를 쓴다. 커버리지 과대평가 금지.
//   왜: 이 값으로 대체품을 고른다. 높게 잡으면 정격 미달 부품이 들어가
//       아크·소손으로 이어진다. 낮게 잡으면 후보가 줄 뿐, 사고는 안 난다.
//   불일치 모델은 화면에 ⚠️로 띄우고 "제조사 확인 필요"를 함께 표시한다.
// ─────────────────────────────────────────────────────────────

const pick = (a, b, how) => {
  if (a == null && b == null) return { value: null, basis: 'none' };
  if (a == null) return { value: b, basis: 'pdf' };
  if (b == null) return { value: a, basis: 'list' };
  if (a === b) return { value: a, basis: 'agree' };
  const v = how === 'min' ? Math.min(a, b) : Math.max(a, b);
  return { value: v, basis: 'conservative', list: a, pdf: b, disagree: true };
};

/** 모델 1건의 유효값 산정 */
export function computeEffective(m) {
  const f = m.spec ?? {};
  const c = f.capacitance_pf ?? null;

  const pdfCapMin = c ? (c.kind === 'range' ? c.min : c.nominal) : null;
  const pdfCapMax = c ? (c.kind === 'range' ? c.max : c.nominal) : null;

  const eff = {
    // 정격 → 낮은 쪽
    v_peak_test:  pick(m.list.v_peak_test,  f.peak_test_voltage_kvp?.value  ?? null, 'min'),
    v_rf_working: pick(m.list.v_rf_working, f.rf_working_voltage_kvp?.value ?? null, 'min'),
    i_max:        pick(m.list.i_max,        f.max_current_arms?.value       ?? null, 'min'),
    // 용량 → 좁은 쪽 (하한은 큰 값, 상한은 작은 값)
    cap_min:      pick(m.list.cap_min, pdfCapMin, 'max'),
    cap_max:      pick(m.list.cap_max, pdfCapMax, 'min'),
    // 치수는 PDF가 정밀(예: 44.7 vs 45) → PDF 우선, 없으면 목록
    diameter:     f.outer_diameter_mm?.value  != null
                    ? { value: f.outer_diameter_mm.value, basis: 'pdf' }
                    : { value: m.list.diameter, basis: 'list' },
    mounting_length: f.mounting_length_mm?.value != null
                    ? { value: f.mounting_length_mm.value, basis: 'pdf' }
                    : { value: null, basis: 'none' },
    total_length: f.total_length_mm?.value != null
                    ? { value: f.total_length_mm.value, basis: 'pdf' }
                    : { value: null, basis: 'none' },
  };
  eff.disagree = Object.entries(eff)
    .filter(([, v]) => v && v.disagree)
    .map(([k]) => k);
  return eff;
}
