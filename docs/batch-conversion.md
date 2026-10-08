# HTML 다건 업로드와 순차 변환

HTML 1~10개를 파일 선택창 또는 Drag & Drop으로 선택할 수 있다. 파일 선택창이 반환한 순서를 유지한다. `.html` / `.htm`은 대소문자를 구분하지 않는다. 한 파일의 변환 실패는 다음 파일의 처리를 중단하지 않는다.

수정 전 작업 폴더는 깨끗했고, 안정화 소스·빌드가 `6b49a83`에 이미 커밋되어 있었다. 해당 커밋을 비교 기준으로 보존했다. 이번 변경은 별도 커밋으로 관리하며 사용자 변경 사항을 덮어쓰지 않았다.

## 사용 방법

1. HTML을 최대 10개 선택한다. 목록에서 이름·개수·상태를 확인하고, 변환 전 필요한 파일을 제거한다.
2. 공통 Viewport와 기존 옵션을 선택한다. 여러 파일 중 일부만 크기가 다르면 해당 행의 **Viewport 지정**을 펼쳐 너비·높이를 입력한다. 빈 필드는 공통 설정을 사용한다. 예를 들어 모바일은 360 × 844, PC는 1920 × 900으로 각각 지정할 수 있다.
3. **Figma로 변환**을 누른다. `2 / 5개 파일 처리 중 · 완료 1개`처럼 현재 항목과 완료 수를 표시한다. 파일 추가·제거·옵션 변경·중복 실행은 처리 중 제한된다.
4. 완료 후 정상 완료 / 경고 포함 완료 / 실패 / 미처리 수를 확인한다. 각 파일의 **상세 내용 보기** 또는 **오류 상세 보기**로 기존 Report를 확인한다.
5. 다른 파일 또는 같은 파일을 다시 선택하거나 현재 목록을 다시 변환할 수 있다. 이전 Canvas 결과는 유지한다.

11개 이상이면 `HTML 파일은 최대 10개까지 선택할 수 있습니다.`, 지원하지 않는 확장자가 포함되면 `HTML 파일만 업로드할 수 있습니다.`를 표시한다. 일부 파일을 조용히 누락시키지 않는다. 크기 초과·빈 파일·읽기 실패도 전체 교체 선택을 거부하며 기존 유효 목록과 Report를 유지한다. 새 유효 목록이 확정되면 이전 목록·Report·요약·JSON을 초기화한다. 기존 파일당 5MB 제한을 유지했다.

## 조사한 기존 경로와 재사용

| 기존 코드 | 기존 역할 | 이번 변경 |
| --- | --- | --- |
| `src/ui.ts`: 파일 input / drop / `readFile` | 단일 HTML 선택·FileReader·확장자/5MB/빈 파일 검증 | `selectFiles`에서 목록을 원자적으로 검증, `multiple`과 다건 drop 지원 |
| `src/ui.ts`: Convert handler | `parseHTML` 후 `CREATE_FIGMA` 송신 | 항목마다 기존 경로를 순차 실행하고 terminal 메시지까지 기다림 |
| `src/code.ts`: `figma.ui.onmessage` | busy/cancelled, validate → convert → report → terminal | Batch 세션과 순서 검사, 최상위 Frame 좌표 변경, 전체 종료 |
| `src/parser.ts`: `parseHTML` | sandbox iframe 렌더링, DOM/CSS/asset 분석, finally dispose | **변경 없음** |
| `src/converter.ts`: `convertDocument` | 독립 FontResolver/asset/Warning, 재귀 Node 생성·실패 정리·최종 sizing/naming/배치 | **변경 없음** |
| `src/report.ts` | Warning 분류·그룹화·발생 횟수·위치·결과 | **변경 없음** |
| `src/types.ts` | ParsedDocument·Report·메시지 타입 | 메시지/Batch 타입만 추가. 기존 Intermediate JSON 및 Report schema 유지 |
| `src/batch.ts` | 신규 orchestration helper | 최대 10개, 120px 간격, 상태별 요약 계산 |
| `src/ui.html` | 기존 디자인과 옵션·보고서 | 파일 목록·파일별 Viewport·전체 요약 추가 |

Flex/Grid, Width/Height, Nested Hug, Content Component, Rich Text, SVG/Donut, Background/Gradient, Form Control, Naming, Wrapper, Fixed/Absolute 관련 소스는 안정화 커밋과 바이트 단위로 동일하다. 기존 `showReport`의 Warning·통계·Debug 표시를 파일별 데이터로 호출한다.

## 처리 구조와 상태

UI 항목은 아래 데이터를 가진다. 파일명을 식별자로 사용하지 않는다.

```typescript
interface UploadItem {
  id: string;
  file: File;
  state: 'WAITING' | 'CONVERTING' | 'SUCCESS' | 'SUCCESS_WITH_WARNINGS' | 'ERROR';
  viewport?: { width?: number; height?: number };
  report?: ConversionReport;
  outcome?: ConversionOutcome;
  frameId?: string;
}
```

UI 전체는 기존 `idle → converting → success / error` lifecycle을 유지한다. 부분 실패가 있어도 처리 가능한 Frame이 있으면 전체 처리 완료를 표시하고 실패 수를 별도로 안내한다. 모든 파일이 실패하거나 Batch 자체가 시작되지 못하면 전체 UI는 error 상태로 복구된다. 파일별 ERROR와 전체 orchestration 실패는 구분된다.

순차 실행은 다음 terminal을 받은 뒤 다음 파일을 읽고 파싱한다. Parser와 Converter에 여러 문서를 동시에 넘기지 않는다.

```text
파일 읽기 → parseHTML → CREATE_FIGMA
                      → validateDocument → convertDocument → Report
                      ← CONVERSION_COMPLETE / CONVERSION_ERROR
파일 상태 확정 → 다음 파일
```

파싱·읽기 실패는 해당 항목의 `FILE_ANALYSIS_ERROR`로 Main에 전달한다. Main이 동일한 실패 Outcome을 반환하고 순서 커서를 진행한다. Converter를 호출하지 않는다. Canvas 생성 중 루트가 실패하면 기존 Converter가 해당 트리를 정리한다. 추가 Canvas 배치에서 실패해도 현재 파일의 Frame만 정리한다. 이미 성공한 다른 파일의 Frame은 제거하지 않는다.

## 메시지와 요청 보호

| 방향 | 메시지 | 식별 정보 / 역할 |
| --- | --- | --- |
| UI → Main | `BATCH_START` | batchId + 순서가 있는 itemId/fileName 목록 |
| Main → UI | `BATCH_STARTED` | batchId, 시작 확인 |
| UI → Main | `CREATE_FIGMA` | 기존 requestId/payload/fileName + Batch의 batchId/itemId |
| UI → Main | `FILE_ANALYSIS_ERROR` | batchId/itemId/requestId + 파싱/읽기 오류 |
| Main → UI | `PROGRESS` | requestId + 해당 Batch/Item, 기존 레이어 수 |
| Main → UI | `CONVERSION_COMPLETE` | 기존 Report/Outcome + frameId, 동일 Batch/Item/requestId |
| Main → UI | `CONVERSION_ERROR` | 기존 실패 Outcome, 동일 Batch/Item/requestId |
| UI → Main | `BATCH_FINISH` | batchId + 전체 취소 여부 |
| Main → UI | `BATCH_COMPLETE` | batchId + 파일 상태별 요약 |
| Main → UI | `BATCH_ERROR` | Batch 시작/종료의 orchestration 오류 |
| UI → Main | `CANCEL` | 현재 batchId 또는 단일 requestId로 전체 취소 |

한 파일이면 기존 `CREATE_FIGMA → CONVERSION_COMPLETE / CONVERSION_ERROR` 경로를 그대로 사용하며 Batch 세션을 만들지 않는다. 변환 함수를 이중 구현하지 않았다.

각 실행마다 새로운 Batch ID와 파일 requestId를 발급한다. 선택 항목은 독립 Item ID를 갖고, ID 생성에는 증가하는 sequence도 포함한다. UI는 Batch/Item/requestId가 모두 현재 항목과 일치하는 메시지만 처리한다. Main도 다음 예상 Item ID만 수락한다. 동일한 파일명, 이전 파일의 progress, 이전 Batch의 terminal/전체 완료/취소가 새 작업을 덮어쓰지 않는다.

## Canvas 배치와 Report

단일 변환은 기존 viewport 중앙 위치·선택·zoom 동작을 유지한다. 다건은 Batch 시작 시 Canvas viewport center를 저장한다. 첫 성공 Frame을 그 중심에 두고 이후 성공 Frame은 `previous.x + previous.width + 120`에 배치한다. Y는 첫 성공 Frame과 동일하다. 앞 파일이 실패하면 공간을 예약하지 않고 첫 성공 Frame부터 시작한다. 360 / 1920 / 1440px처럼 서로 다른 실제 생성 폭도 계산에 반영한다.

Debug의 Root y 기록은 기존 Converter 안에서 Batch 재배치 전에 수집된다. Batch의 최종 Canvas 좌표는 실제 최상위 Node에서 확인하며 내부 Frame의 상대 좌표와 높이 진단은 유지한다.

Main은 최상위 `x`, `y`만 바꾼다. 내부 X/Y, 크기, constraints, scroll fixed, Auto Layout, Hug/Fill, 자식 구조와 Naming은 건드리지 않는다. 기존 Canvas Frame을 이동·삭제하지 않는다. 완료 시 새 Batch의 살아 있는 성공 Frame을 함께 선택하고 화면에 맞춘다. 마지막 화면 맞춤에 실패해도 이미 성공한 파일 결과를 실패로 바꾸지 않는다.

기존 Converter 자체의 파일별 화면 맞춤은 유지되어 변환 중에는 viewport가 이동할 수 있다. 시작 anchor를 저장하므로 다음 Frame 좌표 계산에는 영향을 주지 않는다. 이전 Batch/사용자 Frame과의 자동 충돌 회피는 추가하지 않았으므로 시작 위치에 기존 Frame이 있으면 사용자가 새 Batch를 이동할 수 있다.

파일별 Report는 기존 7개 Warning 분류, 동일 원인 그룹 수, 반복 횟수, 대표 위치를 그대로 사용한다. 전체 요약은 파일 수만 집계하며 Warning 그룹 수와 발생 횟수를 합쳐서 표시하지 않는다. UI는 마지막 처리 파일의 Report를 우선 보여주고, 목록 버튼으로 원하는 파일의 Report를 확인한다. Debug는 기존처럼 별도 접힌 영역에 표시한다. Report 표시 오류는 Canvas 성공 여부나 다음 업로드를 막지 않는다.

## 메모리와 정리

선택 목록에는 File 객체를 유지한다. 선택 검증에서 읽은 HTML 문자열은 저장하지 않고, 변환할 때 해당 파일만 다시 읽는다. 렌더링 DOM/Computed Style/asset cache/FontResolver/Warning은 기존 호출마다 독립이다. `parseHTML`의 기존 finally가 iframe을 제거한다.

UI는 파일별 Report/Outcome과 Frame ID를 보관하지만 모든 Intermediate JSON과 image bytes를 누적 저장하지 않는다. 기존 JSON 저장 기능은 마지막 분석 문서 한 개만 유지한다. 다른 파일의 Report를 보고 있을 때 그 문서의 JSON으로 오해하지 않도록 저장 버튼을 숨긴다. Debug Mode 콘솔의 중간 문서에는 Batch/Item/fileName을 함께 출력한다.

Main은 Batch가 끝날 때 세션의 Frame 참조/Outcome을 해제한다. 실제 Canvas Node는 유지한다. 새 선택 시 이전 Report의 DOM 목록과 더 보기 handler도 해제한다. JSON 다운로드의 Blob URL은 기존처럼 revoke한다. 사용자가 직접 선택한 보조 이미지 목록은 공통 입력으로 재사용하며, HTML A가 발견한 asset을 B의 asset cache로 공유하지 않는다.

## 자동 검증

`tests/batch.test.mjs`는 실제 Chromium iframe UI와 Figma Plugin API mock을 연결한다. 1개·3개·10개, 다건 drop, 순서·120px 배치, 11개 거부, 비HTML·5MB·빈 파일·읽기 실패와 기존 선택 보호, 제거, 중간 루트/Parser 실패, CSS/asset/Warning/Debug 독립성, 파일별 Viewport 검증, 동일 이름, 반복/직접 재실행, 늦은 메시지와 취소, 전체 실패, Main의 잘못된 요청 거부를 검증한다.

`BATCH_BASELINE_SRC`에는 안정화 `6b49a83`의 src 경로를 지정한다. 실제 `09-01_A-pc-list.html`과 MVP/Dashboard/Form/Fixed/Grid/Rendering/Gradient/Inline/Naming/Rich Text/Content Component 등 12개 샘플을 두 Batch로 처리하고 이전 Main의 단일 변환과 비교한다. 보호된 소스와 Intermediate JSON/Report 타입이 동일함을 검사한다. 최종 tree의 내부 좌표, getter 기반 sizing/font/wrap, Text·Range·스타일·Paint·Naming·SVG/이미지 bytes·폰트 로딩·Report를 비교한다.

비교에서 제외/대응한 값은 루트 Canvas X/Y, 실행 시간, 실제로 다른 API Node ID 및 image handle, mock의 테스트 전용 누적 `loadedFonts` 기록이다. Node ID는 동일 tree 위치로 대응시키며 Debug 이유·좌표는 유지해서 비교한다. Range에 필요한 글꼴이 먼저 로드되었는지는 별도로 검사한다. 이미지 handle은 생성 bytes를 별도로 비교한다. 샘플별 증거는 Git 제외 파일 `test-results/batch-regression.json`, UI 스크린샷은 `test-results/batch-ui.png`에 저장한다.

기존 lifecycle 테스트의 잘못된 교체 선택 사례 한 개는 이번 요청의 유효 목록 보호 정책에 맞춰 기대값만 수정했다. 기존 변환 엔진에 관한 테스트의 기대값을 변경하지 않았다.

기존 컴포넌트 단계의 “UI/Main 변경 없음” source 비교는 `COMPONENT_IMPLEMENTATION_SRC`에 당시 `6b49a83` source를 지정해 보존했다. 현재 UI/Main은 이번 Batch 테스트에서 실행하고 현재 엔진은 전체 기존 테스트와 Batch의 source/tree 비교로 보호한다. Report 단계의 `REPORT_IMPLEMENTATION_SRC`에는 기존처럼 `d1d9cf6` source를 지정했다.

전체 실행 명령은 아래와 같다. 각 `/tmp` 경로는 해당 커밋의 `git archive <commit> src`를 푼 비교용 source다.

```sh
npm run typecheck
npm run build
HEIGHT_BASELINE_SRC=/tmp/yesrim-height-baseline/src \
NESTED_BASELINE_SRC=/tmp/yesrim-nested-baseline/src \
ACTUAL_HUG_BASELINE_SRC=/tmp/yesrim-actual-hug-baseline/src \
VIEWPORT_BLOCK_BASELINE_SRC=/tmp/yesrim-block-width-baseline/src \
REPORT_BASELINE_SRC=/tmp/yesrim-report-baseline/src \
REPORT_IMPLEMENTATION_SRC=/tmp/yesrim-component-baseline/src \
COMPONENT_BASELINE_SRC=/tmp/yesrim-component-baseline/src \
COMPONENT_IMPLEMENTATION_SRC=/tmp/yesrim-batch-baseline/src \
BATCH_BASELINE_SRC=/tmp/yesrim-batch-baseline/src \
node --test --test-concurrency=2 tests/*.test.mjs
```

최종 결과는 **TypeScript 검사·빌드 통과, 164개 중 163개 통과·실패 0개·조건부 skip 1개**다. 새 Batch 테스트 15개와 안정화 버전 비교 12개 샘플이 모두 통과했다. skip은 이전 Rich Text 단계의 조건부 비교이며 이번 Batch 검증의 skip이 아니다. 현재 UI/Main의 기존 lifecycle 테스트 20개와 이전 Height/Nested Hug/실제 원본/Report/Content Component 비교도 실행했다.

## 실제 Figma Editor에서 남은 수동 확인

이번 환경에서는 실제 Figma Editor를 실행하지 않았다. 자동 테스트 성공을 native 편집 검증 완료로 간주하지 않는다.

- 같은 플러그인 세션에서 1개 → 3개 → 10개 → 같은 파일 다시 선택/변환
- 360px 모바일 + 1920px PC의 실제 Frame 크기와 120px 간격, 이전 Canvas 결과 보존
- 중간 실패가 있어도 앞뒤 결과 유지, 파일별 Report와 마지막 전체 선택/화면 맞춤
- 원본 Tax Section에서 카드 6→7→6, Text 증가 시 Hug/Wrap과 다음 Section 이동
- native Figma font metrics, SVG importer, Gradient/Image 및 실제 시각적 비교

파일 재정렬, 개별 취소, 일시 정지/재개, 파일별 보조 이미지 세트, 모든 문서 JSON 일괄 내보내기는 이번 범위에 포함하지 않았다. 전체 취소는 완료한 Frame을 유지하고 아직 처리하지 않은 항목을 WAITING/미처리로 남긴다. 단일 엔진의 기존 지원 한계와 리소스 제한은 유지한다.
