# housing-subsidy-radar

전국 청약 공고(APT·임의공급)와 정부 지원금을 매일 모아 마감일 기준으로 보여주는
GitHub Pages 정적 사이트.

작업 중입니다. 현재는 API 응답 구조를 확인하는 단계입니다.

## 데이터 출처

- 한국부동산원 청약홈 분양정보 조회 서비스 (공공데이터포털, `api.odcloud.kr`)
- 행정안전부 대한민국 공공서비스(혜택) 정보 — 보조금24

## 시크릿

| 이름 | 값 |
| --- | --- |
| `CHEONGYAK_API_KEY` | 공공데이터포털 서비스키(Decoding) |
| `CHEONGYAK_API_ENDPOINT` | `https://api.odcloud.kr/api` |
| `SUBSIDY_API_KEY` | 공공데이터포털 서비스키(Decoding) |
| `SUBSIDY_API_ENDPOINT` | 보조금24 서비스 URL |

엔드포인트는 서비스 경로와 오퍼레이션을 뺀 상태로 둔다. 같은 시크릿으로 같은
제공처의 다른 API도 쓸 수 있고, 오퍼레이션을 바꿀 때 시크릿을 건드리지 않아도 된다.
