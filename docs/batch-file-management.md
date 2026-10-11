# Batch 파일 관리·Report·리소스 개선

기준은 안정화된 Batch 커밋 `c993265`다. 파일 관리 → Report/JSON → 파일별 이미지 순서로 수정하고 각각 별도 커밋으로 관리했다. 최종 변경은 기존 변환 엔진과 Batch 메시지·120px Canvas 배치를 유지한다.

## 사용 방법

1. HTML 1~10개를 선택하거나 Drop한다. 새 선택은 기존 목록을 **교체**한다. `.html/.htm`과 파일당 5MB 제한을 유지한다.
2. 목록의 **위로/아래로**, **삭제**, **전체 삭제**를 사용한다. 이미 생성한 Figma Frame은 유지된다. 결과가 있는 전체 삭제는 확인창을 표시하며 개별 삭제는 즉시 처리한다.
3. 공통 Viewport를 설정하고 필요한 행의 **파일별 설정**을 펼친다. 빈 너비·높이는 공통 설정을 따른다. 하나만 선택한 경우에도 파일별 설정을 사용할 수 있다.
4. 각 HTML에서 필요한 이미지를 그 행의 **로컬 이미지 연결 (선택)**에 첨부한다. 복수 선택을 지원하며, 새 이미지 선택은 해당 HTML의 이미지 목록을 교체한다. 이름·개수·용량·상대 경로를 확인하고 개별 또는 전체 이미지를 제거할 수 있다.
5. **Figma로 변환**을 누른다. 처리 중에는 순서·삭제·Viewport·이미지·옵션 변경이 잠긴다. 실패한 파일 다음에도 나머지 파일을 처리한다.
6. 완료 후 목록의 **결과 보기**로 Report를 선택한다. 처음에는 첫 번째 결과를 선택하고, 이미 선택한 Item ID가 있으면 유지한다. 선택 행과 파일명·현재 순서를 함께 표시한다. 삭제하면 다음 결과, 없으면 이전 결과를 선택한다.
7. 필요한 경우 접힌 **개발자 옵션**을 열어 선택 파일의 **변환 데이터(JSON) 다운로드** 또는 **Debug 정보**를 확인한다. 설정·이미지·순서 변경은 다음 변환부터 적용하며, 이전 Report와 JSON은 이전 실행의 실제 데이터를 유지한다.

## 기존 구현 조사

| 항목 | 기존 Batch | 수정 후 |
| --- | --- | --- |
| HTML 선택 | 최대 10개, 원자적 교체, 동일 이름을 독립 ID로 관리 | 교체 유지, 제안 목록 내부의 실제 중복만 거부 |
| 중복 검사 | 내용 비교 없음 | 이름/상대 경로·크기 후보를 골라 읽은 내용의 SHA-256 비교; 지원하지 않으면 일시적 문자열 비교 |
| 목록 | 업로드 순서 유지, 변환 전 삭제 | 위/아래 이동, 완료 후에도 삭제·전체 삭제 |
| 오류 | 공통 상태 문구 | 업로드 영역 바로 아래 단일 inline alert; 거부된 선택은 유효 목록·Report 보호 |
| Report | 마지막 파일 기본 선택 | Item ID 선택·강조, 첫 번째 결과 기본, 순서 변경 후 선택 유지 |
| JSON | 마지막 live ParsedDocument 한 개 | 모든 파일의 실제 분석 시점 JSON을 독립 immutable Blob으로 보관 |
| 이미지 | 공통 FileReader Data URL map | 각 Item의 목록과 정확한 경로/유일한 파일명 map을 분리 |

HTML 중복 판정은 timestamp를 내용의 증거로 사용하지 않는다. 같은 이름·크기의 다른 내용은 허용한다. 선택 검증에서 읽은 내용을 재사용하고 모든 파일에 불필요한 hash를 계산하지 않는다. 후보 내용과 hash는 선택 검증 종료 후 보관하지 않는다. 동일 파일의 재선택·재변환을 막는 전역 blacklist도 만들지 않는다. 11개 이상은 중복보다 개수 오류를 먼저 표시한다.

## 변경한 소스와 보호 범위

| 파일 | 주요 변경 |
| --- | --- |
| [ui.ts](../src/ui.ts) | `selectFiles`, `renderItems`, `moveItem`, `removeItem`, `clearFiles`, `renderSelectedResult`, `renderImageSettings`, `selectImages`, 파일별 snapshot/download 정리 |
| [ui.html](../src/ui.html) | inline alert, 선택 행, 전체 삭제 dialog, 파일별 설정, Report 선택 제목, 접힌 개발자 옵션 |
| [upload-files.ts](../src/upload-files.ts) | 읽기·검증·중복 비교와 공통 오류 문구 |
| [json-snapshots.ts](../src/json-snapshots.ts) | 기존 JSON 표현을 chunk로 직렬화, gzip Blob 보관과 다운로드 때 해제 |
| [file-images.ts](../src/file-images.ts) | 파일별 이미지 읽기·제한 검사·정확한 경로와 유일한 이름 map·충돌 안내 |
| [assets.ts](../src/assets.ts) | `normalizeLocalAssetPath`, `resolveLocalAsset`의 안전한 map 조회 |
| [parser.ts](../src/parser.ts) | local resource 인자 타입을 `LocalAssetInput`으로 변경한 네 곳뿐 |
| [types.ts](../src/types.ts) | UI 전용 `LocalAssetBundle/LocalAssetInput` 추가; 기존 JSON/Report/protocol 타입 유지 |

`code.ts`, Converter, Layout/Sizing/Hug, Width, Wrapper, Layer Naming, Rich Text, Form, SVG/Donut, Gradient, 이미지 decode/PNG bytes, Warning 정책은 변경하지 않았다. Parser 본문도 인자 타입 외에는 바이트 단위로 유지했다. 이미지 resolver의 기존 flat map 입력도 지원한다.

각 `UploadItem`은 `id`, `File`, 상태, Viewport, 이미지 목록, Report/Outcome, Frame ID, snapshot/options/error를 소유한다. 순서는 Item 객체를 배열에서 이동해 관리하며 파일명을 key로 쓰지 않는다. 이동 시 결과와 리소스가 함께 이동한다. 새 실행은 이전 결과/snapshot을 해제하고 새 request/batch ID를 사용한다. 기존 Main과 UI의 stale message 보호도 유지한다.

## 이미지 매칭 정책과 한계

정확히 정규화된 상대 경로를 먼저 연결한다. 정확한 경로가 없으면 그 HTML의 첨부 목록에서 파일명이 유일한 경우만 연결한다. 같은 이름의 여러 후보 또는 중복 exact path는 임의 선택하지 않는다. 예를 들어 `a/logo.png`, `b/logo.png`에 서로 다른 `logo.png`를 첨부했다면 각 이미지의 경로 필드에 이를 지정한다. `c/logo.png`를 어느 쪽에도 자동 연결하지 않는다.

`./`, `/`·역슬래시, 내부 `.`/`..`, query/fragment와 percent encoding을 정규화한다. 이 작업은 업로드한 map 안의 문자열 비교이며 로컬 filesystem을 읽지 않는다. 파일 선택창은 보통 폴더 경로를 제공하지 않으므로 경로가 필요한 경우 사용자가 지정한다. 실제 폴더 업로드·경로 복원 시스템은 추가하지 않았다.

기존 `<img>`와 inline/style 태그 CSS의 `url(...)` 처리 범위만 유지한다. Data URL·HTTPS·Inline SVG는 기존 파이프라인을 사용한다. 외부 CSS·로컬 font·모든 CSS URL 문법을 자동 처리하는 기능은 추가하지 않았다. 미연결 이미지는 기존 IMAGE_SOURCE/IMAGE_LOAD 등의 Report로 안내하며, 경로 중복은 파일별 설정에서도 설명한다.

이미지 선택 제한은 HTML별 최대 100개, 파일당 4MB, 총 16MB다. 실제 decode의 16MP/4MB/16MB/timeout 제한도 유지한다. 잘못된 이미지 교체는 기존 이미지 목록을 보존한다. A의 이미지는 B에게 전달하지 않으며 Parser의 decode cache는 기존처럼 문서마다 새로 생성한다.

## JSON 보관과 메모리

snapshot은 해당 파일 분석 직후 만든 데이터이며 다운로드를 위해 다시 파싱하지 않는다. 버전 1 schema와 `JSON.stringify(doc, null, 2)` 표현을 그대로 유지한다. 이미지 bytes도 숫자 배열로 들어간다. asset 배열은 4,096개씩 문자열을 만들고 stream으로 넘겨 전체 pretty JSON 문자열을 한 번에 만들지 않는다. 가능하면 gzip Blob만 보관한다. gzip을 지원하지 않는 환경에서는 JSON Blob을 보관한다. 다운로드할 때만 gzip을 풀어 일반 `.json` 파일을 만든다.

분석 실패 파일은 JSON이 없어 버튼이 비활성화된다. 분석에 성공한 뒤 Figma 생성에 실패한 경우 JSON을 **분석 데이터 · Frame 생성 실패**로 표시한다. snapshot 저장 실패는 Canvas 변환을 중단하지 않고 개발자 영역에 별도로 안내한다. 일반 사용자는 JSON을 사용하지 않아도 변환할 수 있다. Debug 콘솔은 파일 ID/version/용량 등의 metadata를 출력하며 전체 live ParsedDocument를 10개씩 console에 유지하지 않는다.

개별 삭제·전체 삭제·유효 목록 교체·새 실행 시 이전 snapshot 참조를 제거한다. 이미지와 Report의 관련 참조/DOM도 제거한다. 다운로드 Blob URL은 소비 후 timeout으로 revoke하고, 소유 Item 삭제·전체 삭제·새 선택·새 실행 시 즉시 정리한다. 진행 중 다운로드가 끝나기 전에 Item이나 snapshot이 교체되면 이전 파일의 다운로드를 만들지 않는다. 삭제는 Figma Canvas를 제거하지 않는다.

메모리 수치는 실제 Chromium renderer에서 측정한 별도 [측정 결과](validation/batch-memory.json)와 snapshot [크기 결과](validation/json-snapshot-storage.json)를 사용한다. 원본 실행 산출물은 `test-results/`에 있고 Git에서 제외한다. 위 링크는 검토를 위해 복사한 작은 측정 기록이다. Native Blob 크기와 JS heap은 서로 다른 지표다. GC 후 heap이 즉시 최초 값으로 복귀한다고 보장하지 않는다. Figma Canvas/native memory는 측정하지 않았다. 최대 크기 10×16MB 입력의 최악 메모리를 보장하는 벤치마크도 아니다. 큰 원본은 이미지 압축이나 Batch 분할이 필요할 수 있다.

| 측정 | 결과 |
| --- | --- |
| 이미지 입력 | 256×256 noise PNG 225,872 bytes를 HTML 10개에 각각 첨부; 동일 이미지 fixture |
| 초기 / 첨부 후 JS heap (강제 GC 후) | 1.74 / 2.45 MiB |
| 변환 중 샘플링한 JS heap 최고값 | 29.91 MiB; 실제 순간 peak의 상한을 보장하지 않음 |
| 변환 완료 / 전체 삭제 후 JS heap (강제 GC 후) | 4.01 / 4.02 MiB |
| 완료 시 snapshot Blob 합계 | JSON 보관 합계: 5879.3 KB |
| 전체 삭제 후 snapshot 보관량 | 0.0 KB; item/file/resource/JSON 선택 UI 제거, Canvas 10개 유지 |
| 1MiB 반복 byte 배열 직렬화 fixture | JSON 11,083,996 bytes / gzip Blob 75,961 bytes; 실제 PNG의 압축률을 보장하는 수치가 아님 |

삭제 후 JS heap은 최초 값으로 바로 복귀하지 않았다. 브라우저·자동화의 다른 참조와 heap 지표가 포함되므로 숫자만으로 프로세스 메모리 전체 해제를 주장하지 않는다. UI가 소유한 snapshot 보관량 0, 참조 정리 경로, 다운로드 URL revoke는 별도로 검사했다.

## 자동 검증

TypeScript 검사와 build가 통과했다. 전체 **180개 중 179개 통과, 실패 0개, skip 1개**다. skip은 이전 Rich Text 단계의 조건부 엔진 비교이며 신규 UX 테스트 **16개는 모두 실행·통과**했다. 기존 164개 중 163개도 실행·통과했다. [12개 HTML 동일성 결과](validation/batch-ux-regression.json)를 보관했다.

신규 UX 테스트는 순서 변경·완료 후 삭제·확인 취소/삭제·재업로드·upload picker/drop 오류·same filename/different content·busy 상태·Report 선택·정확한 JSON 다운로드·실패 파일·URL revoke·gzip/plain 표현·asset 격리·경로 충돌·다음 실행 반영·HTTPS/Data URL/Inline SVG·10개 이미지 파일 heap 측정을 검증한다.

`c993265`와 원본 Tax/MVP/Dashboard/Form/Fixed/Phase2/Rendering/Gradient/Inline/Naming/Rich Text/Content Component 12개 HTML을 비교했다. 현재 Parser의 전체 IR와 최종 Node tree/getter sizing/Range/Paint/Name/이미지 bytes/SVG가 동일했다. 기존 `6b49a83` 단일 변환 대비 Batch의 Report/Debug/폰트 로딩 비교도 유지한다. 최상위 Canvas X/Y·실행 시간·API ID와 opaque image handle은 기존 기준대로 대응한다.

과거 단계의 source 보호는 그 단계 구현을 freeze해 유지한다. `BATCH_IMPLEMENTATION_SRC=c993265`, `COMPONENT_IMPLEMENTATION_SRC=6b49a83`, `REPORT_IMPLEMENTATION_SRC=d1d9cf6`를 사용한다. 현재 엔진과 허용한 resource 인자 변경은 신규 UX 비교와 전체 기존 기능 테스트에서 직접 검사한다. `/tmp` 경로는 해당 커밋의 `git archive <commit> src`를 푼 것이다.

```bash
HEIGHT_BASELINE_SRC=/tmp/yesrim-height-baseline/src \
NESTED_BASELINE_SRC=/tmp/yesrim-nested-baseline/src \
ACTUAL_HUG_BASELINE_SRC=/tmp/yesrim-actual-hug-baseline/src \
VIEWPORT_BLOCK_BASELINE_SRC=/tmp/yesrim-block-width-baseline/src \
REPORT_BASELINE_SRC=/tmp/yesrim-report-baseline/src \
REPORT_IMPLEMENTATION_SRC=/tmp/yesrim-component-baseline/src \
COMPONENT_BASELINE_SRC=/tmp/yesrim-component-baseline/src \
COMPONENT_IMPLEMENTATION_SRC=/tmp/yesrim-batch-baseline/src \
BATCH_BASELINE_SRC=/tmp/yesrim-batch-baseline/src \
BATCH_IMPLEMENTATION_SRC=/tmp/yesrim-ux-baseline/src \
BATCH_UX_BASELINE_SRC=/tmp/yesrim-ux-baseline/src \
node --test --test-concurrency=2 tests/*.test.mjs
```

## 수동 확인이 필요한 항목

자동 검증은 Chromium UI와 Figma API mock이다. 실제 Figma Editor에서의 UI 다운로드, 원본 폰트 metrics, native Auto Layout/Wrap 편집과 시각적 비교를 수행했다고 보고하지 않는다.

- 플러그인을 열어 1/3/10개 반복 변환, 같은 HTML 재선택, 실패 후 재시도 및 완료 후 삭제/재정렬을 확인한다.
- 파일마다 다른 Viewport/이미지를 지정하고, 같은 이름의 다른 이미지가 섞이지 않는지 확인한다.
- 순서·설정 변경 후 Report/JSON이 이전 실행을 유지하고 다음 변환에만 설정이 반영되는지 확인한다.
- Layout/Wrap/Hug/Text/Donut/Gradient/Form·Width·Layer Naming·Wrapper의 시각적/편집 결과를 확인한다.
- 사용자가 제외 요청한 `A03-02_B3-switch.html`, `A03-03_A3-propose.html` 첨부는 테스트·소스·커밋에 포함하지 않았다. 올바른 원본이 다시 제공되기 전까지 두 화면의 실제 원본 비교와 360×844 시각 확인은 미검증이다.

Drag 정렬은 추가하지 않고 위/아래 버튼으로 범위를 제한했다. 개별 취소·일시 정지/재개·전체 JSON ZIP·폴더 업로드·로컬 CSS/font 연결도 이번 변경에 포함하지 않는다.
