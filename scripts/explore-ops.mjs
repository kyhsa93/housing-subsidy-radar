// 임시 탐색용. 청약홈 분양정보 서비스에 어떤 오퍼레이션이 살아 있고 각각 어떤
// 접수일 필드를 주는지 확인한 뒤 지운다.
const API_KEY = process.env.CHEONGYAK_API_KEY;
const API_BASE = process.env.CHEONGYAK_API_ENDPOINT;
const SERVICE = "ApplyhomeInfoDetailSvc/v1";

const CANDIDATES = [
  "getAPTLttotPblancDetail",
  "getOptLttotPblancDetail",
  "getUrbtyOfctlLttotPblancDetail",
  "getRemndrLttotPblancDetail",
  "getPblPrvtRentLttotPblancDetail",
  "getPblprvtRentLttotPblancDetail",
  "getAPTLttotPblancMdl",
  "getUrbtyOfctlLttotPblancMdl",
];

const DATE_HINT = /(BGNDE|ENDDE|_DE$|_YM$)/;

for (const operation of CANDIDATES) {
  const url = `${API_BASE}/${SERVICE}/${operation}?serviceKey=${API_KEY}&page=1&perPage=3`;
  try {
    const res = await fetch(url, { headers: { "User-Agent": "housing-subsidy-radar/explore" } });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      console.log(`\n### ${operation}: JSON 아님 (http ${res.status}) ${text.slice(0, 120)}`);
      continue;
    }
    if (typeof json.code === "number" && json.code < 0) {
      console.log(`\n### ${operation}: 오류 ${json.code} ${json.msg ?? ""}`);
      continue;
    }
    const row = Array.isArray(json.data) ? json.data[0] : null;
    console.log(`\n### ${operation}: totalCount=${json.totalCount} sample=${row ? "있음" : "없음"}`);
    if (!row) continue;
    console.log(`  날짜필드: ${Object.keys(row).filter((k) => DATE_HINT.test(k)).join(", ")}`);
    console.log(`  전체필드: ${Object.keys(row).join(", ")}`);
    console.log(`  샘플: ${JSON.stringify(row).slice(0, 700)}`);
  } catch (err) {
    console.log(`\n### ${operation}: 요청 실패 ${err.message} (${err.cause?.message ?? "?"})`);
  }
}
