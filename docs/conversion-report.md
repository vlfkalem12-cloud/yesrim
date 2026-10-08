# Conversion Report / Warning

이번 변경은 기존 변환 결과를 설명하는 보고서와 경고 수집 연결만 개선한다. Layout / Sizing / Rich Text / SVG / Gradient / Naming / Form / Wrapper / Fixed 정책은 바꾸지 않는다.

## 기존 구조와 재사용

- `src/ui.ts`: idle / converting / success / error, 파일·Drop·재시도, Request ID를 검사하는 수신부가 이미 있다.
- `src/code.ts`: CREATE_FIGMA → PROGRESS → CONVERSION_COMPLETE / CONVERSION_ERROR, busy를 해제하는 finally가 있다.
- `src/parser.ts`: 상대 CSS, 외부 CSS 로딩, 웹 폰트 timeout, 미지원 CSS, 이미지 소스, SVG 직렬화와 Layout fallback 경고가 있다.
- `src/assets.ts`: decode / CORS canvas / PNG 변환 / 용량 제한 실패를 IMAGE_LOAD로 수집한다.
- `src/converter.ts`: 폰트 대체·로드 실패, SVG import, 이미지 Paint, Sizing API와 순환, 노드 생략을 수집한다.
- `src/report.ts`: 기존 raw code → category 분류와 selector 보충을 재사용한다. raw Warning과 Debug 기록을 삭제하지 않는다.
- Converter는 일부 자식 실패 시 실패한 subtree만 제거하고 NODE_FAILED를 남긴다. 루트 변환 실패는 전체 생성 루트를 제거하고 throw한다. 이 정책은 유지한다.

## 파일과 함수

| 파일 | 변경 |
| --- | --- |
| types.ts | 기존 ConversionWarning에 선택적 detail / occurrences / locations, 새 ConversionOutcome / ReportWarning 타입 |
| report.ts | warningCollector, groupReportWarnings, reportCode, conversionOutcome, failedOutcome, 안전한 표시 문자열, 요소 식별 |
| parser.ts | 기존 경고에 CSS/리소스/요소 정보 연결, 실제 stylesheet error 이벤트와 관측 가능한 HTTP 실패 확인, 사용된 웹 폰트 error 상태 확인 |
| assets.ts | 기존 IMAGE_LOAD에 source / stage / reason / selector 연결 |
| converter.ts | 기존 경고 수집을 반복 횟수 보존 collector로 연결, Font/SVG/자식 실패에 확인된 원인 정보 연결. 생성·폰트 선택 알고리즘 유지 |
| code.ts | 생성 완료 후 outcome 확정, 파일명과 Request ID 전달, 실패 outcome과 개발자 로그 |
| ui.ts / ui.html | 기존 결과 영역의 요약·그룹·접힌 상세·별도 Debug, 파일/변환 시작 시 이전 결과 숨김 |

## 결과와 메시지

UI는 파일명과 Request ID를 CREATE_FIGMA 메시지에 함께 보낸다. 변환 JSON 형식(version:1)은 유지한다. Main은 Converter가 반환한 살아 있는 결과 Frame을 확인한 뒤 기존 report와 새 payload.outcome을 완료 메시지에 넣는다.

```ts
{
  type: 'CONVERSION_COMPLETE', requestId,
  payload: {
    success: true, report, // 기존 통계, raw Warning, Debug
    outcome: {
      status: 'SUCCESS' | 'SUCCESS_WITH_WARNINGS', fileName,
      result: { frameCreated: true, frameCount: 1 },
      warningCount, warningTypes, warnings
    }
  }
}
```

`frameCount`는 생성된 최상위 결과 Frame의 수다. 내부 Frame 수는 기존 report.frames에 보관한다. Warning이 있어도 결과 Frame이 남아 있으면 SUCCESS_WITH_WARNINGS다. 자식 생략도 결과 Frame이 유지되는 경우 성공과 경고로 표시한다. 루트 실패는 기존 정리 후 ERROR / frameCreated:false / frameCount:0으로 전달한다. UI 자체 분석 실패도 같은 실패 보고서를 표시한다.

UI lifecycle의 success는 완료 결과 두 가지를 모두 포함하며 기존 상태 타입을 중복 구현하지 않는다. 상태 문구는 각각 “변환이 완료되었습니다.”, “변환이 완료되었습니다. 일부 항목을 확인해 주세요.”, “HTML을 변환하지 못했습니다.”다. 활성 Request ID와 converting 상태가 모두 맞는 메시지만 수신한다. 이전 요청의 늦은 완료·실패는 무시한다. 파일 input 초기화, 같은 파일 재선택, Drop과 Convert 재시도는 유지한다. 잘못된 새 파일을 선택한 경우에도 이전 HTML과 보고서를 재사용하지 않는다.

## 경고와 실제 감지 범위

| 보고서 Code | 실제 수집 경로 |
| --- | --- |
| EXTERNAL_RESOURCE | 처리 불가인 상대 stylesheet, sheet 미생성/실제 error 이벤트/관측 가능한 HTTP 오류, 리소스·웹 폰트 timeout, FontFace.status:error |
| UNSUPPORTED_STYLE | 기존에 무시·단순화한 backdrop-filter, transform, float, 다중 shadow, gradient fallback, 배경 repeat/position 등 기존 경고 |
| FONT_FALLBACK | 기존 FONT_REPLACED / FONT_STYLE_REPLACED / FONT_LOAD_FAILED / 폰트 목록·미사용 가능 진단. 원본/대체 family, weight/style은 실제 값이 있을 때 제공 |
| IMAGE_ERROR | 기존 IMAGE_SOURCE / IMAGE_LOAD / IMAGE_PLACEHOLDER: 처리 불가 소스, decode/CORS/변환/제한 실패, Figma createImage 실패 |
| SVG_ERROR | 기존 SVG_SERIALIZE / SVG_IMPORT / SVG_DASH의 실제 실패. 정상 SVG에 추가 경고 없음 |
| SIZING_FALLBACK | 기존 SIZING_API / SIZING_CYCLE / SIZE_CONSTRAINT / HEIGHT_LAYOUT / FLEX_WRAP / GRID_FALLBACK 등 실제 intent 제한·대체 |
| CONVERSION_WARNING | NODE_FAILED / TREE_LIMIT / UNSUPPORTED_ELEMENT 등 다른 실제 생략·제한 |

새 raw 진단 Code는 `WEB_FONT_LOAD`다. 위 보고서 Code는 기존 raw Code의 사용자용 분류이며 raw Code를 덮어쓰지 않는다. CSS 속성을 전수 검사하는 새 분석기는 추가하지 않았다.

정상 Fixed 선택, Absolute/Fixed 위치 적용, DISPLAY_CONTENTS 매핑, 접근성 hidden 제외, BACKGROUND_DEBUG / HEIGHT_SIZING / HEIGHT_HIERARCHY 등 정보는 warningCount에서 제외한다. styles/images 옵션으로 의도적으로 끈 항목도 해당 미지원 스타일/이미지 오류로 보고하지 않는다. URL/link 존재, 접근 불가 cssRules, 비어 있는 CSS 자체를 실패로 추정하지 않는다.

## 그룹화와 UI

- 같은 보고서 Code, raw Code, 구조화된 원인 값이 같은 경고를 묶는다. metadata가 없는 경우 기존 메시지 전체가 원인 key다. 원인이 다른 글꼴·리소스·에러는 분리한다.
- 경고 N건은 묶인 원인 수다. 각 항목에는 발생 N회를 별도로 표시한다. Rich Text range에서도 진단이 발생할 수 있으므로 이를 임의로 “N개 DOM 요소”라고 단정하지 않는다.
- 위치는 ID → 직접 관측한 aria-label → class/tag 또는 기존 selector를 사용한다. 대표 위치 최대 5개, 상세 목록은 처음 30개이며 더 보기로 이어서 확인한다. 동일 이름에 서로 다른 source가 있으면 임의의 첫 요소를 위치로 지정하지 않는다.
- raw 기록의 기존 한도(Parser 약 500 / Converter 1000)는 유지한다. 동일 raw 진단 반복은 목록을 늘리지 않고 횟수를 보존한다. 상이한 경고가 이 한도를 초과하는 문서에서는 모든 원인을 보관한다고 보장하지 않는다.
- 결과 영역은 성공 여부 → 파일명/결과 → 원인별 경고 수 → 기본적으로 접힌 상세 순서다. 기존 레이어 통계도 접힌 영역에 유지한다. 정상 요소 목록을 만들지 않는다.
- 일반 UI의 메시지·원인은 한 줄의 제한된 길이로 표시하고 stack trace를 노출하지 않는다. 모든 문자열은 textContent로 렌더링한다. raw 진단은 Debug Mode의 별도 접힌 영역과 개발자 콘솔에 남긴다.
- 보고서 표시 오류가 있어도 Canvas 성공 상태와 다음 변환을 유지한다. 보고서 복사 기능은 이번 범위에 포함하지 않았다.

## 감지하지 못하는 항목과 수동 확인

- 임의의 모든 CSS 지원 여부, 브라우저가 이미 무시한 문법, Figma와 브라우저의 모든 시각적 차이는 탐지하지 않는다.
- iframe navigation 중 아주 빠르게 끝난 cross-origin stylesheet 실패는 error 이벤트를 관측하기 전에 완료될 수 있다. opaque sheet가 존재하고 HTTP 상태도 공개되지 않으면 실패라고 추정하지 않는다. nested @import의 개별 실패도 완전하게 탐지하지 않는다.
- 아직 로딩을 시도하지 않은 웹 폰트, 글리프 수준의 누락, 비동기 CSS/사용자 script 실행으로 생성될 콘텐츠의 완전한 여부는 확인하지 않는다.
- 실제 Figma runtime/editor는 이 환경에서 실행하지 않았다. 새 빌드를 Reload한 후 정상/경고/실패 문구, 접힌 상세, Debug 분리, 파일 A→B→같은 B 및 실패 후 재시도를 수동 확인해야 한다.
- mock의 이미지·폰트·SVG·Sizing API 오류는 실제 Figma 자체 오류 재현과 구분한다.

## 자동 검증

`tests/lifecycle.test.mjs`: 실제 Chromium iframe UI ↔ Main bundle ↔ Figma API mock으로 상태, 파일명, 성공/경고/실패, 외부 CSS 성공 및 404, 폰트 100회 그룹화, 이미지 decode와 API 실패, 미지원 스타일/hidden/옵션 제외, SVG·자식 생략, Sizing fallback, 웹 폰트 실패, 반복 파일 선택, Drop, 오래된 완료/실패 무시, 보고서 오류 복구를 검증한다.

`tests/report.test.mjs`: raw 보존, Debug·정상 매핑 제외, 그룹 원인 분리, 발생 수/대표 위치, stack 표시 제한, 중복 이름의 위치 오지정 방지를 검증한다. 직전 be2d331 source와 실제 원본을 포함한 12개 HTML의 전체 IR(경고 제외), 최종 Figma tree의 layout/sizing/위치/폭·높이/스타일/텍스트/range/name/wrapper, SVG bytes, 이미지 bytes, 생성 통계를 비교한다. 보호 모듈 11개의 소스도 동일하다.

TypeScript 검사·빌드 통과. 전체 회귀 141개 중 140개 통과, 실패 0개, 이전 Rich Text 엔진 비교 1개 조건부 skip. Report/lifecycle 24개와 12개 HTML의 be2d331 비교는 모두 실행했다. Height/Nested/Actual/Gutter의 이전 baseline 비교도 실행했다. 이 수치는 Chromium + Figma API mock 검증이며 실제 Figma 실행 결과가 아니다.
