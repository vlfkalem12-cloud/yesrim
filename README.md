# HTML → Editable Figma

HTML 파일을 업로드하여 **편집 가능한 Frame / Text / Image Fill / SVG Vector / Auto Layout**으로 가져오는 Figma 플러그인입니다. 2차 버전은 기본 CSS Grid, 크기 제약, Absolute·z-index, 배경 이미지, 그림자와 변환 보고서를 지원합니다. 런타임 외부 라이브러리나 백엔드는 없습니다.

## 설치와 개발

Node.js 20 이상과 npm을 사용합니다.

```sh
npm ci
npm run typecheck
npm run build
```

빌드 결과는 `dist/code.js`, `dist/ui.html`입니다. `manifest.json`은 이 파일들을 가리킵니다.

```sh
npm run dev
```

개발 모드에서는 TypeScript와 UI HTML 변경을 다시 빌드합니다. Figma에서 플러그인을 다시 실행해 변경을 확인하세요. 별도의 웹 서버나 API 키는 필요하지 않습니다.

## Figma에서 불러오기

1. [GitHub에서 프로젝트 ZIP 다운로드](https://github.com/vlfkalem12-cloud/yesrim/archive/refs/heads/codex/html-to-figma-mvp.zip) 후 압축을 풉니다. ZIP에 소스와 빌드된 `dist` 파일이 포함되므로 실행만 할 때는 Node.js 설치나 빌드가 필요 없습니다. 직접 개발할 때는 위 설치·빌드를 실행하세요.
2. Figma 데스크톱 앱에서 디자인 파일을 엽니다. **Plugins → Development → Import plugin from manifest…**에서 압축을 푼 프로젝트 루트의 `manifest.json`을 선택합니다. 메뉴 위치는 Figma 버전에 따라 다를 수 있습니다.
3. 개발 플러그인 목록에서 **HTML → Editable Figma**를 실행합니다.
4. Figma에서 발급한 플러그인 ID가 필요한 경우, **New plugin**으로 로컬 플러그인을 등록하고 `manifest.json`의 `id`를 발급된 ID로 바꾸세요. 포함된 ID는 로컬 개발용 식별자이며 게시된 플러그인 ID가 아닙니다.

## HTML 테스트

1. `examples/mvp.html`을 업로드합니다. 요청에 포함된 원본 성공 조건 예제를 그대로 제공했습니다.
2. Desktop 1440, Auto Layout 적용, CSS 스타일 적용을 선택합니다.
3. **Figma로 변환**을 클릭합니다.
4. 현재 viewport 중앙에 생성된 최상위 Frame을 확인합니다. HTML 정보에 따라 `Page`, `Dashboard`, `Main` 등의 이름을 사용하고, 정보가 없으면 `Imported HTML`을 사용합니다. 자동 선택 및 화면 맞춤이 적용됩니다.
5. Layers에서 Header / Navigation, Section / Hero, Card / 제목, Button / 표시 텍스트를 탐색합니다. Text 내용, Auto Layout 방향·gap·padding, 카드 배경·border·radius를 직접 편집해 보세요. 텍스트의 기본 CSS margin을 표현하는 Margin Frame도 유지됩니다.
6. UI에서 실제 생성된 Nodes / Frames / Text / Images / Auto Layout / Grid / Absolute / SVG 수와 생성 시간을 확인합니다. Warning은 Fonts / Images / Unsupported CSS / Grid Fallback 등으로 묶이며 해당 HTML 요소가 표시됩니다. **JSON 저장**은 변환에 사용한 중간 데이터를 저장합니다. 플러그인 UI 콘솔에도 동일한 데이터가 출력됩니다.

변환 상태는 idle → converting → success / error로 관리합니다. 생성 완료 또는 오류 후 Loading이 종료되고 파일 선택·Convert·Drag & Drop이 다시 활성화됩니다. 같은 HTML 파일도 연속으로 선택하거나 바로 다시 변환할 수 있으며 플러그인을 닫을 필요가 없습니다. 새 HTML 파일을 선택하면 idle 상태로 초기화됩니다. 완료 보고서 표시 오류가 있어도 다음 변환은 가능합니다.

Viewport 너비와 높이를 **1~10,000px의 정수**로 직접 입력할 수 있습니다. `ViewportPreset` 타입과 `VIEWPORT_PRESETS`는 문서 크기와 분리된 너비·높이 쌍입니다. 기본값은 Desktop 1440의 1440 × 900px입니다. Desktop 1280은 1280 × 800, Tablet 768은 768 × 1024, Mobile 375는 375 × 812로 설정됩니다. 프리셋 선택 시 두 값이 함께 적용되며, 직접 입력한 너비·높이가 프리셋과 모두 일치할 때만 해당 프리셋으로 표시합니다.

입력한 너비·높이에서 실제 HTML을 렌더링하므로 CSS media query와 `vw` / `vh`가 반영됩니다. 생성되는 최상위 Frame의 너비는 입력값으로 고정하고, **Frame 높이는 콘텐츠에 따라 자동 결정**합니다. 입력한 높이는 HTML을 측정할 때의 viewport 높이입니다. 빈 값, 0, 음수, 소수, 범위 초과는 변환 전에 차단합니다.

원본 예제의 `.page { width:1440px; padding:40px }`는 기본 `content-box`이므로 브라우저에서 실제 폭이 1520px입니다. 플러그인은 요청한 최상위 폭 1440px을 사용하고 overflow Warning을 보여줍니다. 입력 HTML에 `* { box-sizing:border-box }`를 적용하면 이 차이를 줄일 수 있습니다.

### 2차 테스트와 옵션

`test/phase2-test.html`을 업로드하면 Grid, Image, inline SVG, Background Image, Fixed + Fill, Absolute·z-index, CSS Variable, 개별 border·radius, shadow, 한국어 줄바꿈, clipping, hidden 요소를 함께 확인할 수 있습니다. 실패 복구를 확인하기 위해 상대 경로 이미지 하나와 미지원 CSS 예제도 포함했습니다.

렌더링 수정 확인에는 `test/rendering-regression.html`을 사용하세요. `individual-border`, `shadow-card`, `minmax-box`, `overflow-inner`의 strong / p / span / 직접 텍스트와 중첩 Block, Absolute Frame 내부의 Block / Flex 자식, gradient 앞뒤에 배치된 URL 이미지가 검사 대상입니다. 일반 Block은 고정 Frame 안에 브라우저 측정 좌표를 부모 기준으로 배치하며, 텍스트 크기와 최상위 viewport 크기가 확정된 뒤 좌표를 적용합니다. `Background Image Test` / `NEW`처럼 폭 제약이 없는 한 줄 텍스트는 Auto Layout 밖에서도 Hug로 처리합니다. 명시적인 width / min-max / Fill / 양쪽 Absolute 고정 또는 실제 줄바꿈이 있는 텍스트는 폭 제약을 유지합니다. Auto Layout 크기 속성 설정이 실패하더라도 생성한 노드와 자식 구조를 삭제하지 않습니다.

폼 내용 확인에는 `test/form-controls-regression.html`을 사용하세요. input value `김`, 빈 value의 placeholder, textarea의 두 줄 내용, 선택된 option 및 label 속성, 빈 control과 중첩 label을 확인할 수 있습니다. checkbox / radio / button과 주변 Grid / Flex / Table / Absolute Badge / Image도 함께 배치했습니다.

Gradient 확인에는 `test/gradient-regression.html`을 사용하세요. 요청한 최상위 4-stop 배경, 0 / 90 / 180 / 270deg 방향, rgba stop, Grid 배경과 Text Frame, 미지원 각도의 Solid fallback을 포함했습니다.

접근성 숨김과 Mixed Inline 확인에는 `test/inline-accessibility-regression.html`을 사용하세요. 1px clip / inset label, 작은 SVG·Dot·Divider·Progress Bar, 질문 + Badge, Text + Icon, 교차하는 Text / Element, 순수 Text와 줄바꿈을 함께 확인할 수 있습니다. 접근성 숨김 제외 기록은 Debug Mode에서만 표시합니다.

Dashboard 렌더링 확인에는 `test/dashboard-rendering-regression.html`을 사용하세요. 요청한 180px Donut, 세 Gradient로 만든 25% / 50% / 75% Grid Line, 4열 Summary Card, Line Chart·Point·Tooltip·Legend·Axis Label, Widget·Status Badge·Quick Links·Error State·Progress Bar를 포함합니다.

Auto Layout / CSS 스타일 / Images / Shadows / Optimize Empty Wrappers는 기본 ON, Debug Mode는 기본 OFF입니다. Debug Mode를 켜면 `card [div.card]`처럼 레이어 이름에 HTML selector가 추가됩니다. Images를 끄면 이미지 bytes 수집과 Image Fill 생성을 생략하고 `img` 영역의 빈 Rectangle을 유지합니다. HTML 치수 측정 단계에서는 원본 이미지가 로딩될 수 있습니다. Inline SVG Vector 변환은 유지됩니다.

Multiple Background를 확인할 때는 **Debug Mode**를 켜고 완료 보고서의 **Debug** 항목을 펼치세요. 실제 computed `backgroundImage` / `background`, 레이어별 종류·색상·stop 위치·alpha, 최종 `figma fills` 수와 순서를 표시합니다. 요청한 Chart 배경은 `background layers: 4` (Gradient 3개 + Solid #FFFFFF), `figma fills: 4`로 표시됩니다. CSS shorthand의 마지막 색상은 computed `backgroundImage`에서 `none`이고 `backgroundColor`에 색상이 저장되므로, JSON에서는 이를 하나의 Solid base로 합칩니다. 같은 정보는 콘솔과 Frame의 `html-background-debug` plugin data에도 기록합니다.

### Layer Naming

`test/layer-naming-regression.html`은 Card / Widget, Navigation, Button, Form Label, Image alt, SVG Icon / Chart와 Utility class 필터링을 확인하는 예제입니다. Naming은 별도 `generateLayerName(element, context)`에서 계산하고, 모든 배치·스타일·SVG·크기·보고서 처리가 끝난 뒤 `node.name`에만 적용합니다. 기존 wrapper 구조와 Optimize 옵션 동작을 유지합니다.

이름의 우선순위는 aria-label → Semantic Tag와 짧은 대표 텍스트·연결된 label → id → 의미 있는 class → role → tag fallback입니다. id / class의 kebab-case, snake_case, camelCase를 읽기 쉬운 이름으로 바꾸며 Bootstrap / Tailwind의 배치·외형 Utility는 제외합니다. Card의 heading이나 짧은 label을 활용하고, Navigation의 첫 메뉴 항목이나 여러 문장으로 된 본문을 Container 제목으로 사용하지 않습니다. 대표 텍스트는 30자 이하, 최종 이름은 약 40자로 제한합니다. 같은 이름에 강제 번호를 붙이지 않습니다.

예를 들어 `Card / 오늘 업로드`, `Button / 저장`, `Input / Email`, `Select / Country`, `Checkbox / Save this information`, `Image / Bootstrap Logo`, `Icon / Search`, `Chart / Traffic`를 사용합니다. Form은 `for`로 연결된 label과 감싸는 label을 모두 읽습니다. Image는 alt, SVG는 aria-label / title / id / class / 크기와 Chart 문맥을 활용합니다. 순수 Text의 이름은 표시 내용을 사용하고 긴 이름만 축약합니다. 실제 `characters`는 전체 내용을 그대로 유지합니다.

중간 JSON의 `name`은 기존 내부 식별자이며 `layerName`이 Figma에서 보이는 이름입니다. 이전 JSON도 계속 처리합니다. Debug Mode의 콘솔에서 `HTML → Figma naming`을 펼치면 tag / class / id / label / text 후보, 선택 이유와 최종 이름을 확인할 수 있습니다. Debug의 레이어 이름에는 기존처럼 원본 HTML selector를 덧붙입니다.

### 모바일 Mixed Inline Rich Text

`test/rich-text-regression.html`을 Mobile 375에서 변환하면 152px 질문 카드 6개, Bold + 일반 문장, 문장 안의 strong, Text + Badge를 확인할 수 있습니다. 순수 텍스트 스타일만 다른 b / strong / em / i / u / small / span과 인접 Text는 하나의 편집 가능한 Rich Text로 합치며, childNodes 순서와 의미 있는 공백을 유지합니다. JSON의 `ranges`는 UTF-16 시작·끝 위치와 font family / weight / style / size, color, letter-spacing, line-height, decoration을 보관합니다. Range 폰트를 모두 로드한 뒤 Figma Range API를 적용하며, 없는 weight는 가장 가까운 사용 가능한 스타일과 Warning으로 처리합니다.

선두 SVG + Rich Text 문장은 기존 Frame 안에서 Horizontal Auto Layout, Icon Fixed, Text Fill + Hug Height와 `textAutoResize: HEIGHT`로 배치합니다. 텍스트 폭은 padding / border / Icon / 실제 공백을 포함한 간격을 뺀 나머지 폭입니다. 이 문장을 감싸는 단일 Block 카드와 해당 카드로만 구성된 Grid Row는 높이가 내용에 맞춰 늘어나도록 처리해 clipping을 피합니다. 기존 wrapper와 Layer Naming 함수는 유지하며, 단독 Bold 요소, Flex의 별도 항목, Background / Border / Padding / 명시적 크기 / 독립 opacity 등 박스가 있는 inline은 기존 노드 경로를 유지합니다. Text + Badge도 별도 Frame + Text로 유지합니다.

상대 경로 이미지는 **이미지 파일 추가 (선택)**에서 추가할 수 있습니다. HTML의 `images/banner.png`와 선택한 파일의 이름 `banner.png`를 연결합니다. 같은 파일명이 여러 개면 임의로 선택하지 않고 경고합니다. 외부 CSS·로컬 폰트 파일은 이 선택 기능에 포함되지 않습니다.

## 구현 구조

```text
manifest.json          Figma 설정
scripts/build.mjs      플러그인 main / UI 단일 파일 번들
src/code.ts            메시지 처리, 진행 상태, 오류·취소
src/ui.html            파일 업로드, viewport, 옵션, 결과 UI
src/ui.ts              FileReader, UI ↔ main 통신, JSON 다운로드
src/parser.ts          DOMParser, sandbox 렌더링, computed CSS → JSON
src/form-controls.ts   현재 value / placeholder / 선택된 option 및 텍스트 치수
src/gradients.ts       Linear Gradient 파싱, Solid fallback, Figma Paint 방향
src/backgrounds.ts     다중 배경·Solid base 통합, 얇은 반복 Grid Line 패턴 판별
src/dom-visibility.ts  접근성 숨김 clipping 조합 판정
src/inline-layout.ts   Mixed Inline 스타일 구분과 한 줄 Auto Layout
src/rich-text.ts       순수 Inline Text 병합·UTF-16 Range·Icon 옆 wrapping
src/layer-naming.ts    의미 기반 이름 생성과 최종 node.name 적용
src/sizing.ts          부모·Flex·CSS 크기와 min/max → Fixed / Fill / Hug
src/grid.ts            기본 Grid → 세로·가로 Auto Layout 중첩
src/assets.ts          이미지·배경 이미지 로딩, 상대 경로 연결, 캐시
src/svg.ts             Inline SVG 스타일 정규화와 Vector 입력 준비
src/css-variables.ts   CSS Variable 이름·최종 값·scope 메타데이터
src/optimizer.ts       안전한 빈 wrapper 제거
src/report.ts          요소 정보와 Warning 분류
src/types.ts           중간 문서·노드·스타일·통신 타입
src/converter.ts       JSON → Figma 노드, 폰트·이미지·Auto Layout
src/utils.ts           색상·숫자·여백·timeout 처리
examples/mvp.html      요청의 MVP 테스트 HTML
test/phase2-test.html  2차 기능과 실패 복구 테스트 HTML
test/rendering-regression.html  Block / Absolute / 다중 배경 렌더링 재현 HTML
test/form-controls-regression.html  Form Control 내용과 주변 Layout 회귀 HTML
test/gradient-regression.html  Linear Gradient 배경과 fallback 회귀 HTML
test/inline-accessibility-regression.html  접근성 숨김과 Mixed Inline 회귀 HTML
test/layer-naming-regression.html  의미 있는 Layer 이름과 Form / SVG / Utility class 예제
test/rich-text-regression.html  모바일 질문 카드 6개·Rich Text·Badge 회귀 HTML
tests/                 Chromium 파싱·UI 및 Figma API 모의 테스트
```

HTML → scripts-disabled iframe → DOM / computed styles / bounds → `ParsedDocument` → UI 메시지 → Figma API 순서입니다. DOM 분석 코드는 Figma main에서 실행하지 않으며, Figma 노드 생성 코드는 UI에서 실행하지 않습니다. `ParsedDocument.version`은 `1`입니다.

## 지원 범위

- `.html` / `.htm` 클릭 업로드와 Drag & Drop, 최대 5MB.
- DOM 계층과 id → 첫 번째 class → tag 우선순위 레이어 이름. 장식 없는 단일 body wrapper는 최상위 Imported HTML로 통합합니다. 별도 optimizer는 치수와 위치가 같은 익명 단일 wrapper만 보수적으로 제거합니다.
- 일반 컨테이너와 button은 Frame, h1~h6 / p / span / label / strong / small 등은 Text. 배경·padding·border가 있는 Text는 Frame 안에 Text를 배치합니다. 컨테이너의 직접 text node도 별도로 생성합니다.
- 순수 Text와 동일한 스타일의 단순 inline 자식은 기존 단일 Text를 유지합니다. Box가 없는 인접 Bold / Italic / Span과 일반 Text는 하나의 Rich Text에 Range 스타일로 표현합니다. Badge 등의 별도 박스는 childNodes 순서와 배경 / padding / radius / font / 크기를 보존합니다. 선두 SVG + Rich Text는 남은 폭에서 줄바꿈하며 TOP 정렬합니다. 그 밖의 한 줄이며 측정 간격이 일정한 Inline은 기존 Horizontal Auto Layout과 baseline 정렬을 사용합니다. 간격은 margin과 공백을 포함한 실제 bounding rect 차이로 계산합니다. 복잡한 Inline 박스의 줄바꿈은 측정된 상대 좌표를 유지합니다.
- text / search / email / url / tel / number input과 textarea는 현재 DOM value → placeholder → 빈 control 순으로 처리합니다. select는 현재 선택된 option의 표시 이름을 사용합니다. Control Frame의 측정 크기·border·padding을 유지하고 내부에 편집 가능한 Text를 배치하며, placeholder 색상·opacity와 textarea 줄바꿈을 반영합니다. label / span 안의 중첩 control도 유지합니다. checkbox / radio / button의 변환 경로는 유지합니다.
- Flex row / column → 가로 / 세로 Auto Layout. reverse 방향과 CSS order를 반영합니다.
- `gap`, 네 방향 padding, justify start / center / end / space-between, align start / center / end 및 cross-axis stretch.
- Typed OM으로 `auto` / `%` / px를 구분하고 측정 치수, 부모의 Flex 흐름, grow / shrink / basis와 min/max로 Fixed / Fill / Hug를 결정합니다. `flex:1`과 `width:100%`는 Auto Layout 부모에서 Fill을 사용합니다. 부모 Hug와 자식 Fill이 순환하면 부모의 측정 치수를 고정하고 경고합니다. min/max는 지원되는 Auto Layout 노드에 적용하며 그 밖에는 측정 크기와 경고를 유지합니다.
- 기본 Grid `repeat(2,1fr)` / `repeat(3,1fr)` / `1fr 1fr` / `200px 1fr`는 세로 Auto Layout → 가로 Row → Cell 구조로 변환합니다. `fr` Cell은 Fill, px Cell은 Fixed이며 row-gap / column-gap을 분리합니다. 마지막 행의 빈 Cell은 열 폭을 유지합니다.
- 양수 Flex 자식 margin은 투명 padding wrapper로 표현합니다. 비 Flex 요소는 브라우저가 측정한 좌표를 유지합니다.
- Absolute 요소는 Auto Layout 흐름에서 분리하고 부모 기준 상대 좌표를 유지합니다. top / right / bottom / left의 선언 방향에 따라 MIN / MAX / STRETCH constraints를 적용합니다. z-index는 흐름 위치를 유지할 수 있는 범위에서 레이어 순서로 반영합니다.
- Fixed 요소의 CSS inset은 선택한 viewport 너비·높이를 가진 별도 측정 공간에서 해석합니다. 원래 rect에서 right / bottom을 역산하지 않으므로 transform / filter / contain 부모의 문서 좌표가 최종 fixed 위치에 섞이지 않습니다. px / percentage / calc / font unit을 해석하고 양쪽 inset의 auto 크기도 viewport 기준으로 계산하며 min/max를 유지합니다. 내부 자식을 포함해 최상위 Frame으로 이동하고, Auto Layout 부모에서는 Absolute Position으로 흐름에서 분리합니다. 내부 absolute 자식의 right / bottom은 최종 fixed 부모 기준으로 유지합니다. Figma API가 지원하면 최상위 Frame의 `numberOfFixedChildren`을 설정하며, 실패 시 좌표·자식을 보존하고 `FIXED_SCROLL` Warning을 남깁니다. Fixed 레이어는 Figma 스크롤 고정 정책에 따라 일반 콘텐츠 위에 배치하고 서로의 z-index 순서를 유지합니다. Debug Mode의 `FIXED_POSITION` 보고서와 `html-fixed-position` plugin data에서 `[fixed] viewport: 1440×900, x: 240, y: 824` 형태의 최종 좌표를 확인할 수 있습니다.
- hex / rgb(a) / hsl(a) / transparent 색상, 네 방향 border 폭, 네 모서리 radius, 요소별 opacity, overflow hidden / auto / scroll clipping. 부모·자식 opacity는 각각 유지하며 곱한 값을 중복 적용하지 않습니다.
- 첫 번째 box-shadow를 Drop / Inner Shadow로 변환하며 다중 shadow는 경고합니다.
- font family / size / weight / italic / line-height / letter-spacing / text-align / text-transform / underline / strikethrough / white-space. 줄바꿈 Text는 측정된 폭 또는 Fill 폭을 사용하고 높이는 자동 결정합니다. nowrap / pre는 줄바꿈을 강제하지 않습니다.
- 사용 가능한 폰트를 조회하고 **로드를 완료한 뒤** 텍스트를 설정합니다. 한국어는 요청한 한국어 지원 폰트 → Pretendard → Noto Sans KR → 알려진 한국어 지원 폰트 순서로 대체하며 영문 전용 fallback을 사용하지 않습니다. 폰트 교체와 로드 실패를 보고하고 로드 결과를 캐시합니다.
- `img`는 편집 가능한 Rectangle + Image Fill. HTTPS CORS 이미지와 `data:image`를 PNG bytes로 전달합니다. `contain`은 FIT, 나머지는 FILL로 근사합니다. 동일 URL의 이미지 데이터는 재사용합니다.
- `linear-gradient()`은 `GRADIENT_LINEAR` Fill로 변환합니다. 0 / 90 / 180 / 270deg, 기본 방향과 to top / right / bottom / left, hex / rgb / rgba, 0~100% stop과 2개 이상의 색상을 지원합니다. 생략한 stop은 CSS에 맞게 분배합니다. 색상의 alpha와 Frame opacity를 각각 유지합니다. 파싱 실패 또는 Gradient Paint 적용 실패 시 첫 유효 color stop의 Solid Fill과 `GRADIENT_FALLBACK` Warning을 남깁니다. body / html의 최상위 Gradient와 장식된 Text의 배경도 보존합니다.
- `background-image:url(...)`은 해당 Frame의 Image Fill로 변환합니다. 다중 배경은 괄호·따옴표를 고려해 최상위 쉼표에서 분리하고 모든 URL / Linear Gradient를 CSS 순서대로 Fill 배열에 유지합니다. 첫 레이어가 위, 단색 배경이 맨 아래입니다. 각 URL의 size / position / repeat과 이미지 캐시를 유지하며 cover / contain / center / no-repeat을 우선 지원합니다. Images를 꺼도 모든 Linear Gradient는 유지됩니다. 실패한 Gradient는 해당 위치에서 Solid fallback으로 처리하며 다른 Fill과 내부 자식을 유지합니다. 미지원 레이어는 원본 CSS와 `BACKGROUND_LAYER` Warning을 남기고 해당 레이어만 생략합니다. 완전히 투명한 stop의 alpha를 보존하면서 주변 RGB를 사용해 검은 보간 가장자리를 피합니다. 기존 version-1 JSON의 단일 Gradient / Image 필드도 처리합니다.
- 같은 색의 얇은 수평 Grid Line Gradient가 3개 이상 일정한 간격으로 반복될 때는 1px Rectangle으로 재현합니다. 지원 패턴은 전체 배경 크기에서 방향 0 / 180deg, transparent → 색상 → transparent의 대칭 3-stop, 전체 폭 2% 이하입니다. 선은 콘텐츠 뒤에 배치하고 Auto Layout에서는 Absolute로 처리합니다. 폭은 최종 Frame 전체 폭이며 STRETCH constraint로 유지합니다. 원본 Gradient Paint와 stop 데이터는 숨김 상태로 보존하고 흰색 등 Solid base는 표시합니다. Debug에는 fallback Rectangle 수와 실제 좌표도 나옵니다. 일반·넓은·수평 방향·간격이 불규칙한·색상이 다른·타일 크기를 지정한·이미지가 섞인 Gradient는 기존 Fill로 유지합니다. Rectangle 생성 실패 시 부분 생성물을 제거하고 원본 Gradient와 Warning을 유지합니다.
- Inline `<svg>`는 computed fill / stroke 등 스타일을 반영한 SVG를 `figma.createNodeFromSvg`로 전달하여 Vector를 유지합니다. 실패하면 placeholder Frame과 경고를 만들고 다른 요소를 계속 처리합니다.
- Donut의 fill:none인 dashed circle은 cx / cy / r, dasharray / dashoffset / pathLength에 따른 실제 표시 구간을 명시적인 SVG Arc path로 변환해 importer의 dash 해석을 피합니다. 연속 구간과 원의 seam을 유지하고 stroke-width / linecap / opacity / 2D rotate를 보존합니다. 일반 Icon / Path / Rect / Circle / Line / Polyline은 기존 native Vector import 경로를 유지하며 raster Image로 바꾸지 않습니다. 변환 예외가 발생하면 원본 SVG stroke와 `SVG_DASH` Warning을 유지합니다. 길이가 0인 점선이나 매우 촘촘한 패턴은 원본 SVG 형태로 전달합니다.
- CSS Variable은 최종 computed 값을 스타일에 적용하고 이름·값·scope를 JSON에 보관합니다. 실제 Figma Variable 생성은 후속 확장을 위한 범위입니다.
- display:none / visibility:hidden 요소는 기본적으로 생략합니다. 복잡한 Grid와 줄바꿈 Flexbox는 경고와 함께 측정된 고정 좌표로 보존합니다.
- 접근성용 숨김은 절대·고정 위치, 1px 이하 치수, 완전히 닫힌 clip / inset 및 overflow 또는 보조 spacing 조합으로 판단합니다. 크기·class 이름·aria-hidden만으로 제외하지 않습니다. 숨김 자식이 부모의 Text에 합쳐져 노출되지 않도록 하며, 포커스 후 실제로 보이는 요소는 유지합니다. Debug Mode에서만 `ACCESSIBILITY_HIDDEN` 기록을 남깁니다.
- 개별 노드·폰트·이미지 실패는 Warning과 함께 계속 처리합니다. 폰트가 하나도 로드되지 않으면 Text 대신 placeholder를 만들고 명시합니다. 취소된 Figma 변환의 부분 Frame은 제거합니다.

## 미지원 범위와 Known Issues

- JavaScript 실행 결과, interactive state, animation / transition, Shadow DOM / Web Components, canvas / video / iframe, complex transform / float / pseudo-element는 재현하지 않습니다. 일부는 경고와 빈 Frame으로 대체되거나 생략됩니다.
- Grid span / 명시적 배치 / dense / 복잡한 track 함수와 `flex-wrap`은 editable fixed layout으로 보존합니다. 기본 Grid의 모든 Cell은 측정된 행 높이를 사용하므로 후속 편집 때 CSS의 자동 행 높이와 차이가 날 수 있습니다.
- 순수 스타일 차이의 문장과 선두 SVG + 문장은 Rich Text로 줄바꿈합니다. 여러 독립 박스가 섞이는 복잡한 Inline 줄바꿈은 측정된 Text / Frame 좌표를 사용합니다. Rich Text 카드만 있는 Grid Row는 내용 높이를 사용하므로 문장 길이가 다르면 같은 행의 카드 높이가 달라질 수 있습니다. 가상 리스트, 스크립트로 생성되는 DOM, form control의 내부 브라우저 렌더링은 완전히 재현하지 않습니다.
- cardinal 방향 외의 Linear Gradient 각도, px stop / color hint / 두 위치 stop / 색상 보간 공간은 Solid fallback으로 단순화합니다. radial / conic / repeating gradient, 반복 배경 / center 이외 배경 위치, list marker, writing-mode / RTL, space-around / evenly, baseline, 개별 align-self 정렬, 음수 margin, 서로 다른 border 색상은 생략하거나 단순화합니다. Figma API가 지원하지 않는 Frame shadow spread는 blur·offset을 유지하고 경고합니다.
- 서로 다른 flex-grow 비율은 Figma Fill의 동일 분배와 차이가 있어 측정 크기로 고정하고 경고합니다. 복잡한 flow 자식 z-index와 CSS stacking context 전체는 완전히 재현하지 않습니다.
- HTML 파일만으로 상대 경로 파일이나 로컬 폰트 파일을 읽을 수 없습니다. 이미지는 함께 선택할 수 있고, CSS는 인라인 또는 HTTPS URL을 사용하세요. HTTP와 기타 URL scheme은 외부 리소스로 허용하지 않습니다.
- 원격 CSS·웹 폰트·이미지는 Figma 네트워크 정책, CORS, 로그인 여부에 따라 실패할 수 있습니다. 이미지 실패 시 placeholder, 스타일 실패 시 현재 렌더링된 스타일을 사용하고 경고합니다. 외부 리소스는 요청한 호스트로만 로딩하며 업로드 HTML/JSON을 서버에 전송하지 않습니다. manifest의 wildcard 네트워크 권한은 임의 호스트의 입력 리소스를 지원하기 위한 것입니다.
- 브라우저 웹 폰트와 Figma에서 실제 로드되는 폰트의 metrics가 다르면 줄바꿈과 최종 높이가 달라질 수 있습니다. Figma 노드 치수는 브라우저 측정값을 시작점으로 사용합니다.
- `object-fit:fill`의 비율 왜곡은 FILL로 근사하며 경고합니다. `<img src="...svg">`는 raster Image Fill이며 inline `<svg>`만 Vector 변환 경로를 사용합니다.
- 한국어 지원은 알려진 폰트 family로 판단하며 실제 glyph coverage를 검사하지 않습니다. 한국어 폰트가 전혀 없으면 영문 폰트로 바꾸지 않고 placeholder와 경고를 만듭니다.
- 최상위 Frame 폭은 사용자가 입력한 viewport를 우선합니다. 충돌하는 루트 min/max-width는 해제하고 경고합니다.
- 파싱 노드 최대 3,000개, 깊이 최대 80, SVG 내부 요소 최대 1,000개, 이미지당 PNG 4MB / 총 16MB / 이미지당 16MP 제한을 적용합니다. 생략 및 제한 초과는 경고/오류로 표시됩니다.
- 취소는 HTML 리소스 로딩 중에는 현재 분석 단계가 끝난 뒤 반영됩니다. Figma 생성 중에는 다음 노드/진행 지점에서 반영됩니다.
- Typed OM이 없는 브라우저의 CSS cascade fallback은 복잡한 specificity와 외부 CSS의 크기 선언을 완전히 해석하지 않습니다.
- Figma API 모의 테스트는 실제 Figma layout engine이나 font metrics를 구현하지 않습니다. 실제 Figma에서의 시각적 비교와 개발 플러그인 import는 별도로 확인해야 합니다.

## 자동 검증

```sh
npm run typecheck
npm test
```

Chromium을 사용합니다. 이 클라우드 환경의 `/usr/bin/chromium`을 자동 사용합니다. 다른 환경에서는 아래 명령으로 Playwright Chromium을 설치하거나 `CHROMIUM_PATH`로 실행 파일을 지정하세요.

```sh
npx playwright install chromium
```

테스트는 실제 Chromium에서 MVP 예제·viewport·업로드 UI·스크립트 차단·computed CSS·이미지 bytes를 확인하고, Figma API 모의 환경에서 Auto Layout 속성·편집 가능한 Text·폰트 로딩 순서·실패 복구·main 통신·취소를 검사합니다. 2차 검증은 Grid 4개 패턴, SVG Vector 생성 호출, 상대 경로·배경 이미지 재사용, HTTPS 이미지 응답과 CORS 실패, Absolute·z-index, min/max, 색상·shadow, 한국어·white-space, 옵션·Debug·보고서, 500개 DOM 항목을 포함합니다. HTTPS 응답은 브라우저 테스트에서 재현하며 외부 사이트의 실제 서비스 상태는 검증하지 않습니다.

렌더링 회귀 검증은 Normal Flow와 Absolute의 중첩 자식·텍스트·상대 좌표, Auto Layout 밖의 텍스트 크기 API 거부 상황, 선택적 크기 설정 실패 후 자식 보존, 다중 배경에서 URL 선택과 레이어별 설정을 검사합니다. 마지막 Layout 검증은 별도로 측정한 브라우저 좌표와 최종 자식 좌표를 비교하고, 무제약 한 줄·직접 텍스트·장식된 텍스트의 Hug, 빈 래퍼 제거 후 Hug 유지, 실제 줄바꿈·폭 제약 유지, Hug 크기 변경 후 Absolute right / bottom 고정을 확인합니다. API 거부·실패와 크기 설정에 따른 위치·폭 변화는 모의 환경에서 재현합니다.

Lifecycle 검증은 실제 iframe UI와 Main 번들을 연결하여 A → B → C, 동일 파일 재선택, Drag & Drop, 파일 읽기·파싱·Main 생성 실패 후 재시도, 보고서 표시 실패, 이전 요청의 늦은 응답, 중복 요청 및 알림 실패를 검사합니다.

Form Control 검증은 value / placeholder 우선순위, 빈 control, textarea 줄바꿈, 선택된 option의 label, 초기 HTML 속성과 다른 현재 DOM value / selectedIndex, 중첩 label, 기존 checkbox / radio / button 및 주변 Layout을 검사합니다. Auto Layout과 CSS 스타일을 끈 경우도 확인합니다.

Gradient 검증은 요청한 4-stop 배경, CSS 방향과 Figma transform의 시작·끝 좌표, hex / rgba alpha, 기본·생략 stop, 파싱·Paint 적용 실패 후 Solid fallback, body / html 및 익명 wrapper 보존, Grid Row / Cell·Text의 배경 중복 방지, 기존 단색·이미지·opacity와 옵션 처리를 검사합니다.

접근성 / Mixed Inline 검증은 clip / inset / 보조 spacing 패턴, Debug 기록, 포커스 후 표시, 작은 SVG·Divider·Progress Bar 보존, Text + Badge / Icon의 스타일·DOM 순서·간격, 순수 Text / br 유지, 줄바꿈의 브라우저 상대 좌표, 옵션 OFF 및 같은 HTML 연속 변환 후 동일한 구조·좌표·스타일을 검사합니다.

Fixed 검증은 긴 문서의 하단 바 (`1440×900`에서 `240,824,1200,76`), 사용자 지정·모바일 viewport, percentage / calc / margin inset, Hug 폰트 치수 변경, 양쪽 inset의 auto 크기, clipped 부모에서 분리, 내부 Absolute·Form·Grid 유지, 중첩 fixed 레이어 순서, 옵션 OFF 및 스크롤 고정 API 실패를 검사합니다. 추가 검증은 transform / filter / contain 부모에서 문서 기준 rect가 생성되는 실패를 재현하고, 1500 / 1800 / 3600px 문서·좁은 부모에서도 viewport 좌표·크기를 유지하는지 검사합니다. 네 preset의 높이, 직접 입력 왕복, font unit / min-max, 기존 version-1 JSON 호환, Debug 좌표와 메시지 검증도 포함합니다. 실제 iframe UI에서 동일 HTML을 viewport 크기와 preset을 바꾸며 연속 변환하는 흐름도 확인합니다. 테스트 HTML은 `test/fixed-position-regression.html`입니다.

Dashboard 검증은 원본 Donut과 직렬화한 Arc SVG의 Chromium 픽셀 비교, 양·음 dashoffset / pathLength / full circle / seam / CSS 회전 기준, 일반 SVG 도형·Line dashoffset 및 Vector import 전달을 확인합니다. 세 Grid Line은 최종 Solid base·Rectangle을 별도 SVG로 표현해 25% / 50% / 75%의 1px 선과 정확히 픽셀 비교하고, 원본 CSS 스크린샷과도 비교합니다. computed CSS와 IR 4개 레이어·4개 Paint·alpha·stop, UI Debug 표시, Auto Layout 제외·최종 폭·opacity, 제한된 fallback 패턴과 Rectangle / Gradient API 실패도 검사합니다. 다중 URL·Gradient 순서 / alpha / 이미지 캐시·옵션, 한 레이어의 파싱·Paint·이미지 실패 후 나머지 유지, 합성 Text·Grid Fill 중복 방지, wrapper / html / body / 기존 JSON 및 같은 Dashboard 연속 변환도 검사합니다.

Naming 검증은 우선순위·Semantic / Label / SVG / Image·Utility 제외·이름 길이·중복·본문 제외·DOM 보존·Debug 후보를 확인합니다. Landing / Dashboard / Form / Fixed / Phase 2 / Rendering / Gradient / Inline / Naming의 9종 샘플에서 이름을 제외한 모든 노드 속성, 구조·생성 수, 보고서, SVG·이미지 bytes를 비교합니다. 앞서 완료한 Layer Naming 커밋 `007c1ae`의 검증에서는 수정 전 엔진 `b7d456e`와도 직접 비교해 Naming 메타데이터를 제외한 파싱 데이터 및 이름을 제외한 477개 노드의 결과가 동일함을 확인했습니다. 비교 산출물은 `test-results/layer-naming-regression.json`입니다.

Rich Text 검증은 모바일 카드 6개·하나의 문장·UTF-16 Range·중첩 스타일·공백·Icon 폭·Fill/Hug·박스 제외·폰트 대체·Range API 실패·옵션 OFF·UI 반복 변환을 검사합니다. Figma API 결과의 폭과 Range를 브라우저 DOM에 투영해 여러 줄과 가용 폭을 독립 확인하며, 이는 실제 Figma 렌더링 스크린샷이 아닙니다. 수정 전 엔진 `007c1ae`와 비교한 Dashboard / Form / Landing / Fixed / Phase 2의 5종 전체 문서·Figma 노드·이름·보고서·SVG·이미지가 동일함을 확인했습니다. `RICHTEXT_BASELINE_SRC`를 이전 src 경로로 지정하면 이 비교를 다시 실행할 수 있습니다. 산출물은 `test-results/rich-text-intermediate.json`, `test-results/rich-text-regression.json`, `test-results/rich-text-browser-projection.png`입니다.

전체 94개 테스트와 TypeScript 검사·빌드가 통과했습니다. `test-results/mvp-intermediate.json`, `test-results/phase2-intermediate.json`, `test-results/ui.png`, `test-results/phase2-ui.png`는 현재 실행의 검증 산출물이며 Git에서 제외됩니다. Figma API 모의 환경은 실제 layout engine·font metrics·SVG importer를 구현하지 않으므로 최종 시각적 비교는 Figma 데스크톱 앱에서 제공한 테스트 HTML로 확인해야 합니다.
