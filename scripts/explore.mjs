// 임시 탐색 스크립트. 실제 응답이 어떻게 생겼는지 확인하려고 만든 것이고,
// 수집 스크립트를 쓰고 나면 지운다.
//
// 확인하려는 것:
//   1. 청약홈 APT/임의공급 응답의 필드 이름 (특히 접수 시작·마감일이 어느 필드인지)
//   2. 보조금24 응답에 신청기한 필드가 있는지 - 이 답에 따라 기획이 갈린다
//      (있으면 "마감 D-day 레이더", 없으면 "지원금 검색")

const CHEONGYAK_KEY = process.env.CHEONGYAK_API_KEY;
const CHEONGYAK_BASE = process.env.CHEONGYAK_API_ENDPOINT;
const SUBSIDY_KEY = process.env.SUBSIDY_API_KEY;
const SUBSIDY_BASE = process.env.SUBSIDY_API_ENDPOINT;

// 시크릿에는 https://api.odcloud.kr/api 까지만 들어 있다. 서비스 경로와
// 오퍼레이션은 코드가 붙인다 - 같은 시크릿으로 odcloud의 다른 API도 쓸 수 있게.
const CHEONGYAK_SERVICE = "ApplyhomeInfoDetailSvc/v1";

const OPERATIONS = [
  { key: "apt", operation: "getAPTLttotPblancDetail", label: "APT 분양정보" },
  { key: "arbitrary", operation: "getOptLttotPblancDetail", label: "임의공급(추정)" },
];

async function fetchJson(url) {
  const res = await fetch(url, { headers: { "User-Agent": "housing-subsidy-radar/0.1" } });
  const text = await res.text();
  try {
    return { status: res.status, json: JSON.parse(text) };
  } catch {
    return { status: res.status, text: text.slice(0, 600) };
  }
}

function describe(value, depth = 0) {
  if (value === null) return "null";
  if (Array.isArray(value)) return `array(${value.length})`;
  if (typeof value === "object") return "object";
  return typeof value;
}

async function exploreCheongyak() {
  if (!CHEONGYAK_KEY || !CHEONGYAK_BASE) {
    console.log("[explore] 청약홈 환경변수 없음 - 건너뜀");
    return;
  }
  const base = CHEONGYAK_BASE.trim().replace(/\/+$/, "");
  console.log(`[explore] 청약홈 base=${base}`);

  for (const { key, operation, label } of OPERATIONS) {
    const url = `${base}/${CHEONGYAK_SERVICE}/${operation}?serviceKey=${CHEONGYAK_KEY}&page=1&perPage=3`;
    console.log(`\n===== ${label} (${operation}) =====`);
    try {
      const { status, json, text } = await fetchJson(url);
      if (!json) {
        console.log(`  http ${status}, JSON 아님: ${text}`);
        continue;
      }
      console.log(`  http ${status} / 최상위 키: ${Object.keys(json).join(", ")}`);
      console.log(`  totalCount=${json.totalCount} matchCount=${json.matchCount} currentCount=${json.currentCount}`);
      const first = json.data?.[0];
      if (!first) {
        console.log("  data 비어 있음:", JSON.stringify(json).slice(0, 400));
        continue;
      }
      console.log(`  필드 ${Object.keys(first).length}개:`);
      for (const [k, v] of Object.entries(first)) {
        const preview = typeof v === "string" ? v.slice(0, 60) : JSON.stringify(v);
        console.log(`    ${k} (${describe(v)}) = ${preview}`);
      }
    } catch (err) {
      console.error(`  실패: ${err.message} (${err.cause?.message ?? err.cause?.code ?? "원인 불명"})`);
    }
  }
}

async function exploreSubsidy() {
  if (!SUBSIDY_KEY || !SUBSIDY_BASE) {
    console.log("\n[explore] 보조금24 환경변수 없음 - 건너뜀");
    return;
  }
  const base = SUBSIDY_BASE.trim().replace(/\/+$/, "");
  console.log(`\n[explore] 보조금24 base=${base}`);

  // 오퍼레이션 이름을 모르니 후보를 순서대로 두드려 본다. odcloud는 경로가
  // 없으면 code -3, 키가 문제면 -4로 구분해서 답해준다.
  const candidates = [
    "",
    "/serviceList",
    "/getServiceList",
    "/publicServiceList",
    "/serviceDetail",
  ];
  for (const path of candidates) {
    const url = `${base}${path}?serviceKey=${SUBSIDY_KEY}&page=1&perPage=3`;
    try {
      const { status, json, text } = await fetchJson(url);
      const summary = json ? JSON.stringify(json).slice(0, 300) : text;
      console.log(`  "${path || "(없음)"}" → http ${status} ${summary}`);
      if (json?.data?.[0]) {
        console.log("  필드 목록:");
        for (const [k, v] of Object.entries(json.data[0])) {
          const preview = typeof v === "string" ? v.slice(0, 60) : JSON.stringify(v);
          console.log(`    ${k} = ${preview}`);
        }
        break;
      }
    } catch (err) {
      console.error(`  "${path}" 실패: ${err.message}`);
    }
  }
}

await exploreCheongyak();
await exploreSubsidy();
