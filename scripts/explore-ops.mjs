// 임시 탐색용. 오퍼레이션별로 접수 마감일 분포를 보고 실제로 접수 중인 공고가
// 잡히는 종류인지 확인한 뒤 지운다.
const API_KEY = process.env.CHEONGYAK_API_KEY;
const API_BASE = process.env.CHEONGYAK_API_ENDPOINT;
const SERVICE = "ApplyhomeInfoDetailSvc/v1";

const OPS = {
  getUrbtyOfctlLttotPblancDetail: ["SUBSCRPT_RCEPT_ENDDE", "CNTRCT_CNCLS_ENDDE", "RCRIT_PBLANC_DE", "MVN_PREARNGE_YM"],
  getRemndrLttotPblancDetail: ["SUBSCRPT_RCEPT_ENDDE", "GNRL_RCEPT_ENDDE", "SPSPLY_RCEPT_ENDDE", "RCRIT_PBLANC_DE"],
};

const iso = (v) => {
  if (typeof v !== "string") return null;
  const d = v.replace(/\D/g, "");
  return d.length === 8 ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}` : null;
};

for (const [operation, fields] of Object.entries(OPS)) {
  const rows = [];
  for (let page = 1; page <= 10; page += 1) {
    const url = `${API_BASE}/${SERVICE}/${operation}?serviceKey=${API_KEY}&page=${page}&perPage=500`;
    const res = await fetch(url, { headers: { "User-Agent": "housing-subsidy-radar/explore" } });
    const json = await res.json();
    if (!Array.isArray(json.data) || json.data.length === 0) break;
    rows.push(...json.data);
    if (rows.length >= json.totalCount) break;
  }
  console.log(`\n### ${operation}: ${rows.length}건`);
  for (const field of fields) {
    const values = rows.map((r) => iso(r[field])).filter(Boolean).sort();
    const filled = values.length;
    console.log(
      `  ${field}: 채워짐 ${filled}/${rows.length}` +
        (filled ? ` 최신 ${values.slice(-3).join(", ")}` : "")
    );
  }
  // 최신 공고 몇 건이 실제로 어떤 모습인지.
  const latest = [...rows]
    .filter((r) => iso(r.RCRIT_PBLANC_DE))
    .sort((a, b) => iso(b.RCRIT_PBLANC_DE).localeCompare(iso(a.RCRIT_PBLANC_DE)))
    .slice(0, 3);
  for (const r of latest) {
    console.log(
      `  최근공고: ${r.HOUSE_NM} | 공고일 ${r.RCRIT_PBLANC_DE} | ` +
        fields.map((f) => `${f}=${r[f] ?? "null"}`).join(" ")
    );
  }
}
