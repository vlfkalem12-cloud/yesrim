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
4. 현재 viewport 중앙에 생성된 **Imported HTML**을 확인합니다. 자동 선택 및 화면 맞춤이 적용됩니다.
5. Layers에서 `header → nav`, `hero → button`, `card-list → card` 구조를 펼칩니다. Text 내용, Auto Layout 방향·gap·padding, 카드 배경·border·radius를 직접 편집해 보세요. 텍스트의 기본 CSS margin을 표현하기 위해 일부 `/ margin` Frame이 추가됩니다.
6. UI에서 실제 생성된 Nodes / Frames / Text / Images / Auto Layout / Grid / Absolute / SVG 수와 생성 시간을 확인합니다. Warning은 Fonts / Images / Unsupported CSS / Grid Fallback 등으로 묶이며 해당 HTML 요소가 표시됩니다. **JSON 저장**은 변환에 사용한 중간 데이터를 저장합니다. 플러그인 UI 콘솔에도 동일한 데이터가 출력됩니다.

변환 상태는 idle → converting → success / error로 관리합니다. 생성 완료 또는 오류 후 Loading이 종료되고 파일 선택·Convert·Drag & Drop이 다시 활성화됩니다. 같은 HTML 파일도 연속으로 선택하거나 바로 다시 변환할 수 있으며 플러그인을 닫을 필요가 없습니다. 새 HTML 파일을 선택하면 idle 상태로 초기화됩니다. 완료 보고서 표시 오류가 있어도 다음 변환은 가능합니다.

Viewport 너비와 높이를 **1~10,000px의 정수**로 직접 입력할 수 있습니다. 기본값은 1440 × 900px입니다. 기존 Desktop 1440 / Desktop 1280 / Tablet 768 / Mobile 375 프리셋도 사용할 수 있으며, 프리셋을 선택하면 높이는 900px로 설정됩니다. 값을 수정하면 직접 입력 모드로 전환됩니다.

입력한 너비·높이에서 실제 HTML을 렌더링하므로 CSS media query와 `vw` / `vh`가 반영됩니다. 생성되는 최상위 Frame의 너비는 입력값으로 고정하고, **Frame 높이는 콘텐츠에 따라 자동 결정**합니다. 입력한 높이는 HTML을 측정할 때의 viewport 높이입니다. 빈 값, 0, 음수, 소수, 범위 초과는 변환 전에 차단합니다.

원본 예제의 `.page { width:1440px; padding:40px }`는 기본 `content-box`이므로 브라우저에서 실제 폭이 1520px입니다. 플러그인은 요청한 최상위 폭 1440px을 사용하고 overflow Warning을 보여줍니다. 입력 HTML에 `* { box-sizing:border-box }`를 적용하면 이 차이를 줄일 수 있습니다.

### 2차 테스트와 옵션

`test/phase2-test.html`을 업로드하면 Grid, Image, inline SVG, Background Image, Fixed + Fill, Absolute·z-index, CSS Variable, 개별 border·radius, shadow, 한국어 줄바꿈, clipping, hidden 요소를 함께 확인할 수 있습니다. 실패 복구를 확인하기 위해 상대 경로 이미지 하나와 미지원 CSS 예제도 포함했습니다.

렌더링 수정 확인에는 `test/rendering-regression.html`을 사용하세요. `individual-border`, `shadow-card`, `minmax-box`, `overflow-inner`의 strong / p / span / 직접 텍스트와 중첩 Block, Absolute Frame 내부의 Block / Flex 자식, gradient 앞뒤에 배치된 URL 이미지가 검사 대상입니다. 일반 Block은 고정 Frame 안에 브라우저 측정 좌표를 부모 기준으로 배치하며, 텍스트 크기와 최상위 viewport 크기가 확정된 뒤 좌표를 적용합니다. `Background Image Test` / `NEW`처럼 폭 제약이 없는 한 줄 텍스트는 Auto Layout 밖에서도 Hug로 처리합니다. 명시적인 width / min-max / Fill / 양쪽 Absolute 고정 또는 실제 줄바꿈이 있는 텍스트는 폭 제약을 유지합니다. Auto Layout 크기 속성 설정이 실패하더라도 생성한 노드와 자식 구조를 삭제하지 않습니다.

폼 내용 확인에는 `test/form-controls-regression.html`을 사용하세요. input value `김`, 빈 value의 placeholder, textarea의 두 줄 내용, 선택된 option 및 label 속성, 빈 control과 중첩 label을 확인할 수 있습니다. checkbox / radio / button과 주변 Grid / Flex / Table / Absolute Badge / Image도 함께 배치했습니다.

Auto Layout / CSS 스타일 / Images / Shadows / Optimize Empty Wrappers는 기본 ON, Debug Mode는 기본 OFF입니다. Debug Mode를 켜면 `card [div.card]`처럼 레이어 이름에 HTML selector가 추가됩니다. Images를 끄면 이미지 bytes 수집과 Image Fill 생성을 생략하고 `img` 영역의 빈 Rectangle을 유지합니다. HTML 치수 측정 단계에서는 원본 이미지가 로딩될 수 있습니다. Inline SVG Vector 변환은 유지됩니다.

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
tests/                 Chromium 파싱·UI 및 Figma API 모의 테스트
```

HTML → scripts-disabled iframe → DOM / computed styles / bounds → `ParsedDocument` → UI 메시지 → Figma API 순서입니다. DOM 분석 코드는 Figma main에서 실행하지 않으며, Figma 노드 생성 코드는 UI에서 실행하지 않습니다. `ParsedDocument.version`은 `1`입니다.

## 지원 범위

- `.html` / `.htm` 클릭 업로드와 Drag & Drop, 최대 5MB.
- DOM 계층과 id → 첫 번째 class → tag 우선순위 레이어 이름. 장식 없는 단일 body wrapper는 최상위 Imported HTML로 통합합니다. 별도 optimizer는 치수와 위치가 같은 익명 단일 wrapper만 보수적으로 제거합니다.
- 일반 컨테이너와 button은 Frame, h1~h6 / p / span / label / strong / small 등은 Text. 배경·padding·border가 있는 Text는 Frame 안에 Text를 배치합니다. 컨테이너의 직접 text node도 별도로 생성합니다.
- text / search / email / url / tel / number input과 textarea는 현재 DOM value → placeholder → 빈 control 순으로 처리합니다. select는 현재 선택된 option의 표시 이름을 사용합니다. Control Frame의 측정 크기·border·padding을 유지하고 내부에 편집 가능한 Text를 배치하며, placeholder 색상·opacity와 textarea 줄바꿈을 반영합니다. label / span 안의 중첩 control도 유지합니다. checkbox / radio / button의 변환 경로는 유지합니다.
- Flex row / column → 가로 / 세로 Auto Layout. reverse 방향과 CSS order를 반영합니다.
- `gap`, 네 방향 padding, justify start / center / end / space-between, align start / center / end 및 cross-axis stretch.
- Typed OM으로 `auto` / `%` / px를 구분하고 측정 치수, 부모의 Flex 흐름, grow / shrink / basis와 min/max로 Fixed / Fill / Hug를 결정합니다. `flex:1`과 `width:100%`는 Auto Layout 부모에서 Fill을 사용합니다. 부모 Hug와 자식 Fill이 순환하면 부모의 측정 치수를 고정하고 경고합니다. min/max는 지원되는 Auto Layout 노드에 적용하며 그 밖에는 측정 크기와 경고를 유지합니다.
- 기본 Grid `repeat(2,1fr)` / `repeat(3,1fr)` / `1fr 1fr` / `200px 1fr`는 세로 Auto Layout → 가로 Row → Cell 구조로 변환합니다. `fr` Cell은 Fill, px Cell은 Fixed이며 row-gap / column-gap을 분리합니다. 마지막 행의 빈 Cell은 열 폭을 유지합니다.
- 양수 Flex 자식 margin은 투명 padding wrapper로 표현합니다. 비 Flex 요소는 브라우저가 측정한 좌표를 유지합니다.
- Absolute / fixed 요소는 Auto Layout 흐름에서 분리하고 부모 기준 상대 좌표를 유지합니다. top / right / bottom / left의 선언 방향에 따라 MIN / MAX / STRETCH constraints를 적용합니다. z-index는 흐름 위치를 유지할 수 있는 범위에서 레이어 순서로 반영합니다.
- hex / rgb(a) / hsl(a) / transparent 색상, 네 방향 border 폭, 네 모서리 radius, 요소별 opacity, overflow hidden / auto / scroll clipping. 부모·자식 opacity는 각각 유지하며 곱한 값을 중복 적용하지 않습니다.
- 첫 번째 box-shadow를 Drop / Inner Shadow로 변환하며 다중 shadow는 경고합니다.
- font family / size / weight / italic / line-height / letter-spacing / text-align / text-transform / underline / strikethrough / white-space. 줄바꿈 Text는 측정된 폭 또는 Fill 폭을 사용하고 높이는 자동 결정합니다. nowrap / pre는 줄바꿈을 강제하지 않습니다.
- 사용 가능한 폰트를 조회하고 **로드를 완료한 뒤** 텍스트를 설정합니다. 한국어는 요청한 한국어 지원 폰트 → Pretendard → Noto Sans KR → 알려진 한국어 지원 폰트 순서로 대체하며 영문 전용 fallback을 사용하지 않습니다. 폰트 교체와 로드 실패를 보고하고 로드 결과를 캐시합니다.
- `img`는 편집 가능한 Rectangle + Image Fill. HTTPS CORS 이미지와 `data:image`를 PNG bytes로 전달합니다. `contain`은 FIT, 나머지는 FILL로 근사합니다. 동일 URL의 이미지 데이터는 재사용합니다.
- `background-image:url(...)`은 해당 Frame의 Image Fill로 변환합니다. gradient와 섞인 다중 배경에서도 첫 번째 URL 이미지와 해당 레이어의 size / position / repeat을 유지하며 미지원 gradient는 경고합니다. cover / contain / center / no-repeat을 우선 지원하며 `img`와 같은 URL은 로딩·Figma Image hash를 재사용합니다.
- Inline `<svg>`는 computed fill / stroke 등 스타일을 반영한 SVG를 `figma.createNodeFromSvg`로 전달하여 Vector를 유지합니다. 실패하면 placeholder Frame과 경고를 만들고 다른 요소를 계속 처리합니다.
- CSS Variable은 최종 computed 값을 스타일에 적용하고 이름·값·scope를 JSON에 보관합니다. 실제 Figma Variable 생성은 후속 확장을 위한 범위입니다.
- display:none / visibility:hidden 요소는 기본적으로 생략합니다. 복잡한 Grid와 줄바꿈 Flexbox는 경고와 함께 측정된 고정 좌표로 보존합니다.
- 개별 노드·폰트·이미지 실패는 Warning과 함께 계속 처리합니다. 폰트가 하나도 로드되지 않으면 Text 대신 placeholder를 만들고 명시합니다. 취소된 Figma 변환의 부분 Frame은 제거합니다.

## 미지원 범위와 Known Issues

- JavaScript 실행 결과, interactive state, animation / transition, Shadow DOM / Web Components, canvas / video / iframe, complex transform / float / pseudo-element는 재현하지 않습니다. 일부는 경고와 빈 Frame으로 대체되거나 생략됩니다.
- Grid span / 명시적 배치 / dense / 복잡한 track 함수와 `flex-wrap`은 editable fixed layout으로 보존합니다. 기본 Grid의 모든 Cell은 측정된 행 높이를 사용하므로 후속 편집 때 CSS의 자동 행 높이와 차이가 날 수 있습니다.
- 여러 inline 글꼴·스타일은 부모의 Text 스타일로 통합합니다. 가상 리스트, 스크립트로 생성되는 DOM, form control의 내부 브라우저 렌더링은 완전히 재현하지 않습니다.
- gradient / 여러 background-image / 반복 배경 / center 이외 배경 위치, list marker, writing-mode / RTL, space-around / evenly, baseline, 개별 align-self 정렬, 음수 margin, 서로 다른 border 색상은 생략하거나 단순화합니다. Figma API가 지원하지 않는 Frame shadow spread는 blur·offset을 유지하고 경고합니다.
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

전체 41개 테스트와 TypeScript 검사·빌드가 통과했습니다. `test-results/mvp-intermediate.json`, `test-results/phase2-intermediate.json`, `test-results/ui.png`, `test-results/phase2-ui.png`는 현재 실행의 검증 산출물이며 Git에서 제외됩니다. Figma API 모의 환경은 실제 layout engine·font metrics·SVG importer를 구현하지 않으므로 최종 시각적 비교는 Figma 데스크톱 앱에서 제공한 테스트 HTML로 확인해야 합니다.
