# HTML → Editable Figma

HTML 파일을 업로드하여 **편집 가능한 Frame / Text / Image Fill / Auto Layout**으로 가져오는 Figma 플러그인 MVP입니다. 화면 전체를 이미지나 SVG로 flatten하지 않습니다. 런타임 외부 라이브러리나 백엔드는 없습니다.

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

1. 위 설치·빌드를 실행하고 프로젝트 폴더를 로컬 컴퓨터에 준비합니다. 클라우드에서 작업했다면 소스와 빌드 결과를 내려받으세요.
2. Figma 디자인 파일을 엽니다. **Plugins → Development → Import plugin from manifest…**에서 프로젝트 루트의 `manifest.json`을 선택합니다. 메뉴 위치는 Figma 버전에 따라 다를 수 있습니다.
3. 개발 플러그인 목록에서 **HTML → Editable Figma**를 실행합니다.
4. Figma에서 발급한 플러그인 ID가 필요한 경우, **New plugin**으로 로컬 플러그인을 등록하고 `manifest.json`의 `id`를 발급된 ID로 바꾸세요. 포함된 ID는 로컬 개발용 식별자이며 게시된 플러그인 ID가 아닙니다.

## HTML 테스트

1. `examples/mvp.html`을 업로드합니다. 요청에 포함된 원본 성공 조건 예제를 그대로 제공했습니다.
2. Desktop 1440, Auto Layout 적용, CSS 스타일 적용을 선택합니다.
3. **Figma로 변환**을 클릭합니다.
4. 현재 viewport 중앙에 생성된 **Imported HTML**을 확인합니다. 자동 선택 및 화면 맞춤이 적용됩니다.
5. Layers에서 `header → nav`, `hero → button`, `card-list → card` 구조를 펼칩니다. Text 내용, Auto Layout 방향·gap·padding, 카드 배경·border·radius를 직접 편집해 보세요. 텍스트의 기본 CSS margin을 표현하기 위해 일부 `/ margin` Frame이 추가됩니다.
6. UI에서 실제 생성된 노드·Auto Layout·Text·Image 수와 Warning을 확인합니다. **JSON 저장**은 변환에 사용한 중간 데이터를 저장합니다. 플러그인 UI 콘솔에도 동일한 데이터가 출력됩니다.

Viewport 너비와 높이를 **1~10,000px의 정수**로 직접 입력할 수 있습니다. 기본값은 1440 × 900px입니다. 기존 Desktop 1440 / Desktop 1280 / Tablet 768 / Mobile 375 프리셋도 사용할 수 있으며, 프리셋을 선택하면 높이는 900px로 설정됩니다. 값을 수정하면 직접 입력 모드로 전환됩니다.

입력한 너비·높이에서 실제 HTML을 렌더링하므로 CSS media query와 `vw` / `vh`가 반영됩니다. 생성되는 최상위 Frame의 너비는 입력값으로 고정하고, **Frame 높이는 콘텐츠에 따라 자동 결정**합니다. 입력한 높이는 HTML을 측정할 때의 viewport 높이입니다. 빈 값, 0, 음수, 소수, 범위 초과는 변환 전에 차단합니다.

원본 예제의 `.page { width:1440px; padding:40px }`는 기본 `content-box`이므로 브라우저에서 실제 폭이 1520px입니다. 플러그인은 요청한 최상위 폭 1440px을 사용하고 overflow Warning을 보여줍니다. 입력 HTML에 `* { box-sizing:border-box }`를 적용하면 이 차이를 줄일 수 있습니다.

## 구현 구조

```text
manifest.json          Figma 설정
scripts/build.mjs      플러그인 main / UI 단일 파일 번들
src/code.ts            메시지 처리, 진행 상태, 오류·취소
src/ui.html            파일 업로드, viewport, 옵션, 결과 UI
src/ui.ts              FileReader, UI ↔ main 통신, JSON 다운로드
src/parser.ts          DOMParser, sandbox 렌더링, computed CSS → JSON
src/types.ts           중간 문서·노드·스타일·통신 타입
src/converter.ts       JSON → Figma 노드, 폰트·이미지·Auto Layout
src/utils.ts           색상·숫자·여백·timeout 처리
examples/mvp.html      요청의 MVP 테스트 HTML
tests/                 Chromium 파싱·UI 및 Figma API 모의 테스트
```

HTML → scripts-disabled iframe → DOM / computed styles / bounds → `ParsedDocument` → UI 메시지 → Figma API 순서입니다. DOM 분석 코드는 Figma main에서 실행하지 않으며, Figma 노드 생성 코드는 UI에서 실행하지 않습니다. `ParsedDocument.version`은 `1`입니다.

## 지원 범위

- `.html` / `.htm` 클릭 업로드와 Drag & Drop, 최대 5MB.
- DOM 계층과 id → class → tag 우선순위 레이어 이름. 장식 없는 단일 body wrapper는 최상위 Imported HTML로 통합합니다.
- 일반 컨테이너와 button은 Frame, h1~h6 / p / span / label / strong / small 등은 Text. 배경·padding·border가 있는 Text는 Frame 안에 Text를 배치합니다. 컨테이너의 직접 text node도 별도로 생성합니다.
- Flex row / column → 가로 / 세로 Auto Layout. reverse 방향과 CSS order를 반영합니다.
- `gap`, 네 방향 padding, justify start / center / end / space-between, align start / center / end 및 cross-axis stretch.
- Typed OM으로 `auto` / `%` / px를 구분하고 측정 치수와 부모의 Flex 흐름으로 Fixed / Fill / Hug를 결정합니다. Fill은 Auto Layout 부모에서만 사용합니다. 부모 Hug와 자식 Fill이 순환하면 부모의 측정 치수를 고정하고 경고합니다.
- 양수 Flex 자식 margin은 투명 padding wrapper로 표현합니다. 비 Flex 요소는 브라우저가 측정한 좌표를 유지합니다.
- Absolute / fixed 요소는 Auto Layout 흐름에서 분리하고 상대 좌표를 유지합니다. relative 요소는 일반 흐름으로 취급합니다.
- 배경색, 텍스트 색, 네 방향 border 폭, corner radius, opacity, overflow clipping.
- font family / size / weight / italic / line-height / letter-spacing / text-align / underline / strikethrough. 사용 가능한 폰트를 조회하고 **로드를 완료한 뒤** 텍스트를 설정합니다. 요청 폰트 → Pretendard → Inter → Arial → Roboto → 기타 사용 가능한 폰트 순서로 대체합니다.
- `img`는 편집 가능한 Rectangle + Image Fill. HTTPS CORS 이미지와 `data:image`를 PNG bytes로 전달합니다. `contain`은 FIT, 나머지는 FILL로 근사합니다. 동일 URL의 이미지 데이터는 재사용합니다.
- Grid와 줄바꿈 Flexbox는 독립 함수/경고를 통해 고정 좌표 Frame으로 보존합니다.
- 개별 노드·폰트·이미지 실패는 Warning과 함께 계속 처리합니다. 폰트가 하나도 로드되지 않으면 Text 대신 placeholder를 만들고 명시합니다. 취소된 Figma 변환의 부분 Frame은 제거합니다.

## 미지원 범위와 Known Issues

- JavaScript 실행 결과, interactive state, animation / transition, Shadow DOM / Web Components, canvas / video / iframe, complex transform / float / pseudo-element는 재현하지 않습니다. 일부는 경고와 빈 Frame으로 대체되거나 생략됩니다.
- Grid와 `flex-wrap`은 editable fixed layout으로 보존하며 반응형 Auto Layout으로 재구성하지 않습니다.
- 여러 inline 글꼴·스타일은 부모의 Text 스타일로 통합합니다. 가상 리스트, 스크립트로 생성되는 DOM, form control의 내부 브라우저 렌더링은 완전히 재현하지 않습니다.
- box-shadow, gradient / background-image, z-index, list marker, 복잡한 min/max sizing, writing-mode / RTL, space-around / evenly, baseline, 개별 align-self 정렬, 음수 margin, nonuniform border 색상 등은 생략하거나 단순화합니다.
- HTML 파일만으로 상대 경로 CSS·이미지나 로컬 폰트 파일을 읽을 수 없습니다. 인라인 CSS, HTTPS URL 또는 이미지 data URI를 사용하세요. HTTP와 기타 URL scheme은 외부 리소스로 허용하지 않습니다.
- 원격 CSS·웹 폰트·이미지는 Figma 네트워크 정책, CORS, 로그인 여부에 따라 실패할 수 있습니다. 이미지 실패 시 placeholder, 스타일 실패 시 현재 렌더링된 스타일을 사용하고 경고합니다. 외부 리소스는 요청한 호스트로만 로딩하며 업로드 HTML/JSON을 서버에 전송하지 않습니다. manifest의 wildcard 네트워크 권한은 임의 호스트의 입력 리소스를 지원하기 위한 것입니다.
- 브라우저 웹 폰트와 Figma에서 실제 로드되는 폰트의 metrics가 다르면 줄바꿈과 최종 높이가 달라질 수 있습니다. Figma 노드 치수는 브라우저 측정값을 시작점으로 사용합니다.
- `object-fit:fill`의 비율 왜곡은 FILL로 근사하며 경고합니다. IMG가 아닌 inline SVG는 이 MVP에서 편집 가능한 벡터로 변환하지 않습니다.
- 노드 최대 3,000개, 깊이 최대 80, 이미지당 PNG 4MB / 총 16MB / 이미지당 16MP 제한을 적용합니다. 생략 및 제한 초과는 경고/오류로 표시됩니다.
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

테스트는 실제 Chromium에서 MVP 예제·viewport·업로드 UI·스크립트 차단·computed CSS·이미지 bytes를 확인하고, Figma API 모의 환경에서 Auto Layout 속성·편집 가능한 Text·폰트 로딩 순서·실패 복구·main 통신·취소를 검사합니다. `test-results/mvp-intermediate.json`과 `test-results/ui.png`는 현재 실행의 검증 산출물이며 Git에서 제외됩니다. 실제 Figma import나 게시를 자동으로 수행하지 않습니다.
