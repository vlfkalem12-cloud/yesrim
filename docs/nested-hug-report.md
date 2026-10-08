# Nested Hug / Ancestor Height Propagation 수정 결과

이 문서는 `c682e41` 단계의 재현 파일 검증 기록입니다. 이후 첨부된 실제 `09-01_A-pc-list.html` 조사와 런타임 높이 적용 보강은 [원본 후속 보고서](actual-nested-hug-report.md)를 참조하세요.

원본 `09-01_A-pc-list.html`, `09-02_A-pc-detail.html`, `01-01_Main.html` 파일은 첨부되지 않았습니다. 아래 결과는 요청에 명시된 CSS로 만든 `test/nested-hug-regression.html`과 상세/모바일 재현 사례에 대한 결과입니다. 실제 Figma 편집 검증과 구분합니다.

## 실제로 재현한 원인

수정 전 엔진 `d56ef4a`로 생성한 계층에서 Card List는 이미 Horizontal Auto Layout + Wrap + Hug였습니다. Root도 Vertical Hug + Min Height 4463이었으며, 다음 Section은 Root의 정상 흐름 자식이었습니다. `flex:none`, Root의 `min-height`, 최종 Root resize는 이 재현의 원인이 아니었습니다.

높이 변화가 끊긴 곳은 Card List를 감싸는 block Frame 두 개입니다. 기존 `configureContentHeight()`는 자식 margin이 모두 0이고, 모든 자식의 X가 부모의 콘텐츠 왼쪽에 맞고, 콘텐츠 높이 합계가 부모의 측정 높이와 일치할 때만 Vertical Auto Layout을 허용했습니다. 제목의 bottom margin 32px과 중앙 정렬된 1280px 컨테이너가 이 조건에서 제외됐습니다. 이 Frame들은 `layoutMode: NONE`이므로 `applySizing()`에서 Hug를 적용할 수 없어 측정된 높이에 Fixed로 남았습니다.

Card List가 1060px로 늘어도 Inner 772px와 Section 964px는 그대로였습니다. 따라서 Root가 다음 Section을 옮길 새로운 높이를 받지 못했습니다. 다음 Section에 Absolute나 수동 Y를 적용해서 발생한 문제가 아닙니다.

## 수정 범위

| 파일 / 함수 | 변경 |
| --- | --- |
| `src/height-sizing.ts` / `configureContentHeight`, `measuredBlockFlow` | 실제 bounding rect로 균일한 세로 간격, 양쪽 edge margin, 정렬, 최소/최대 높이를 검증한 block Frame만 Vertical Hug로 변환 |
| `src/height-sizing.ts` / `preserveWrappedViewportGeometry` | 최종 viewport 폭 때문에 새 중앙/오른쪽 정렬이 원본 위치를 바꾸면 측정 좌표로 fallback |
| `src/types.ts` / `ParsedLayout.normalFlow` | 검증한 Auto Layout 간격·padding·정렬을 선택적 메타데이터로 저장. 원본 CSS margin/padding 및 Width Mode 유지 |
| `src/parser.ts` | 위 viewport fallback의 Warning 연결 |
| `src/converter.ts` / `validateDocument`, `configureLayout`, `create`, `applySizing` | 메타데이터 검증·배치 적용, 이미 반영한 margin의 중복 wrapper 생성 방지, Debug 판단 이유 표시 |
| `tests/lifecycle.test.mjs` | 기존 stale reply 테스트가 완료 속도에 좌우되지 않도록 완료 응답 전달을 제어. UI 동작과 기존 assertion 유지 |

기존 Frame 및 wrapper를 제거하지 않았습니다. 새 Row/Container wrapper도 추가하지 않았습니다. 기존 Flex margin wrapper가 있는 사례에서는 그 wrapper를 그대로 유지하면서 높이 전파를 확인했습니다. Width Sizing, Naming, Rich Text, Inline Wrapping, Grid, SVG/Donut, Gradient/Background, Form, Absolute/Fixed 및 wrapper optimizer 모듈은 수정 전과 바이트 단위로 동일합니다.

초기 measured resize → 자식 재귀 생성 → `applySizing()` → 최종 Root viewport resize와 Height Mode 복원 순서는 유지했습니다. 문제는 이 순서의 덮어쓰기가 아니라 중간 block Frame의 Auto Layout 부재였습니다.

## 계층과 Sizing Mode

| 동일한 Node | 변경 전 | 변경 후 |
| --- | --- | --- |
| Root | Vertical / Hug / Min Height 4463 | 동일 |
| Tax Section | NONE / Fixed 964 | Vertical / Hug 964 |
| Tax Inner | NONE / Fixed 772 | Vertical / Hug 772 |
| Card List | Horizontal Wrap / Hug 700 | 동일 |
| Card | Vertical / Hug / Min Height 340 | 동일 |
| Next Section | Root의 Auto child / Vertical Hug / Min Height 300 | 동일 |

재현 파일은 block 조상 두 곳에서 흐름이 끊기는 경우를 포함합니다. Card List가 기존부터 **Width Fill 1280**인 Flex Inner 변형도 별도로 검증했고 Width Fill을 유지했습니다. 명시적 Height를 가진 Frame은 Fixed를 유지합니다.

## 추가·삭제 및 Text 변경 결과

다음 수치는 **최종 Figma API 속성의 독립 Chromium 투영** 결과입니다. 초기·카드 추가·Text 변경은 별도의 브라우저에서 원본 재현 CSS를 편집한 결과와도 비교합니다. 단순 박스 높이 모의 환경에서도 List → Inner → Section → Root 확장·축소를 확인했습니다. 실제 Figma 엔진을 실행한 결과는 아닙니다.

| 항목 | 6개 | 7개 | 복제 카드 삭제 후 6개 |
| --- | ---: | ---: | ---: |
| Wrap 행 수 | 2 | 3 | 2 |
| Card List Height | 700 | 1060 | 700 |
| Tax Inner Height | 772 | 1132 | 772 |
| Tax Section Height | 964 | 1324 | 964 |
| Next Section Y | 4064 | 4424 | 4064 |
| Root Height | 4463 | 4823 | 4463 |

다음 Section은 360px 아래로 이동하며 Section과 겹치지 않습니다. 긴 Text 재현에서는 첫 Card가 340→1076px, List가 700→1436px, Section이 964→1700px로 늘고 다음 Section Y가 4064→4800px로 이동했습니다. 이 값은 테스트 브라우저의 폰트 측정값이며 Figma의 실제 font metrics와 같다고 주장하지 않습니다.

Root 최소 높이를 6000px로 바꾸면 카드 추가 후에도 Root는 6000px를 유지하면서 다음 Section은 이동합니다. 명시적 `height:4463px` Root는 Fixed를 유지하고 내부 정상 흐름 자식들만 다시 배치됩니다. Root를 일괄 Hug로 변경하지 않습니다.

## Min Height 및 기존 정책

현재 `@figma/plugin-typings` 1.117.0은 Auto Layout Frame 및 그 직계 자식의 `minHeight`를 지원합니다. 각 Card에 Hug + `minHeight:340`, Root에 Hug + `minHeight:4463`을 적용한 API 속성과 박스 높이 계산을 검증했습니다. `flex:none`은 grow/shrink 제한이며, height:auto를 Fixed로 바꾸지 않습니다.

API가 constraint 설정을 거부하는 런타임에서는 기존 `SIZE_CONSTRAINT` Warning을 유지합니다. 그 환경에서 최소 높이가 보장된다고 주장하지 않습니다. Min Height를 지원하는 Figma 버전에서 다시 가져오거나 수동으로 해당 constraint를 지정해야 합니다. 지원이 불가능한 경우 측정 높이를 Fixed로 유지하는 것은 초기 외형을 보존하는 대안이지만 콘텐츠 성장까지 보장하지 못합니다.

모바일 360×844 Root Fixed / Middle Content Fill / Bottom Input / Absolute Home Indicator, 명시적 Chart Height, Grid 및 기존 Form/SVG/Gradient/Fixed 기능은 기존 테스트로 확인합니다. Viewport Action Bar의 `(x,y,width,height) = (240,824,1200,76)`은 Section 성장 후에도 유지합니다. 상세 FAQ와 AI Aside 및 모바일 300px Hero의 재현 사례도 포함합니다.

## 예외와 수동 확인

새 변환은 균일한 실제 간격의 세로 block flow에 한정합니다. 서로 다른 간격, 음수 margin, 겹침, inline 혼합, transform, 이동한 relative 자식, Width Hug인 중앙 정렬, 최소/최대 높이에 가려져 판별할 수 없는 마지막 margin collapse는 측정 좌표·Fixed 높이를 유지합니다. styleless 익명 wrapper의 기존 최적화 정책과 실제 Fill 순환 의존성도 유지합니다. 이런 조상에서 높이 전파가 멈출 수 있으며 Debug의 `html-height-sizing` / `HEIGHT_SIZING` 판단 이유로 확인할 수 있습니다.

실제 Figma 수동 확인 절차:

1. 새 ZIP을 풀고 개발 플러그인의 manifest를 다시 연결하거나 Reload합니다.
2. Desktop 1440×900에서 `test/nested-hug-regression.html`을 변환합니다.
3. Card List의 Card 한 개를 복제해 세 번째 행, Tax Section 확장, Next Section 이동을 확인하고 삭제해 복원을 확인합니다.
4. Card의 Text를 길게 수정해 줄바꿈·Card/Row/Section 확장을 확인합니다.
5. 원본 `09-01`, `09-02`, `01-01` 및 모바일 상담/Dashboard HTML에서도 같은 편집을 확인합니다.

원본 세 파일에서의 편집 결과, 실제 Figma font metrics/Wrap engine과 Min Height 런타임 지원 여부는 **수동 확인 필요**입니다.

## 자동 검증 결과

- 전체 117개: **116 통과, 실패 0, skip 1**. 새 Nested Hug 테스트 13개 모두 실행·통과했습니다.
- Skip은 이전 Rich Text 단계의 조건부 엔진 비교이며, 현재 Rich Text·Range·Wrapping 테스트는 실행했습니다.
- 수정 전 `d56ef4a`와 12개 샘플 / 589개 생성 노드의 폭·이름·Wrapper·Rich Text·Paint·SVG·이미지를 비교했습니다. 기존 Height 단계의 `4200294` 비교도 통과했습니다. 허용한 차이는 검증된 Height Flow 및 그에 따른 Auto Layout margin 표현입니다.
- 전체 suite는 Chromium 동시 실행 수를 2로 제한해 완료했습니다. 제한 없는 병렬 실행에서 발생한 Rich Text 노드 누락은 단독 실행에서 통과했으며, 제한한 전체 실행에서도 통과했습니다. 실제 Figma 회귀 결과로 해석하지 않습니다.
- TypeScript 검사와 `dist/code.js` / `dist/ui.html` 빌드가 통과했습니다.

실행 명령:

```sh
npm run typecheck
npm run build
HEIGHT_BASELINE_SRC=/tmp/yesrim-height-baseline/src \
NESTED_BASELINE_SRC=/tmp/yesrim-nested-baseline/src \
node --test --test-concurrency=2 tests/*.test.mjs
```

비교용 src는 각각 `git archive 4200294 src`, `git archive d56ef4a src`로 추출했습니다. 해당 환경 변수를 생략하면 비교 테스트도 조건부 skip입니다. 결과 JSON은 `test-results/nested-hug.json`, `nested-text-growth.json`, `nested-regression.json`에 기록하고 Git에서는 제외합니다.
