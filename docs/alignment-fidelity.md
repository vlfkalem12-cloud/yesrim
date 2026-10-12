# Alignment Fidelity 수정 보고서

기준 버전은 Batch 파일 관리까지 완료한 `4304645`다. 바텀시트 조사·최소 수정·자동 테스트를 먼저 완료해 `67f1c8c`로 커밋한 뒤 채팅을 수정했다. 원본 HTML을 고치거나 Parser/Converter를 전체 재작성하지 않았다. Batch UX 및 Frame/JSON Naming 정책은 변경하지 않았다.

## 재현 파일과 원본 보존

| 파일 | 업로드 원본과 동일한 SHA-256 |
| --- | --- |
| [A01-02_A1-sheet.html](../test/actual/A01-02_A1-sheet.html) | `3496d5e5851b16a946010725700067d7f9a3eb2c718ae63cace519bf5a639bc6` |
| [A03-01_B3-chat.html](../test/actual/A03-01_B3-chat.html) | `47d5af0fffcf0d2473824056c9edfe326abbc546e0eb5bcf4d1586ae6ef7fbf6` |

각 파일은 **360×844 Viewport**에서 원본 DOM과 Computed Style을 읽었다. 자동 테스트에서는 Google Fonts CSS 요청을 차단해 결과를 재현 가능하게 했다. 이는 실제 Figma의 IBM Plex Sans KR font metrics 검증이 아니다.

## 오류 원인과 전달 경로

1. `getComputedStyle()`은 핸들의 `align-self:center`, 사용자 말풍선의 `flex-end`, 응답 그룹의 `flex-start`를 정상 반환했다.
2. Parser의 `readLayout()`은 `layout.alignSelf`에 이를 그대로 저장했다. `justify-content:flex-end/space-between`, `align-items:center/flex-end`, `text-align:center`도 각각 MAX/SPACE_BETWEEN, CENTER/MAX, center로 보존됐다.
3. 기존 Converter의 `applySizing()`은 다른 `align-self`를 **부모 정렬로 단순화했다는 Warning**만 남겼다. 개별 정렬이 실제 Node 속성으로 적용되지 않았다.
4. 바텀시트의 핸들은 `margin-bottom:8px` 때문에 40px 폭의 기존 margin Frame 안에 있었다. 부모와 이 Frame 모두 시작 정렬을 사용해 핸들이 X=0에 놓였다.
5. 채팅의 사용자 말풍선은 기본 block + 단일 익명 Text지만 Width Hug/inline-flow 검증에 걸려 Figma `NONE / Fixed Height`로 생성됐다. 메시지 본문을 늘려도 말풍선 높이가 따라가지 않았다.
6. 중앙 안내문의 부모는 이미 **Vertical / Hug**였다. 측정된 Normal Flow가 CENTER를 유지하기 위해 자식 폭을 Fixed로 보관하면서, 부모 폭 변경 시 안내문·입력행이 원본의 block 자동 폭처럼 확장하지 못했다.
7. 전체 Regression에서 별도 사례를 발견했다. 장식된 Text를 Frame + inner Text로 나누는 기존 Parser 경로는 일부 부모 `align-self`를 inner Text에도 복사한다. 이 값은 실제 자식 Element의 CSS 의도가 아니다. Converter에서 inner Text에 이를 적용하지 않아 기존 버튼 내부 CENTER를 보존했다.

설치한 `@figma/plugin-typings 1.117.0`의 `AutoLayoutChildrenMixin.layoutAlign` 설명은 MIN/CENTER/MAX를 deprecated로 명시하며, 현대 API는 부모의 `counterAxisAlignItems`가 모든 자식에 공통 적용된다고 설명한다. 따라서 deprecated 값을 자식에 쓰는 방식으로 해결하지 않았다.

## 바텀시트 최종 속성

기존 margin Frame을 그대로 재사용했다. 새 Frame 추가와 기존 Layer Name 변경이 없다. 핸들의 Fixed 크기, Sheet의 padding, margin-bottom 8px을 유지한다.

| Node/속성 | 수정 전 | 수정 후 |
| --- | --- | --- |
| 핸들 | NONE, Width 40 Fixed, Height 4 Fixed | 동일 |
| 핸들 X — Sheet 기준 | 0 | **160**; 원본 브라우저와 동일 |
| 기존 Margin Frame layoutMode | VERTICAL | VERTICAL |
| 기존 Margin Frame Width/Height mode | FIXED / FIXED | **FILL / HUG** |
| 기존 Margin Frame Width/Height | 40 / 12 | 360 / 12 |
| 기존 Margin Frame counterAxisAlignItems | 시작 정렬 | **CENTER** |
| 기존 Margin Frame paddingBottom | 8 | 8 |
| Sheet | Vertical, Width Fixed, Height Hug | 동일 |

부모 Sheet 폭을 420px으로 바꾸면 핸들 40px의 X는 190px, 핸들 폭을 60px으로 바꾸면 X는 180px이 됐다. 이 결과는 X를 다시 쓰는 코드가 아니라 Fill span + Native CENTER에서 나온다. [실제 생성 API 속성과 변경 기록](validation/alignment-sheet.json)을 보관했다.

## 채팅 수정과 기존 정렬 유지

| 대상 | 이전 상태/원인 | 최종 Native 속성 |
| --- | --- | --- |
| 대화 영역 | 이미 하단 정렬 의도 정상 | Vertical, Width Fill, Height Fill, `primaryAxisAlignItems:MAX` 유지 |
| 사용자 말풍선 정렬 | 부모 MIN으로 단순화 | 투명 helper: Vertical, Width Fill, Height Hug, `counterAxisAlignItems:MAX` |
| 사용자 말풍선 내용 | NONE/Fixed Height | Vertical/Hug Height; 원본 측정 폭 273.265625px은 Fixed로 유지, inner Text는 Fill/Hug |
| AI 응답 그룹 | flex-start, 기존 Vertical/Hug | MIN과 기존 그룹 폭 유지; 단순한 inner block Text Frame의 Height만 전파 가능하게 연결 |
| 중앙 안내문 | CENTER Text, Fixed 폭 | `textAlignHorizontal:CENTER` 유지; 검증한 margin Frame 안에서 Width Fill/Height Hug |
| 안내문/입력행 부모 | 기존 Normal Flow Vertical/Hug | 원본 rect·margin·padding을 검증한 두 자식만 native margin/Fill 구조로 연결 |
| 입력행 | 기존 `align-items:flex-end` | Horizontal, `counterAxisAlignItems:MAX` 유지; 전체 사용 가능한 폭으로 Fill |
| Header | 기존 space-between + center | `primaryAxisAlignItems:SPACE_BETWEEN`, `counterAxisAlignItems:CENTER` 유지 |

[수정 전 채팅 API 속성](validation/alignment-chat-before.json)도 기준 엔진으로 별도 기록했다.

말풍선의 Viewport 내 X는 16px의 helper X + 54.734375px의 말풍선 X = **70.734375px**로 원본과 같다. 부모 폭 420px에서도 오른쪽 padding 16px을 유지한다. 단순 Text의 height 증가가 말풍선 → helper → 대화 flow로 전파되고 하단 행은 하단에 남는다. AI 답변 높이 증가도 그룹 높이에 반영된다.

중앙 안내문은 현재 폭에서 원본 312px을 유지하고 Root 폭을 420px으로 변경하면 372px으로 따라간다. margin-left/right 10px과 bottom 8px은 Frame padding으로 유지한다. 입력 Frame 높이를 늘렸을 때 보내기 버튼은 Native MAX에 따라 입력행 하단에 남는다. [수정 후 초기/편집 속성 기록](validation/alignment-chat.json)을 보관했다. 이 기록의 `before`는 **수정 후 크기 편집 직전 상태**이며, 수정 전 엔진 결과라는 의미가 아니다.

## 수정 범위와 안전 조건

- [alignment.ts](../src/alignment.ts): 개별 center/flex-start/flex-end, 투명 span 설정, 단순 aligned Text 및 중앙 안내문/입력행의 안전 조건을 분리했다.
- [converter.ts](../src/converter.ts): 필요한 경우 기존 margin Frame 재사용 또는 최소 helper 추가, 검증된 Text flow 연결, inner Text의 복사된 align-self 무시, 최종 sizing 복원과 API 실패 fallback을 추가했다.
- [alignment.test.mjs](../tests/alignment.test.mjs): 원본 두 파일의 Computed Style/IR/최종 API 속성, 크기 편집, deprecated API 거부, fallback과 전체 엔진 보호를 검사한다.
- 기존 mock에 **선택적으로 활성화하는** 정렬 box model을 추가했다. 기존 테스트의 기본 동작은 유지한다. 이는 실제 Figma layout/font engine이 아니다.

새 span은 원래 부모와 같은 방향의 Auto Layout이며, 교차축 Fill·주축 Hug를 사용한다. 원래 주축 Fill인 자식은 주축 Fill을 보존한다. 원래 부모의 padding/gap/정렬과 원본 Element의 Fixed/Hug 크기를 바꾸지 않는다. 원래 부모와 정렬이 같으면 helper가 필요 없다. styles 없는 helper에 source child를 넣어 Normal Flow를 유지하며 Absolute로 빼지 않는다.

새로운 기본 Block 전체에 Auto Layout을 적용하지 않았다. Text flow는 명시적인 정렬 context 안의 div, auto-height, 기존 plain Text 한 개인 경우만 연결한다. Rich Text·복합 자식·명시적인 높이는 기존 경로를 유지한다. 안내문/입력행은 두 자식의 원본 X/폭/Y가 padding·border·양수 margin과 정확히 맞고 collapse/offset이 없는 경우만 적용한다.

Parser, Intermediate JSON/schema/version, UI, Main↔UI lifecycle, `sizing.ts`, Naming, Rich Text, SVG/Donut, Form, Grid, Gradient, Image resolver 및 JSON 보관은 변경하지 않았다. Width 정책 파일도 그대로다. 말풍선의 기존 측정 폭은 보존하며, 원본 block의 사용 가능한 폭을 이미 차지하던 안내문/입력행만 정렬을 위해 Fill로 연결했다.

## 자동 검증과 Regression 구분

TypeScript 검사와 build가 통과했다. 전체 **191개 중 190개 통과, 실패 0개, 기존 조건부 skip 1개**다. 신규 Alignment 테스트 **11개 모두 실행·통과**했으며 기존 180개 중 179개도 통과했다. skip은 이전 Rich Text 단계의 조건부 엔진 비교다. 정렬·실제 PC 원본·Chip 테스트 31개도 별도로 모두 통과했다.

신규 검증은 두 축의 Fixed 아이템, Hug Chip text box 크기 변경, Sheet 부모/핸들 폭 변경, 사용자·AI Text box 높이 변경, 대화 Fill 영역과 마지막 행 위치, 안내문 폭/높이 변경, 입력 높이와 보내기 버튼 하단, Header 오른쪽 끝, API 실패 및 Auto Layout OFF/Absolute/Wrap/Cross-axis Hug를 포함한다. Text box 크기 변경은 Native font editing을 자동 실행했다는 의미가 아니다.

직전 `4304645`와 **현재 Converter를 직접** 비교한 12개 HTML은 전체 IR, 기존 source Node의 모든 API 속성·name·range·paint·SVG/image bytes·font loads 및 비정렬 Warning이 동일했다. [동일성 결과](validation/alignment-regression.json)를 보관했다. `09-01_A-pc-list.html`의 우측 샘플 말풍선에 필요한 투명 helper 1개만 추가되어 총 Node는 291→292다. 기존 CSS margin Wrapper는 제거하지 않는다. ALIGN_SELF Warning 감소와 이 helper만 승인한 차이다.

기존 6→7→6 카드 복제/삭제와 Text 성장의 Tax Section/조상/Next 전파 테스트도 현재 엔진에서 실행한다. 과거 단계 비교는 승인된 정렬 helper만 source-tree 비교에서 제외하고, 그 이외의 기존 속성/스타일은 비교한다. 과거 Batch 엔진의 완전 동일성 증거는 `4304645` Main을 동결하여 현재 Parser/UI에서 유지한다. **현재 Main의 기능 테스트는 현재 빌드로 실행하고**, 현재 엔진의 정렬 이외 동일성은 위 신규 12개 HTML 비교에서 직접 검증한다. 동결한 과거 증거를 현재 엔진이 수정 전과 완전히 같다는 주장으로 사용하지 않는다.

실행 시 이전 단계와 같은 baseline 환경변수에 `ALIGNMENT_BASELINE_SRC=/tmp/yesrim-alignment-baseline/src`를 추가한다. 해당 경로는 `git archive 4304645 src`의 source다. `node --test --test-concurrency=2 tests/*.test.mjs`로 Chromium 동시 실행을 제한한다.

## 실제 Figma Editor에서 확인할 항목

자동 검증은 Chromium 원본 DOM + 실제 Parser/Converter + Plugin API mock이다. 실제 Figma Editor에서의 폰트 편집·렌더링을 수행했다고 보고하지 않는다.

1. 최신 빌드로 두 원본을 각각 또는 Batch로 변환하고 파일별 Viewport를 **360×844**로 지정한다.
2. Sheet의 기존 Margin Frame이 Vertical / Width Fill / Height Hug / CENTER인지 확인한다. 핸들은 40×4 Fixed를 유지하며 가운데 있어야 한다.
3. Sheet 폭 420 및 핸들 폭 60으로 편집해 중앙 정렬, padding·원본 margin을 확인한다.
4. 채팅의 우측/좌측 말풍선, 대화 영역 Fill/MAX, 실제 Font에서의 줄바꿈과 긴 문장 편집 시 Height 전파·겹침을 확인한다.
5. Root 폭과 안내문 Text를 편집해 CENTER/FILL 및 margin을 확인한다. 입력 Frame 높이를 늘려 버튼 하단 정렬을 확인한다.
6. 실제 IBM Plex Sans KR 또는 fallback font의 metrics, 초기 세로 좌표·그림자·Gradient/SVG/Chip Wrap·기존 화면 스타일을 시각적으로 비교한다.

## 지원 한계

Figma는 한 부모의 자식별 교차축 정렬을 직접 노출하지 않아 필요한 경우 투명 helper가 추가된다. Wrap 또는 교차축 Hug 부모는 Fill helper가 sizing 순환을 만들 수 있으므로 기존 경로를 유지한다. Native Auto Layout 부모에서 지원할 수 없는 개별 정렬은 ALIGN_SELF Warning으로 안내한다. 복잡한 Wrap은 기존 측정 위치 fallback을 유지한다.

CSS percentage max-width를 편집 시 매번 재계산하는 시스템, RTL/writing-mode의 모든 논리 정렬, flex shrink 전체 재현, 복합 Rich Text의 새로운 flow 정책은 추가하지 않았다. 부모 폭 변경 후 말풍선의 우측 정렬은 유지하지만 percentage max-width를 Figma에 live binding한 것은 아니다. Absolute/Fixed 위치 정책도 그대로다. 이 한계와 실제 폰트 렌더링은 수동 확인이 필요하다.
