# 실제 09-01 원본의 Nested Hug 후속 조사

첨부한 `09-01_A-pc-list.html`을 수정하지 않고 `test/actual/09-01_A-pc-list.html`에 보관했습니다. SHA-256은 `d0ed7452148a49938b0dd003d790f997725c13fe19939a0a94acffff71f013ff`입니다. 이전의 간단한 재현 파일과 구분합니다.

**실제 Figma 편집에서 문제가 해결됐다고 아직 확인하지 못했습니다.** 이 환경에서는 Chromium과 Figma API 모의 환경을 실행할 수 있지만 Figma Canvas의 실제 편집 엔진을 실행할 수 없습니다. 원본의 기본 모의 실행에서는 이전 엔진 `c682e41`도 Section 높이 전파를 통과했습니다. 따라서 아래에서 확인한 API 실패 경로가 사용자의 실제 실행에서 발생한 원인이라고 단정하지 않습니다.

## 원본 DOM에서 확인한 조건

- Root: `display:flex; flex-direction:column; min-height:4463px; box-sizing:border-box`.
- Tax Section: Root의 세 번째 자식. `display:block`, `flex:none`, `padding:96px 40px`, 위쪽 border 1px. `height:auto`이며 content-box입니다.
- Tax Inner: `max-width:1280px; margin:0 auto; display:flex; flex-direction:column; gap:52px`.
- Card List: Inner의 두 번째 자식. `display:flex; flex-wrap:wrap; gap:20px`, 카드 6개.
- Card: `flex:1 1 360px; min-height:340px`, Vertical Flex. CTA에 `margin-top:auto`가 있어 기존 margin wrapper가 생성됩니다.
- Next Section: Root의 네 번째 자식. 일반 flow의 `flex:none` block이며 `position:absolute`가 아닙니다.
- Footer: Root의 마지막 자식이며 **`flex:1`**입니다. 이전 단순 재현 파일에 없던 조건입니다.

원본은 ID/class가 거의 없습니다. `section` 또는 `div`만으로 찾으면 다른 Node를 진단할 수 있으므로 실제 생성 계층의 자식 경로와 Node ID로 구분합니다.

## 높이 결정과 fallback

현재 parser의 원본 결과에서 Tax Section은 `NONE`으로 fallback되지 않습니다. 기본 왼쪽 정렬 검사에서는 Inner의 auto margin 때문에 제외되지만 `measuredBlockFlow`가 중앙 정렬, 고정된 Inner 폭, leading/trailing padding과 실제 높이를 검증합니다. 원본의 max-width와 margin은 이 경로에서 안전하게 처리됩니다. Tax Inner는 기존 Vertical Auto Layout이며, Card List는 실제 3×2 행이 검증된 Horizontal Wrap입니다. 세 곳 모두 Height Hug를 요청합니다.

Root는 Height Hug를 요청하지만 **Footer Height Fill** 때문에 기존 converter의 `SIZING_CYCLE`에서 Fixed로 선택됩니다. 이는 Root 전체 높이 증가를 제한하는 실제 정책입니다. 그러나 Fixed인 Root도 Vertical Auto Layout이며, 정상 flow의 Hug Section이 커지면 다음 Section을 이동시킬 수 있습니다. 따라서 Root Fixed만으로 Tax/Next 겹침의 원인을 설명할 수 없습니다. Footer의 Fill/Root 순환 처리 정책은 이번에 변경하지 않았습니다.

다음은 **원본을 파싱해 생성한 API 모의 Node의 최종 readback**입니다. Figma에서 읽은 값이 아닙니다. Y는 각 부모 기준이며 Root Y는 Canvas 중심 배치로 계산됩니다. 외부 Google Fonts 요청을 차단한 결정적인 대체 폰트 환경을 사용했습니다. 사용자가 확인한 `1066.27`과 아래 `1078.27`의 차이는 실제 IBM Plex 또는 Figma font metrics를 검증하지 않았기 때문에 동일하다고 주장하지 않습니다.

```yaml
Root:
  path: Root
  layoutMode: VERTICAL
  heightMode: FIXED
  height: 4463
  minHeight: 4463
  reason: Footer Fill에 대한 기존 Hug/Fill 순환 fallback

Tax Section:
  path: Root / 2
  layoutMode: VERTICAL
  heightMode: HUG
  primaryAxisSizingMode: AUTO
  height: 1078.265625
  y: 729
  reason: 실제 block 중앙 정렬과 padding을 검증한 normal flow

Tax Inner:
  path: Root / 2 / 0
  layoutMode: VERTICAL
  heightMode: HUG
  primaryAxisSizingMode: AUTO
  height: 885.265625
  y: 97
  reason: 기존 intrinsic Vertical Flex 콘텐츠

Card List:
  path: Root / 2 / 0 / 1
  layoutMode: HORIZONTAL
  layoutWrap: WRAP
  heightMode: HUG
  counterAxisSizingMode: AUTO
  height: 713
  y: 172.265625
  reason: 원본 행 배치와 일치하는 content-driven Wrap

Next Section:
  path: Root / 3
  parent: Root
  positioning: AUTO
  layoutMode: VERTICAL
  heightMode: HUG
  height: 1372.75
  y: 1807.265625
  reason: 검증된 normal flow, Root의 정상 Auto Layout 자식

Footer:
  path: Root / 6
  layoutMode: NONE
  heightMode: FILL
  height: 330.859375
  reason: 원본 flex-grow 유지
```

## 수정한 높이 적용 경로

기존 `applySizing()`은 Horizontal/Vertical setter를 하나의 try에 넣었습니다. Horizontal setter가 오류를 내면 Vertical setter를 실행하지 않아, 정상적인 Hug 요청도 초기 Fixed로 남았습니다. 각 축을 독립 처리해 높이 설정이 폭 설정 오류에 막히지 않게 했습니다. 폭 선택 정책은 기존대로 유지합니다.

모든 constraints와 Root viewport resize/reparenting이 끝난 뒤 실제 Height Mode를 다시 읽습니다. **기존 parser가 안전한 Hug로 승인했고 converter의 Fill-cycle fallback에도 해당하지 않은 Frame만** 아래에서 위로 복원합니다. shorthand를 적용할 수 없으면 공식 API의 `primaryAxisSizingMode`/`counterAxisSizingMode`와 높이에 해당하는 grow/align 속성을 사용합니다. 둘 다 실패하면 최종 Fixed 값과 Node ID를 `HEIGHT_LAYOUT`에 기록합니다. 명시적 Fixed/Fill, 복잡한 measured Frame, Root/Footer 순환 fallback은 강제로 Hug로 바꾸지 않습니다.

블록 fallback 조건도 구체적인 이유를 기록하도록 보강했습니다. 정렬/Width Mode 불일치, 이동한 자식, leading offset, 비균일·겹치는 gap, 판별 불가능한 trailing margin/min-max, content-box min-max와 padding 중 어떤 조건에서 제외됐는지 `heightSource.reason`에서 확인할 수 있습니다. 판정 알고리즘은 변경하지 않았습니다.

Debug Mode에서 다음이 최종 Node 값으로 기록됩니다.

- Conversion Report `HEIGHT_SIZING`: 고유 경로, 실제 ID, layoutMode, Height Mode, 높이, 부모 기준 Y, 판단/fallback 이유.
- Plugin Console `HTML → Figma final height hierarchy`: 실제 부모 ID, Native axis sizing, requested/final mode를 포함한 전체 Frame 배열.
- 각 Frame의 `html-height-sizing` plugin data와 report의 `heightHierarchy`.
- Root의 `html-height-hierarchy`: 작은 문서는 배열, 큰 문서는 `keys`에 지정된 JSON 조각 목록. API의 100 kB 저장 제한에 맞춰 분할합니다. Debug 저장 실패로 생성한 문서를 삭제하지 않습니다.

기존 Wrapper 제거, Width Sizing, Rich Text, Layer Naming 모듈을 변경하지 않았습니다. 기본 모의 실행에서 원본의 291개 생성 Node의 이름·폭·계층·기존 wrapper·높이·Y·Paint·Text·Range·SVG 결과를 이전 엔진과 비교해 동일함을 확인했습니다.

## 자동 테스트에서 확인한 결과

원본 DOM 자체를 Chromium에서 편집한 결과, 7번째 카드를 추가하면 다음 Section이 **360px** 내려가고 삭제 시 복귀합니다. 긴 설명을 실제 DOM에 넣으면 Tax Section과 다음 Section이 함께 이동합니다.

기존 Width 정책으로 생성한 **API 박스 모의 환경**에서는 첫 Card를 복제할 때 폭 413.33px와 높이 353px를 유지합니다. 따라서 추가 행은 353 + gap 20 = **373px**입니다. CSS 원본의 새 마지막 행 카드는 flex-grow로 폭이 늘어날 수 있으므로 두 값을 동일하다고 보고하지 않습니다.

| 항목 | 6개 | 7개 | 삭제 후 6개 |
| --- | ---: | ---: | ---: |
| Card List Height | 713 | 1086 | 713 |
| Tax Inner Height | 885.27 | 1258.27 | 885.27 |
| Tax Section Height | 1078.27 | 1451.27 | 1078.27 |
| Next Section Y | 1807.27 | 2180.27 | 1807.27 |

Text 박스 높이를 240px 늘리는 모의 편집에서도 Card/Wrap/Inner/Section 높이와 Next Y가 증가했습니다. 이 테스트는 실제 Figma에서 문자를 수정해 font metrics를 계산한 결과가 아닙니다.

추가로 **의도적으로 실패를 주입한 테스트**에서 다음을 확인했습니다.

1. 원본 Tax Section의 Horizontal setter 거부: 이전 엔진은 Height Fixed, 수정 엔진은 Height Hug.
2. 최종 viewport 처리에서 Tax Section의 Height Mode reset: 이전 엔진은 List만 커지고 Next Y는 유지돼 겹침 경로를 재현. 수정 엔진은 승인된 Hug를 복원해 Next 이동.
3. Height shorthand 거부: native axis API로 Hug 복원, Width Fill 유지.
4. 두 Height API 모두 거부: Node/descendants 유지, 최종 Fixed 및 정확한 실패 이유 표시.

이 실패 주입 결과는 사용자의 실제 Figma에서 같은 API 오류/reset이 발생했다는 증거가 아닙니다.

전체 **126개 중 125개 통과, 실패 0, 조건부 비교 skip 1**입니다. 원본 테스트 9개, 기존 Height `4200294` 비교, Nested `d56ef4a` 비교와 실제 원본 `c682e41` 비교를 실행했습니다. Skip은 이전 Rich Text 단계의 별도 baseline 비교이며 현재 Rich Text 테스트는 실행했습니다. TypeScript 검사와 빌드도 통과했습니다.

원본 테스트는 `tests/actual-nested-hug.test.mjs`, 상세 산출물은 `test-results/actual-nested-hug.json`입니다. 이전 엔진 비교에는 `ACTUAL_HUG_BASELINE_SRC`를 `git archive c682e41 src`로 추출한 경로로 지정합니다.

```sh
npm run typecheck
npm run build
HEIGHT_BASELINE_SRC=/tmp/yesrim-height-baseline/src \
NESTED_BASELINE_SRC=/tmp/yesrim-nested-baseline/src \
ACTUAL_HUG_BASELINE_SRC=/tmp/yesrim-actual-hug-baseline/src \
node --test --test-concurrency=2 tests/*.test.mjs
```

## 실제 Figma에서 남은 확인

1. 최신 ZIP을 다른 폴더에 풀고 해당 `manifest.json`을 개발 플러그인으로 연결하거나 Reload합니다. 이전 dist/manifest와 혼용하지 않습니다.
2. Auto Layout와 Debug Mode를 켜고 **첨부한 원본**을 Desktop 1440×900에서 변환합니다.
3. `HEIGHT_SIZING`에서 `Root / 2`, `Root / 2 / 0`, `Root / 2 / 0 / 1`의 최종 Hug와 Native AUTO를 확인합니다. `Root / 3`은 Root의 Auto child여야 합니다.
4. 카드 하나를 복제하고 삭제하며 다음 Section 이동/복귀를 확인합니다. 실제 Figma font metrics에 따라 이동량은 모의 수치와 다를 수 있습니다.
5. 카드 설명 Text를 여러 줄로 늘려 Card/Wrap/Tax 확장과 다음 Section의 겹침 방지를 확인합니다.
6. 겹침이 남으면 Plugin Console의 `HTML → Figma final height hierarchy`, `SIZING_API`/`HEIGHT_LAYOUT` Warning과 편집 후 해당 Frame 속성을 비교합니다. 이 값으로 실제 Fixed/NONE 차단 Node 또는 Hug 상태에서의 native Wrap 동작을 구분합니다.

Root/Footer 전체 문서 성장과 Fill 재분배도 실제 엔진에서 확인이 필요합니다. 기존 정책으로 Root가 Fixed인 점은 이번 결과의 제한 사항이며, Tax/Next의 겹침이 해결됐다는 실제 Figma 확인과 구분해서 남깁니다.
