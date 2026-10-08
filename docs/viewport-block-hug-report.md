# Tax Section의 NONE / Fixed 후속 수정

사용자가 실제 Figma에서 확인한 `Flow None / Width 1920 Fill / Height 1066.27 Fixed`를 기준으로 원본 `test/actual/09-01_A-pc-list.html`을 재검증했습니다. 원본 파일은 변경하지 않았습니다.

## 재현한 원인

원본을 1920×900으로 렌더링하고 브라우저의 scrollbar 공간을 15px 예약하면 DOM의 Root/Tax Section 폭은 1905px가 됩니다. 내부 max-width 1280px Container는 정상적으로 중앙 정렬됩니다. Figma Root의 폭은 기존 정책에 따라 선택한 viewport 1920px로 설정되고, Tax Section은 Root의 Width Fill 자식이므로 최종 폭도 1920px입니다.

이때 `measuredBlockFlow()`는 **통과합니다**. 기본 왼쪽 정렬 검사에서는 auto margin 때문에 제외되지만, 후속 측정 검사가 고정 1280px 자식의 중앙 정렬, Section padding, border와 실제 세로 높이를 검증해 Vertical/Hug를 선택합니다.

이를 되돌린 곳은 parser 마지막 단계의 `preserveWrappedViewportGeometry()`입니다. 기존 조건은 다음과 같습니다.

```ts
node.layout.normalFlow &&
node.layout.normalFlow.align !== 'MIN' &&
!close(projectedWidth, node.rect.width)
```

`CENTER`, 실제 폭 1905px, 최종 Fill 폭 1920px이므로 조건에 들어갑니다. 이 함수가 `normalFlow`를 삭제하고 `layout.direction = 'NONE'`, `heightMode = 'FIXED'`를 지정합니다. 이유는 `Viewport width changes block alignment; measured geometry retained`입니다. DOM의 절대 X를 유지하려는 보호 로직이 정상 세로 흐름의 높이 전파까지 끊었습니다.

따라서 converter의 생성 마지막 단계에서 정상 Auto Layout이 덮인 경우가 아닙니다. converter에 전달되는 JSON에서 이미 NONE/Fixed이며, `configureLayout()`은 그 값을 그대로 적용합니다. 앞선 최종 Hug 복원은 parser가 안전한 Hug로 승인한 Frame에 한정되므로 이 Frame을 복원하지 못했습니다.

같은 이전 엔진 `e3556dc`를 원본 1920px/15px gutter로 실행하면 Tax Section은 **NONE/Fixed/1920 Fill**, Inner는 **Vertical/Hug/1280**, Card List는 **Wrap/Hug**입니다. 카드 복제 시 List만 커지고 Next Y는 그대로인 오류 경로를 재현했습니다. 앞선 1440px 검증에서는 scrollbar 공간이 예약되지 않아 DOM 폭과 최종 폭이 같았으므로 이 경로를 발견하지 못했습니다.

사용자 환경의 실제 scrollbar 측정값은 아직 받지 않았습니다. 위 원인은 원본 브라우저 재현과 이전 엔진 비교에서 확인한 경로이며, 실제 Figma 환경의 진단 결과와 구분합니다.

## 좁힌 수정 조건

parser가 실제 viewport/client 폭을 읽고, Chromium의 stable gutter가 clientWidth 대신 html rect에 반영되는 경우도 처리합니다. 작성자가 지정한 html/root 폭이나 max-width를 scrollbar 차이로 분류하지 않습니다.

다음 조건이 모두 맞는 경우에만 기존 Vertical/Hug를 유지합니다.

- Root는 width:auto이며 실제 폭 차이가 측정한 scrollbar gutter와 일치합니다.
- 이미 `measuredBlockFlow()`가 승인한 CENTER 흐름입니다.
- 해당 Frame은 auto width / Width Fill이고, 그 폭 차이도 같은 gutter와 일치합니다.
- 일반 flow 자식은 기존 Fixed Width이며 새 콘텐츠 영역에 모두 들어갑니다.

명시적 Root 1440px을 1920px로 가져오는 실제 CSS 폭 충돌은 여전히 NONE/Fixed fallback입니다. MAX 정렬, 판정에 실패한 복잡한 Block, Inline 혼합, Width Hug, Absolute/Fixed를 새 Auto Layout으로 바꾸지 않습니다. Wrap의 행 변경 검사와 기존 Root/Footer Fill 순환 정책도 유지합니다.

production 변경은 `src/parser.ts`의 gutter 측정/전달과 `src/height-sizing.ts`의 이 예외 처리입니다. converter, Width Sizing, Wrapper optimizer, Layer Naming, Rich Text, SVG/Donut, Grid, Form, Gradient/Background 모듈은 변경하지 않았습니다.

## 최종 생성 속성

아래는 **원본 HTML을 파싱하고 converter로 생성한 Figma API 모의 Node의 최종 속성 readback**입니다. 실제 Figma Canvas에서 측정한 결과가 아닙니다.

| Node | 변경 전 | 변경 후 | Width |
| --- | --- | --- | --- |
| Root | Vertical / Fixed | 동일 | 1920 Fixed |
| Tax Section | NONE / Fixed | **Vertical / Hug** | **1920 Fill** |
| Tax Inner | Vertical / Hug | 동일 | **1280 Fixed / maxWidth 1280** |
| Card List | Horizontal Wrap / Hug | 동일 | 1280 Fill |
| Next Section | Root의 Auto child / NONE / Fixed | Root의 Auto child / Vertical / Hug | 1920 Fill |

Tax Section의 native `primaryAxisSizingMode`는 `AUTO`, `counterAxisSizingMode`는 `FIXED`, `counterAxisAlignItems`는 `CENTER`입니다. Padding top/right/bottom/left는 **96/40/96/40**, 위쪽 border는 1px입니다. Inner의 간격은 **52px**, Card List gap은 **20px**이며 6개 카드의 3열×2행과 기존 각 카드 폭을 유지합니다. 기존 margin wrapper 및 총 291개 Node 계층도 유지합니다.

1905px DOM의 Inner X는 312.5px입니다. scrollbar가 없는 1920px Frame에서는 `(1920 - 1280) / 2 = 320px`로 중앙 정렬합니다. 이 7.5px 보정은 원본 padding을 바꾸지 않고 선택한 폭과 CSS 중앙 정렬을 동시에 유지하기 위한 차이입니다. 초기 Y와 세로 간격은 유지합니다.

## 편집 자동 검증

API 박스 모의 환경에서 원본의 첫 Card를 복제하고 삭제했습니다. 첫 Card 높이 353px + gap 20px이므로 새 행의 높이 증분은 373px입니다. Source font와 실제 Figma font metrics를 실행한 값은 아니므로 수치를 실제 Figma 결과로 보고하지 않습니다.

| 값 | 카드 6개 | 카드 7개 | 삭제 후 6개 |
| --- | ---: | ---: | ---: |
| Card List Height | 713 | 1086 | 713 |
| Tax Inner Height | 885.27 | 1258.27 | 885.27 |
| Tax Section Height | 1078.27 | 1451.27 | 1078.27 |
| Next Section Y | 1807.27 | 2180.27 | 1807.27 |

이전 엔진에서는 복제 후에도 Tax Height 1078.27, Next Y 1807.27로 유지됩니다. 수정 엔진은 Section 높이와 Next Y가 함께 증가하고 삭제하면 원래 값으로 복귀합니다. Text 박스 높이를 240px 늘리는 모의 편집도 Card/List/Inner/Section과 Next에 전파됩니다.

별도로 **실제 원본 DOM**의 카드 설명을 긴 문장으로 변경한 Chromium 검증에서는 Tax Height가 1966.27로 늘고 Next Y가 2695.27로 이동합니다. 해당 DOM을 다시 변환한 API Node도 같은 높이와 Y를 갖습니다. Google Fonts를 차단한 결정적 대체 폰트 환경이며 사용자가 확인한 실제 1066.27px 또는 Figma 편집 font metrics와 동일하다고 주장하지 않습니다.

기존 엔진과 원본 1920px/gutter의 모든 Node 이름·폭·Width Mode·Wrapper·Text·Range·Paint·Typography를 비교했습니다. 변경 대상으로 제외한 값은 승인된 normal flow의 Layout/Height Mode와 scrollbar 제거에 따른 중앙 X입니다. 기존 1440px 원본 출력 비교와 보호된 모듈의 바이트 비교도 유지합니다.

전체 **129개 중 128개 통과, 실패 0개, 조건부 skip 1개**입니다. 실제 원본 테스트 12개를 모두 실행했고 TypeScript 검사와 빌드도 통과했습니다. Skip은 별도의 이전 Rich Text baseline 비교이며 현재 Rich Text 회귀 테스트는 실행했습니다.

상세 계층 및 전후/복제/삭제/Text 데이터는 `test-results/actual-nested-hug.json`의 `viewportGutter`, `viewportTextGrowth`에 있습니다. 이전 엔진 비교는 `VIEWPORT_BLOCK_BASELINE_SRC`를 `git archive e3556dc src`로 추출한 경로에 지정합니다.

```sh
npm run typecheck
npm run build
HEIGHT_BASELINE_SRC=/tmp/yesrim-height-baseline/src \
NESTED_BASELINE_SRC=/tmp/yesrim-nested-baseline/src \
ACTUAL_HUG_BASELINE_SRC=/tmp/yesrim-actual-hug-baseline/src \
VIEWPORT_BLOCK_BASELINE_SRC=/tmp/yesrim-block-width-baseline/src \
node --test --test-concurrency=2 tests/*.test.mjs
```

## 실제 Figma 수동 검증 필요

최신 ZIP의 manifest를 Reload하고 viewport 1920×900, Auto Layout 및 Debug를 켠 상태에서 첨부 원본을 다시 변환하세요. Debug의 `Root / 2`에서 Vertical/Hug/1920, `Root / 2 / 0`에서 Vertical/Hug/1280, `Root / 2 / 0 / 1`에서 Wrap/Hug를 확인합니다. gutter 경로에서는 판단 이유에 `viewport scrollbar gutter 15px removed (1905 → 1920px); centered flow retained`가 표시됩니다.

실제 Figma에서 카드 6→7→6, Text 여러 줄 증가, Section 확장과 Next 이동/겹침 해소는 **수동 확인 필요**입니다. Root/Footer Fill 재분배는 기존 정책을 유지했으므로 별도로 확인해야 합니다. 자동 테스트 통과를 실제 Figma 편집 완료로 간주하지 않습니다.
