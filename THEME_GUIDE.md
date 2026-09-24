# PDF Editor 테마 재사용 가이드

이 문서는 현재 프로젝트의 UI 테마를 다른 React/Vite 프로젝트에 옮겨 적용하기 위한 기준 문서입니다.

## 1. 테마의 성격

- **스타일 방향:** 흰색·회색·검정을 중심으로 한 밝은 모노크롬 UI
- **강조색:** 기본값은 검정(`#000`)
- **글꼴:** 외부 웹폰트가 아닌 시스템 UI 글꼴
- **적용 범위:** 앱 UI 크롬만 테마화합니다. PDF 원본 페이지의 픽셀, 원본 글꼴, 원본 색상은 UI 테마와 분리합니다.
- **CSS 충돌 방지:** 모든 전역 규칙은 `.pdf-editor-root` 아래에 한정합니다.
- **구현 방식:** Tailwind 없이 CSS 변수와 React 인라인 스타일 헬퍼를 함께 사용합니다.

테마 관련 원본 파일은 다음과 같습니다.

| 파일 | 역할 |
| --- | --- |
| `src/styles/theme.ts` | React 인라인 스타일에서 사용하는 색상·크기 토큰과 버튼 헬퍼 |
| `src/styles/global.css` | 루트 스코프, 컨트롤 기본 스타일, 상태·반응형·모션 규칙 |
| `src/App.tsx` | `.pdf-editor-root` 루트 래퍼 적용 |
| `src/main.tsx` | 전역 스타일 import |

## 2. 빠른 적용

### 2.1 파일 복사

다음 두 파일을 대상 프로젝트의 스타일 디렉터리에 복사합니다.

```text
src/styles/theme.ts
src/styles/global.css
```

`theme.ts`는 React의 `CSSProperties`를 사용하므로 대상 프로젝트에 `react`와 `@types/react`가 있어야 합니다.

### 2.2 루트 래퍼 추가

테마를 적용할 UI의 최상위 요소에 반드시 클래스를 붙입니다.

```tsx
export function App() {
  return (
    <div className="pdf-editor-root">
      {/* 테마를 사용할 화면 */}
    </div>
  );
}
```

`global.css`는 `.pdf-editor-root` 내부만 대상으로 하므로 이 래퍼가 없으면 대부분의 스타일이 적용되지 않습니다. 호스트 앱 전체의 `body`나 다른 화면을 오염시키지 않는 것이 이 테마의 핵심 설계입니다.

### 2.3 CSS import

앱 진입점에서 한 번만 import합니다.

```tsx
import './styles/global.css';
```

현재 프로젝트에는 `main.tsx`와 `App.tsx` 양쪽에 import가 남아 있지만, 다른 프로젝트에 옮길 때는 중복 import를 만들지 않는 편이 안전합니다.

### 2.4 React 토큰 사용

인라인 스타일에서는 문자열을 직접 작성하지 말고 `theme.ts`의 토큰을 사용합니다.

```tsx
import {
  BORDER,
  SURFACE,
  TEXT,
  TEXT_MUTED,
  solidAccentBtn,
} from './styles/theme';

<button style={solidAccentBtn({ padding: '0 12px' })}>
  저장
</button>

<div style={{ background: SURFACE, border: `1px solid ${BORDER}`, color: TEXT }}>
  <span style={{ color: TEXT_MUTED }}>보조 설명</span>
</div>
```

CSS만 사용하는 컴포넌트는 `var(--pdfe-...)`를 직접 사용해도 됩니다.

## 3. 색상 토큰

기본값은 `src/styles/global.css`의 `.pdf-editor-root`에 선언되어 있습니다. 대상 프로젝트에서 루트 뒤에 재정의하면 같은 컴포넌트 구조로 다른 색상 테마를 만들 수 있습니다.

| 변수 | 기본값 | 용도 |
| --- | --- | --- |
| `--accent` | `#000` | 강조선, 주요 버튼, 선택 테두리 |
| `--pdfe-page` | `#fff` | 페이지 표면 기본값 |
| `--pdfe-bg` | `#fff` | 앱 전체 배경 |
| `--pdfe-surface` | `#fff` | 카드·패널·툴바 표면 |
| `--pdfe-surface-soft` | `#f9fafb` | 부드러운 표면, 활성 상태 호버 |
| `--pdfe-selected` | `#f3f4f6` | 선택 영역, 일반 컨트롤 호버 |
| `--pdfe-canvas` | `#f9fafb` | PDF 캔버스 주변 배경 |
| `--pdfe-border` | `#e5e7eb` | 기본 테두리 |
| `--pdfe-border-soft` | `rgba(229, 231, 235, .6)` | 카드·모달의 약한 테두리 |
| `--pdfe-border-strong` | `#e5e7eb` | 점선 업로드 영역 등 상대적으로 강한 테두리 |
| `--pdfe-text` | `#111827` | 기본 본문·아이콘 색상 |
| `--pdfe-text-muted` | `#6b7280` | 보조 설명 |
| `--pdfe-text-subtle` | `#9ca3af` | 비활성·약한 보조 텍스트 |
| `--pdfe-text-faint` | `#9ca3af` | 상단 내비게이션의 비활성 텍스트 |
| `--pdfe-scrollbar` | `#e5e7eb` | 사용자 정의 스크롤바 thumb |
| `--pdfe-toast-bg` | `#111827` | 토스트 배경 |

상태·동작용으로 다음 변수도 사용합니다.

| 변수 | 설정 위치 | 용도 |
| --- | --- | --- |
| `--pdfe-button-bg` | 버튼 호버/상태 규칙 | 컴포넌트의 기본 배경을 일시적으로 덮음 |
| `--pdfe-button-color` | 버튼 호버/상태 규칙 | 컴포넌트의 기본 글자색을 일시적으로 덮음 |
| `--pdfe-edit-panel-width` | 편집 레이아웃 인라인 스타일 | 편집 패널 폭, 기본 `380px` |

`theme.ts`에서 제공하는 의미 토큰은 다음 CSS 변수에 연결됩니다.

```ts
export const ACCENT = 'var(--accent, #000)';
export const BG = 'var(--pdfe-bg, #fff)';
export const SURFACE = 'var(--pdfe-surface, #fff)';
export const TEXT = 'var(--pdfe-text, #111827)';
export const TEXT_MUTED = 'var(--pdfe-text-muted, #6b7280)';
export const BORDER = 'var(--pdfe-border, #e5e7eb)';
```

`DANGER`는 `#dc2626`, `SUCCESS`는 `#111827`로 고정되어 있습니다. 오류 의미까지 대상 프로젝트의 브랜드 색으로 바꾸려면 `theme.ts`에서 별도로 조정해야 합니다.

## 4. 레이아웃·형태 기준

`theme.ts`와 컴포넌트에서 사용하는 주요 수치는 다음과 같습니다.

| 항목 | 값 | 설명 |
| --- | ---: | --- |
| 기본 글꼴 크기 | `14px` | 루트 기본값 |
| 기본 줄 간격 | `1.5` | 루트 기본값 |
| 상단 제목 바 | `60px` | `TOPBAR_H` |
| 편집 툴바 최소 높이 | `50px` | `TOOLBAR_H` |
| 도구 버튼 | `32px` | 원형 아이콘 버튼 |
| 썸네일 카드 높이 | `108px` | `RAIL_CARD_H` |
| 썸네일 카드 간격 | `10px` | `RAIL_GAP` |
| 편집 패널 기본 폭 | `380px` | CSS 변수 fallback |
| 캔버스 여백 | `40px 30px 90px` | PDF 작업 영역 |
| 페이지 사이 간격 | `24px` | 두 페이지 보기 포함 |
| 일반 필드 모서리 | `8px` | input/select/textarea |
| 주요 컨테이너 모서리 | `24px` | 업로드 카드·모달·하단 내비게이션 |
| 버튼 모서리 | `9999px` | pill 형태 |
| 패널 그림자 | `0 12px 40px rgba(0,0,0,.12)` | `PANEL_SHADOW` |
| 페이지 그림자 | `0 2px 12px rgba(0,0,0,.08)` | `PAGE_SHADOW` |

기본 글꼴 스택은 다음과 같습니다.

```css
system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif
```

아이콘은 `lucide-react`를 기준으로 하며, 보통 `22px`, `strokeWidth={1.5}`를 사용합니다.

## 5. 제공되는 React 스타일 헬퍼

`src/styles/theme.ts`에는 반복되는 컨트롤 스타일을 맞추기 위한 헬퍼가 있습니다.

- `solidAccentBtn(extra?)`: 검정 강조색의 pill 버튼
- `outlineAccentBtn(extra?)`: 테두리가 있는 보조 버튼
- `spinnerAccentStyle(size, borderW)`: 강조색 상단 테두리를 사용하는 회전 로더
- `toolBase`: 기본 원형 도구 버튼
- `toolActive`: 선택된 도구 버튼
- `toolDisabled`: 비활성 도구 버튼
- `fmtBase` / `fmtActive`: segmented control의 기본·활성 항목
- `permBase` / `permActive`: 권한/옵션 segmented control 변형

헬퍼는 마지막에 `extra`를 병합하므로 화면별 크기나 배치는 호출부에서 조정할 수 있습니다. 색상·radius·글꼴처럼 공통 시각 규칙은 헬퍼에 남기고, 위치·flex 정렬·화면별 폭만 `extra`로 전달합니다.

## 6. 상호작용 규칙

### 버튼 상태

- 일반 버튼 호버: 배경 `--pdfe-selected`, 글자 `--pdfe-text`
- `aria-pressed="true"` 버튼 호버: 배경 `--pdfe-surface-soft`
- 주요 버튼 호버: `#27272a`
- 비활성 컨트롤: `opacity: .5`, `cursor: not-allowed`
- 전환: 배경·글자·테두리·outline 색상을 `180ms ease`
- 포커스: `2px` solid `--pdfe-text`, `2px` offset
- 텍스트 hit 영역과 썸네일 hit 영역은 일반 버튼 호버 규칙에서 제외

상태는 `background`를 직접 덮어쓰기보다 `--pdfe-button-bg`와 `--pdfe-button-color`로 변경합니다. 그러면 인라인 스타일에 지정한 기본 상태를 유지하면서 호버 스타일만 일관되게 바꿀 수 있습니다.

### 선택·오류·로딩

- 텍스트 선택 배경: `#e5e7eb`
- 오류 메시지: `#dc2626`
- 로딩: `pdfe-spin` keyframe, 기본 회전 시간 `.8s`
- 화면/패널 진입: `pdfe-pop`, `180ms ease-out`
- 토스트 진입: `pdfe-toast-in`
- 진행 중 상태: `pdfe-pulse`

### 모션 감소

`prefers-reduced-motion: reduce`에서는 화면/패널/토스트 애니메이션과 버튼 전환을 제거합니다. 새 컴포넌트를 추가할 때도 같은 미디어 쿼리 정책을 따릅니다.

## 7. 반응형 기준

`max-width: 640px`에서 다음 동작을 사용합니다.

- 편집기 상단 바가 여러 줄로 감싸지고 세로 여백이 `12px`가 됩니다.
- 파일명은 다음 줄 전체 폭을 사용합니다.
- 편집 패널은 우측에서 작업 영역 위로 겹쳐집니다.
- 패널 폭 조절자는 패널 왼쪽 경계에 절대 위치로 배치됩니다.

터치 포인터에서는 페이지 카드의 컨트롤을 항상 표시합니다. 마우스 환경에서는 페이지 카드에 마우스를 올리거나 포커스가 들어오거나 선택된 경우에만 표시합니다.

## 8. 다른 프로젝트에서 색상만 바꾸기

컴포넌트를 수정하지 않고 `.pdf-editor-root` 뒤에 변수만 재정의할 수 있습니다. 재정의 CSS는 원본 선언보다 뒤에 두어야 합니다.

```css
/* global.css import 뒤에 배치 */
.my-brand-editor {
  --accent: #2563eb;
  --pdfe-selected: #eff6ff;
  --pdfe-canvas: #f8fafc;
  --pdfe-text: #0f172a;
  --pdfe-text-muted: #475569;
  --pdfe-border: #cbd5e1;
  --pdfe-border-soft: rgba(203, 213, 225, .7);
  --pdfe-border-strong: #94a3b8;
}
```

이 경우 루트 클래스는 두 개를 함께 사용합니다.

```tsx
<div className="pdf-editor-root my-brand-editor">
  <Editor />
</div>
```

단순히 `--accent`만 바꾸면 모든 UI가 브랜드 색으로 바뀌지는 않습니다. 표면·선택·본문·보조 텍스트의 대비를 함께 조정해야 하며, `theme.ts`의 `DANGER`, `SUCCESS`, `PANEL_SHADOW`, `PAGE_SHADOW`는 CSS 변수로 노출되지 않는다는 점을 고려합니다.

## 9. 재사용 시 주의사항

1. `.pdf-editor-root` 스코프를 제거하지 않습니다. 제거하면 호스트 프로젝트의 `button`, `input`, `h2`, `body` 등에 스타일이 새어 나갑니다.
2. `color-scheme: light`가 설정되어 있으므로 다크 테마로 바꿀 때는 모든 표면·텍스트 대비를 검토하고, `white`, `#fff`, 반투명 검정처럼 CSS 변수 밖에 남은 값을 확인합니다.
3. `.pdfe-*` 클래스에는 테마 토큰뿐 아니라 PDF 편집기 레이아웃 규칙도 포함되어 있습니다. 색상만 필요하면 토큰 선언과 필요한 컨트롤 규칙만 복사하고, 편집기 레이아웃까지 재사용할 때는 해당 클래스 구조도 함께 유지합니다.
4. 현재 구현은 일부 컴포넌트에서 `background: white` 또는 `color: #fff`를 직접 사용합니다. 페이지·주요 버튼의 흰색은 의도된 고정 대비이므로 색상 테마를 바꿀 때 시각 검토가 필요합니다.
5. `.pdfe-native-page`와 PDF 캔버스는 문서 원본을 표시하는 영역입니다. 앱 테마 색상을 PDF 렌더링 결과에 적용하지 않습니다.
6. 호스트 앱이 자체 reset이나 `button` 스타일을 사용한다면, `.pdf-editor-root` 내부에서 우선순위가 충돌할 수 있습니다. 테마 import 순서와 실제 화면을 함께 확인합니다.

## 10. 적용 확인 목록

- [ ] 테마를 사용할 최상위 요소에 `.pdf-editor-root`가 있다.
- [ ] `global.css`가 한 번 import되어 있다.
- [ ] 인라인 스타일은 `theme.ts` 토큰과 헬퍼를 사용한다.
- [ ] 버튼의 기본·호버·활성·비활성·포커스 상태를 확인했다.
- [ ] `640px` 이하에서 헤더와 패널이 겹치지 않는다.
- [ ] `prefers-reduced-motion: reduce`에서 애니메이션이 제거된다.
- [ ] 페이지 렌더링 색상과 UI 테마 색상이 분리되어 있다.
- [ ] 브랜드 색상 변경 후 본문·보조 텍스트·테두리의 대비를 확인했다.
