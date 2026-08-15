// 크롤러가 받는 HTML에 오늘 공고를 심는다.
//
// 이 페이지는 data/*.json을 클라이언트에서 받아 그리기 때문에, 손대지 않으면 초기
// HTML에는 "불러오는 중..."밖에 없다. 구글은 JS를 렌더링하지만 렌더 큐가 밀려서
// 매일 바뀌는 내용과 궁합이 나쁘고, 네이버 Yeti와 Bing은 JS 렌더링이 약하다.
//
// 심은 내용은 화면 동작에 영향을 주지 않는다 - 클라이언트가 같은 컨테이너를
// innerHTML로 갈아끼우기 때문에 데이터를 받은 뒤엔 전부 다시 그려진다.
//
// 두 가지를 일부러 하지 않는다.
// - 지원금 목록: 그 패널은 처음에 hidden이라 심으면 화면에 없는 걸 크롤러에만
//   보여주는 꼴이 된다. 검색에 태우고 싶으면 별도 URL로 빼는 게 맞다.
// - D-day: 만든 시점의 "오늘"에 따라 값이 달라져서, 데이터가 그대로여도 하루 뒤엔
//   결과가 달라진다. 그러면 "커밋된 HTML이 데이터와 맞는가"를 검사할 수 없다.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const INDEX_PATH = path.join(root, "docs/index.html");
const DATA_PATH = path.join(root, "docs/data/cheongyak.json");

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

const fmtDate = (value) => (value ? String(value).replaceAll("-", ".") : null);

const fmtRange = (start, end) => {
  const from = fmtDate(start);
  const to = fmtDate(end);
  if (from && to) return `${from} ~ ${to}`;
  return from ?? to ?? null;
};

export function noticesHtml(payload) {
  const notices = payload?.notices ?? [];
  if (!notices.length) return null;

  return notices
    .map((notice) => {
      const meta = [
        notice.area,
        notice.units ? `${Number(notice.units).toLocaleString("ko-KR")}세대` : null,
        notice.builder,
      ]
        .filter(Boolean)
        .join(" · ");

      const receipt = fmtRange(notice.receiptStart, notice.receiptEnd);

      return (
        `<article class="notice">` +
        `<div class="notice-name">${escapeHtml(notice.name)}</div>` +
        (notice.kind ? `<div class="notice-meta"><span class="tag">${escapeHtml(notice.kind)}</span></div>` : "") +
        (notice.address ? `<div class="notice-meta">${escapeHtml(notice.address)}</div>` : "") +
        (meta ? `<div class="notice-meta">${escapeHtml(meta)}</div>` : "") +
        (receipt ? `<div class="notice-meta">접수 ${escapeHtml(receipt)}</div>` : "") +
        `</article>`
      );
    })
    .join("");
}

// 마커가 없으면 조용히 지나가지 않는다. 심었다고 생각하는데 실제로는 아무것도
// 안 들어간 상태가 제일 나쁘다.
export function applyPrerender(html, blocks) {
  let out = html;
  for (const [name, content] of Object.entries(blocks)) {
    const open = `<!--prerender:${name}-->`;
    const close = `<!--/prerender:${name}-->`;
    const start = out.indexOf(open);
    const end = out.indexOf(close);
    if (start === -1 || end === -1 || end < start) {
      throw new Error(`${name} 자리표시 주석을 찾지 못했습니다. index.html에서 마커가 지워졌는지 확인해주세요.`);
    }
    if (content == null) continue; // 데이터가 없으면 기존 안내 문구를 그대로 둔다
    out = `${out.slice(0, start + open.length)}${content}${out.slice(end)}`;
  }
  return out;
}

async function main() {
  const payload = await readFile(DATA_PATH, "utf8")
    .then(JSON.parse)
    .catch(() => null);

  const html = await readFile(INDEX_PATH, "utf8");
  const blocks = { notices: noticesHtml(payload) };
  const next = applyPrerender(html, blocks);

  console.log(`  공고 ${blocks.notices ? `${blocks.notices.length}자` : "데이터 없음 - 건너뜀"}`);

  if (next === html) {
    console.log("  변경 없음");
    return;
  }
  await writeFile(INDEX_PATH, next);
  console.log("  docs/index.html 갱신");
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  main().catch((err) => {
    console.error(`프리렌더 실패: ${err.message}`);
    process.exit(1);
  });
}
