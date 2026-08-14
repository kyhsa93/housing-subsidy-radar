// 임시 탐색 스크립트. 주거 지원금을 어떻게 추려낼지 정하려고 만든 것이고,
// 수집 스크립트를 쓰고 나면 지운다.
//
// 신청기한은 이미 확인했다: 100건 중 날짜형이 5건뿐이라 마감 카운트다운은
// 불가능하고, supportConditions의 자격 조건 코드로 거르는 쪽이 맞다.
//
// 이번에 확인할 것:
//   1. perPage 상한 (10,965건을 몇 번에 나눠 받아야 하는지)
//   2. "서비스분야" 값 목록 - 주거 관련을 무엇으로 거를지
//   3. supportConditions를 서비스ID 없이 통째로 받을 수 있는지
//      (건별로 부르면 1만 번이라 하루 한도를 넘긴다)

const KEY = process.env.SUBSIDY_API_KEY;
const BASE = process.env.SUBSIDY_API_ENDPOINT;
const SERVICE = "gov24/v3";

async function get(path, params = {}) {
  const query = new URLSearchParams({ page: "1", perPage: "10", ...params });
  const url = `${BASE.trim().replace(/\/+$/, "")}/${SERVICE}/${path}?serviceKey=${KEY}&${query}`;
  const res = await fetch(url, { headers: { "User-Agent": "housing-subsidy-radar/0.1" } });
  const text = await res.text();
  try {
    return { status: res.status, json: JSON.parse(text) };
  } catch {
    return { status: res.status, text: text.slice(0, 300) };
  }
}

async function main() {
  if (!KEY || !BASE) return console.log("[explore] 환경변수 없음");

  console.log("=== perPage 상한 ===");
  for (const perPage of ["1000", "5000", "10000"]) {
    const r = await get("serviceList", { perPage });
    const n = r.json?.data?.length;
    console.log(`  perPage=${perPage} → http ${r.status}, 받은 건수 ${n ?? "-"} ${r.json?.msg ?? ""}`);
    if (!n) break;
  }

  console.log("\n=== supportConditions 통째 조회 ===");
  const cond = await get("supportConditions", { perPage: "1000" });
  console.log(`  http ${cond.status} totalCount=${cond.json?.totalCount} 받은 건수=${cond.json?.data?.length ?? "-"}`);

  console.log("\n=== 서비스분야 분포 (1000건) ===");
  const list = await get("serviceList", { perPage: "1000" });
  const rows = list.json?.data ?? [];
  const fields = {};
  for (const row of rows) {
    const key = String(row["서비스분야"] ?? "(없음)");
    fields[key] = (fields[key] ?? 0) + 1;
  }
  for (const [k, v] of Object.entries(fields).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(v).padStart(4)}  ${k}`);
  }

  // 주거 관련을 이름으로 거르면 몇 건이나 되는지도 같이 본다.
  const housingWords = /주택|주거|전세|월세|임대|보금자리|이사|정착|집수리|매입|기숙사/;
  const byName = rows.filter((r) => housingWords.test(`${r["서비스명"]} ${r["서비스목적요약"] ?? ""}`));
  console.log(`\n=== 이름·요약에 주거 낱말이 있는 건수: ${byName.length} / ${rows.length} ===`);
  for (const r of byName.slice(0, 15)) {
    console.log(`  [${r["서비스분야"]}] ${r["서비스명"]} (${r["소관기관명"]})`);
  }

  // 무주택 조건(JA0412)이 붙은 서비스가 몇이나 되는지도 확인한다.
  const conds = cond.json?.data ?? [];
  const noHome = conds.filter((c) => c.JA0412 === "Y");
  console.log(`\n=== supportConditions 표본 ${conds.length}건 중 무주택세대(JA0412) 조건: ${noHome.length}건 ===`);
  for (const c of noHome.slice(0, 10)) console.log(`  ${c["서비스명"] ?? c["서비스ID"]}`);
}

await main();
