# Chip / Badge / Button 콘텐츠 Auto Layout

Conversion Report 커밋 `d1d9cf6`을 완료하고 업로드한 뒤 진행한 별도 변경이다. 기존 Wrapper와 Naming을 유지하고, 단순한 기존 Frame에 선택적으로 Auto Layout을 적용한다.

## 원인과 실제 원본 조사

`09-01_A-pc-list.html`의 카드 칩은 span이지만 Flex item의 blockification 때문에 computed display가 **block**이다. 기존 Parser는 배경·padding이 있는 Text를 Frame + Text로 분리하지만, 단일 인라인 박스에 Horizontal을 적용하는 조건은 inline / inline-block만 허용한다. block으로 바뀐 span은 이 조건을 통과하지 못한다. Height의 일반 block flow 검사도 Hug Width / inline text child를 안전한 수직 Flow로 보지 않는다.

따라서 중간 데이터에 일부 Hug intent가 남아 있어도 최종 Converter의 `canHug`는 layoutMode:NONE Frame에 대해 false이며 Fixed로 대체한다. Text가 자체 auto width로 늘어나도 배경 Frame은 늘어나지 않는 구조였다. Converter가 마지막에 정상 Auto Layout을 덮어쓴 문제가 아니다.

기존 a 버튼은 display:flex로 Horizontal이 이미 설정되어 같은 문제를 겪지 않는다. 실제 `AI에게 묻기` / `계산하기`는 기존 Horizontal / Width Hug / 명시적 Height Fixed를 유지한다. 원본에는 `집을 팔려고 해요`가 있으며 요청의 `집 팔 거`는 별도 regression fixture에 포함했다.

## 생성 API 속성 비교

아래 수치는 원본 HTML을 Chromium에서 측정하고 Figma API mock으로 생성한 결과다. 실제 Figma editor에서 확인한 수치가 아니다. 외부 Google Fonts를 차단한 결정적 측정이므로 실제 글꼴의 pixel metric과 구분한다.

| 원본 텍스트 | 이전 Layout / Width / Height | 수정 후 | 최초 측정 크기 | Padding (상·우·하·좌) |
| --- | --- | --- | --- | --- |
| 집을 팔려고 해요 | NONE / Fixed / Fixed | Horizontal / Hug / Hug | 122 × 32 | 6 / 12 / 6 / 12 |
| 두 채 중 하나를 팔아요 | NONE / Fixed / Fixed | Horizontal / Hug / Hug | 155.609375 × 32 | 6 / 12 / 6 / 12 |
| 간편 | NONE / Fixed / Fixed | Horizontal / Hug / Hug | 40.09375 × 23 | 2 / 8 / 2 / 8 |

수정된 Frame의 주축·교차축 정렬은 Center, 자식 Text는 Width Hug / Height Hug / textAutoResize:WIDTH_AND_HEIGHT다. Border / Background / Radius / Opacity와 기존 이름은 유지한다. SVG 아이콘은 Fixed 크기를 유지하고 측정한 간격을 Horizontal gap으로 사용한다.

## 판별 범위와 파일

- `src/content-components.ts`의 `configureContentComponent()`는 기존 FRAME / layout NONE만 대상으로 한다. 새 Frame을 추가하거나 Text를 분리하지 않는다.
- 배경 Solid 또는 Border와 Padding이 있고, Text 1개와 선택적 작은 SVG/Image 아이콘으로 구성된 한 줄 박스만 허용한다. 최대 80자, 아이콘 32px 이하, 콘텐츠 높이 64px 이하의 보수적인 범위다. Tag 이름만으로 판별하지 않는다.
- 실제 content width와 자식 폭·측정 간격의 합이 일치해야 한다. 좌측 시작점과 아이콘의 수직 중앙도 측정값과 맞아야 한다. DOM Range로 한 줄 여부를 검사한다.
- inline / inline-block 또는 명시적인 fit-content / max-content, 정상적인 Flex blockification으로 콘텐츠 폭을 갖는 경우를 지원한다. 일반 auto-width block은 부모를 채우는 의미를 유지하며, 텍스트와 폭이 우연히 일치해도 승격하지 않는다.
- 이미 정상 Auto Layout인 요소, 명시적 Width/Height, Fill, flex-grow/basis, min/max 제약, multiline, 복잡한 자식, Absolute/Fixed, transform/relative offset, hidden, Rich Text range는 제외한다. 자식 Text의 별도 width/min/max 제약도 유지한다.
- 원본 CSS `white-space`를 유지한다. 선택된 한 줄 Text만 intrinsic auto width로 바꾼다. multiline나 폭 제약이 있는 Text를 무조건 Hug로 바꾸지 않는다.
- 글리프 Range 높이와 anonymous line box 높이는 다를 수 있다. 단순 한 줄 컴포넌트에서 기존 padding을 임의로 늘리지 않고, 측정된 콘텐츠 line box를 Text의 line height/높이에 연결한다. Text의 기존 명시적 line-height는 우선 유지한다.
- `src/parser.ts`는 기존 Height 정책 처리 후 helper를 호출한다. `src/types.ts`의 선택적 `layout.contentComponent`는 승인된 atomic box만 표시한다.
- `src/height-sizing.ts`는 기존 Wrap 검증에서 승인된 component의 Hug 폭을 추가로 허용한다. margin, 방향, 실제 행 배치와 높이 검증은 유지한다. 승인되지 않은 Hug 자식을 가진 Wrap에는 기존 fallback이 적용된다.

칩 행은 이전에도 computed Flex Wrap이었지만 Hug intent를 가진 칩을 허용하지 않아 NONE/Fixed로 fallback하는 경우가 있었다. 이 경우에만 기존 Frame을 native Wrap / Hug로 바꾼다. 초기 width, CSS padding, gap, 브라우저 행 위치는 그대로 유지하며 칩의 편집 이후 행 높이도 전파할 수 있게 한다. 기존 Card List의 Fixed card widths / 3열 Wrap, Card Hug, Tax Inner 최대 폭·중앙 정렬, Tax Section / Next flow는 바꾸지 않는다.

Converter / Sizing의 전역 Width 정책 / Rich Text / Naming / Form / SVG / Gradient / Report / UI / assets 모듈은 수정하지 않았다. Wrapper pruning과 결합하지 않았다. 생성 Node 수는 기존 버전과 동일하며 Auto Layout 수만 승인된 범위에서 증가한다. 정상 Wrap을 표현하게 된 행의 FLEX_WRAP fallback Warning은 제거되지만 Report의 분류·그룹화·상태 정책은 유지한다.

## 자동 검증과 재현

`test/content-components-regression.html`은 짧은 칩·Badge·일반 버튼·아이콘 버튼·Fixed/Fill·내부 Text 폭 제약·multiline·일반 block Fill·Absolute·plain inline·Rich Text·hidden·Auto Layout OFF를 검증하는 파일이다.

`tests/content-components.test.mjs`의 8개 테스트:

1. 실제 원본의 이전 NONE/Fixed와 수정 후 속성을 비교하고 기존 버튼을 보호한다.
2. 단순 컴포넌트의 동일 Frame/Text 개수, padding/radius/paint, Text Hug와 line box를 확인한다.
3. 아이콘·Text 순서, Vector, 측정 gap과 Center alignment를 확인한다.
4. Fixed/Fill/constraint/multiline/block Fill/Absolute/plain/Rich Text/hidden/OFF 제외 조건을 확인한다.
5. Text 박스 폭을 명시적으로 늘려 Chip/Badge/Button의 Hug width가 같은 양만큼 증가하는지 확인한다.
6. 원본의 적용된 19개 atomic box의 최초 폭·높이와 Tax의 승인된 5개 칩 행의 x/y/gap/초기 높이를 box model로 비교하고 카드 3열 × 2행을 확인한다.
7. 칩 Text 박스 폭 증가로 행 재배치 → Card/Tax 높이 증가 → Next 이동·복원을 확인하고, Text 폭 증가 시 아이콘 x 이동과 수직 정렬을 확인한다.
8. 직전 d1d9cf6과 원본 포함 12개 HTML의 전체 IR, 최종 API tree, 이미지/SVG bytes와 Node 수를 비교한다. 승인된 atomic Layout/sizing/line box와 검증된 chip-row의 native Layout 전환만 비교 예외로 지정한다. 다른 부모·폭·위치·paint·name·range·Wrapper는 계속 엄격하게 비교한다.

기존 실제 원본의 6→7→6 카드, 긴 Card Text, Tax Vertical/Hug, 다음 Section 이동 테스트도 현재 parser/converter로 실행한다. UI/Main의 Report/lifecycle 테스트도 현재 빌드로 실행한다.

`simulateHugWidth`는 명시적으로 켠 테스트에만 적용되는 mock의 박스 계산이다. 글꼴의 characters로 폭·높이를 만들어내는 모델이 아니며 실제 Text 편집은 실행하지 않는다. Hero의 복잡한 기존 Fill 분배 등 전체 Figma layout engine을 구현하지 않으므로 box projection의 x/y 검증은 보고된 Tax/Card List 경로에 한정한다. 다른 문맥은 이전/현재 전체 IR와 API snapshot 비교 및 수동 확인으로 구분한다.

Report 단계의 엔진 동일성 검증은 `REPORT_IMPLEMENTATION_SRC`에 d1d9cf6 source를 지정해 그 단계의 proof를 재현한다. 현재 코드의 intentional atomic 변경은 별도의 d1d9cf6 비교 테스트가 검사한다. 기존 Height/Nested/Gutter 비교에는 이후 atomic policy의 명시적인 비교 예외만 추가했다. 현재 Report 함수 소스가 d1d9cf6과 동일한지도 검사한다.

검증 산출물은 Git에서 제외되는 `test-results/content-components.json`과 기존 actual-nested-hug 결과다. 최종 TypeScript 검사·빌드 통과, 전체 149개 중 148개 통과·실패 0개·기존 Rich Text 엔진 비교 1개 조건부 skip. 컴포넌트 테스트 8개와 Report/lifecycle 24개 및 이전 Height/Nested/Actual/Gutter baseline 비교를 모두 실행했다.

## 수동 Figma 확인과 남은 범위

최신 manifest를 Reload하고 원본에서 칩/Badge의 Flow Horizontal, Width/Height Hug, Padding, Text auto width를 확인한다. `집을 팔려고 해요`를 `집 두 채 중 하나를 팔려고 해요`, `간편`을 `시뮬레이션`, fixture 버튼을 `양도소득세 계산하기`로 편집해 배경 확장과 아이콘 이동을 확인한다. 이어서 카드 7개 복제·삭제, Card 설명 증가, 다음 Section 이동, 기존 Hero/Timeline과 Fill/Fixed 버튼을 확인한다.

실제 Figma 편집·글꼴 metric·SVG importer는 이 환경에서 실행하지 않았다. 실제 native Auto Layout 속성이 적용되더라도 원본/대체 폰트의 폭과 line box 차이는 수동 확인이 필요하다. 과도하게 긴 Hug 텍스트는 부모 폭을 넘을 수 있으며, width/max-width가 있는 버튼이나 원래 multiline 컴포넌트는 이번 승격 대상에서 제외했다. 모든 Chip/Badge/Button이 일괄적으로 Hug가 된다고 보장하지 않는다.
