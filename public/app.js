// ═══════════════════════════════════════════════════════════════
// RF Helpdesk — 공용 스크립트
// ═══════════════════════════════════════════════════════════════

export const $  = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2).toLowerCase(), v);
    else n.setAttribute(k, v === true ? '' : String(v));
  }
  for (const k of kids.flat()) if (k != null) n.append(k.nodeType ? k : document.createTextNode(k));
  return n;
};
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** 숫자 표기 — 없는 값은 절대 0이나 추정치로 채우지 않는다 (규칙 R1) */
export const n = (v, unit = '', dash = '—') =>
  v == null || Number.isNaN(v) ? dash
  : `${Number(v).toLocaleString('ko-KR', { maximumFractionDigits: 3 })}${unit ? `<span class="u">${unit}</span>` : ''}`;

export const dateKo = iso => {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(+d) ? String(iso)
    : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// ── 토스트 ────────────────────────────────────────────────────
export function toast(msg, kind = '') {
  let box = $('#toasts');
  if (!box) { box = el('div', { id: 'toasts' }); document.body.append(box); }
  const t = el('div', { class: `toast ${kind ? `toast--${kind}` : ''}`, role: 'status' }, msg);
  box.append(t);
  setTimeout(() => t.remove(), kind === 'err' ? 6000 : 3200);
}

// ═══════════════════════════════════════════════════════════════
// 쓰기 버튼 4종 세트 — 전역 지침. 쓰기 요청 버튼은 예외 없이 이걸 쓴다.
//   ① 중복방지  누르는 즉시 잠금 + 동기 락(state 반영 전 두 번째 클릭 차단)
//   ② 로딩 피드백  버튼 글자를 "저장 중…"으로 바꾸고 흐리게
//   ③ 완료 알림
//   ④ 실패 알림 + finally 로 반드시 잠금 해제
//
// 왜 동기 락(busy 플래그)까지 두나: 서버가 멱등이 아닌 '생성'은
// 빠른 더블탭이 화면 갱신보다 빨라 두 건이 만들어진다. 사례 기록이
// 중복되면 통계가 오염되고 고객 회신 근거가 흔들린다.
// ═══════════════════════════════════════════════════════════════
export function bindWrite(btn, handler, {
  busyText = '처리 중…', okText = '완료했습니다', errText = '처리하지 못했습니다',
} = {}) {
  let busy = false;                       // ← 동기 락
  const label = btn.textContent;
  btn.addEventListener('click', async (ev) => {
    if (busy) return;                     // ① 두 번째 클릭 즉시 차단
    busy = true;
    btn.disabled = true;
    btn.setAttribute('aria-busy', 'true');
    btn.textContent = busyText;           // ②
    try {
      const r = await handler(ev);
      if (r !== false) toast(okText, 'ok');   // ③
      return r;
    } catch (e) {
      console.error(e);
      toast(`${errText} — ${e?.message ?? e}`, 'err');   // ④
    } finally {
      busy = false;
      btn.disabled = false;
      btn.removeAttribute('aria-busy');
      btn.textContent = label;
    }
  });
}

// ── API ───────────────────────────────────────────────────────
export async function api(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`${r.status} ${path}`);
  return r.json();
}

// ═══════════════════════════════════════════════════════════════
// 시그니처 — 출처 이중 표시
//   목록 JSON과 데이터시트 PDF가 어긋난 값을 계기판처럼 두 눈금으로.
//   그 사이를 빗금으로 채우고, 실제 채택한 보수적 값에 황동 마커를 세운다.
// ═══════════════════════════════════════════════════════════════
export function dualReadout(label, eff, unit) {
  if (!eff) return null;
  const wrap = el('div', { class: 'dual' });
  const has = eff.disagree === true;

  if (has) {
    const lo = Math.min(eff.list, eff.pdf), hi = Math.max(eff.list, eff.pdf);
    const pad = (hi - lo) * 0.35 || 1;
    const min = lo - pad, max = hi + pad, span = max - min;
    const pct = v => `${(((v - min) / span) * 100).toFixed(1)}%`;
    wrap.append(
      el('div', { class: 'dual__bar' },
        el('span', { class: 'dual__span', style: `left:${pct(lo)};right:${(100 - parseFloat(pct(hi))).toFixed(1)}%` }),
        el('span', { class: 'dual__pick', style: `left:${pct(eff.value)}` })),
      el('div', { class: 'dual__nums',
        html: `<span class="src">목록</span> <b>${eff.list}</b>`
            + `<span class="src">데이터시트</span> <b>${eff.pdf}</b>`
            + `<span class="adopt">▲ 채택 ${eff.value}${unit ?? ''}</span>` }));
  }
  return has ? wrap : null;
}

/** 값 하나의 출처를 한 줄로 (목록/PDF/일치/보수적채택) */
export const basisTag = b => ({
  agree: '<span class="b b--ok">두 출처 일치</span>',
  conservative: '<span class="b b--alarm">불일치 · 보수적 채택</span>',
  pdf: '<span class="b b--vvc">데이터시트</span>',
  list: '<span class="b b--vfc">목록</span>',
  none: '<span class="b b--warn">값 없음</span>',
}[b] ?? '');

// ── 상단 레일 ─────────────────────────────────────────────────
export function renderRail(current, meta) {
  const nav = [['parts.html', '부품 조회'], ['calc.html', '계산기'], ['quality.html', '데이터 품질']];
  return el('header', { class: 'rail' },
    el('div', { class: 'rail__mark', html: 'RF<b>·</b>HELPDESK' }),
    el('nav', {}, nav.map(([h, t]) =>
      el('a', { href: h, 'aria-current': h === current ? 'page' : null }, t))),
    el('div', { class: 'rail__meta', html: meta ?? '' }));
}
