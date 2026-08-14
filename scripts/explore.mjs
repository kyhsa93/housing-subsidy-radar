// 임시 탐색 스크립트. 보조금24(정부24 공공서비스) 응답이 어떻게 생겼는지
// 확인하려고 만든 것이고, 수집 스크립트를 쓰고 나면 지운다.
//
// 확인하려는 것은 하나다: `신청기한`이 날짜인가, 자유 텍스트인가.
//   날짜면      → 청약과 같은 마감 D-day 목록에 합칠 수 있다
//   자유 텍스트면 → 카운트다운이 불가능하니 조건 검색 쪽으로 가야 한다
// 겸사겸사 supportConditions(자격 조건 코드)도 한 건 찍어본다.

const KEY = process.env.SUBSIDY_API_KEY;
const BASE = process.env.SUBSIDY_API_ENDPOINT;

// api-docs 기준 basePath는 /api, 경로는 /gov24/v3/... 이다.
// 시크릿에는 https://api.odcloud.kr/api 까지만 들어 있다.
const SERVICE = "gov24/v3";

async function get(path, params = {}) {
  const query = new URLSearchParams({ page: "1", perPage: "5", ...params });
  const url = `${BASE.trim().replace(/\/+$/, "")}/${SERVICE}/${path}?serviceKey=${KEY}&${query}`;
  const res = await fetch(url, { headers: { "User-Agent": "housing-subsidy-radar/0.1" } });
  const text = await res.text();
  try {
    return { status: res.status, json: JSON.parse(text) };
  } catch {
    return { status: res.status, text: text.slice(0, 400) };
  }
}

async function main() {
  if (!KEY || !BASE) {
    console.log("[explore] 보조금24 환경변수 없음");
    return;
  }

  const list = await get("serviceList", { perPage: "100" });
  if (!list.json?.data) {
    console.log("serviceList 실패:", list.status, JSON.stringify(list.json ?? list.text).slice(0, 300));
    return;
  }
  console.log(`serviceList http ${list.status} / totalCount=${list.json.totalCount}`);

  const first = list.json.data[0];
  console.log("\n=== 첫 건의 필드 ===");
  for (const [k, v] of Object.entries(first)) {
    console.log(`  ${k} = ${String(v).slice(0, 80)}`);
  }

  // 신청기한 값이 어떤 꼴인지가 기획을 가른다. 100건을 훑어서 분류해 본다.
  console.log("\n=== 신청기한 값 분포 (100건) ===");
  const buckets = { 날짜형: [], 상시형: [], 기타: [] };
  for (const row of list.json.data) {
    const raw = String(row["신청기한"] ?? "").trim();
    if (/\d{4}[-.년]\s?\d{1,2}[-.월]\s?\d{1,2}/.test(raw)) buckets.날짜형.push(raw);
    else if (/상시|연중|수시|예산|소진|기간\s?내|접수시|별도/.test(raw)) buckets.상시형.push(raw);
    else buckets.기타.push(raw);
  }
  for (const [name, values] of Object.entries(buckets)) {
    console.log(`  ${name}: ${values.length}건`);
    for (const v of [...new Set(values)].slice(0, 6)) console.log(`     "${v.slice(0, 90)}"`);
  }

  // 자격 조건 코드도 한 건 확인한다(무주택·다자녀·소득 구간 등).
  const serviceId = first["서비스ID"];
  const cond = await get("supportConditions", { "cond[서비스ID::EQ]": serviceId });
  console.log(`\n=== supportConditions (서비스ID=${serviceId}) ===`);
  const row = cond.json?.data?.[0];
  if (!row) {
    console.log("  없음:", JSON.stringify(cond.json ?? cond.text).slice(0, 200));
  } else {
    const set = Object.entries(row).filter(([k, v]) => k.startsWith("JA") && v && v !== "N");
    console.log(`  전체 ${Object.keys(row).length}필드 중 값이 있는 조건 ${set.length}개`);
    for (const [k, v] of set.slice(0, 20)) console.log(`    ${k} = ${v}`);
  }
}

await main();
