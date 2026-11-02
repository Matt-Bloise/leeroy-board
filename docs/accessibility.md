# Accessibility statement and plan

Status: draft, 2026-11-02. This is a statement of intent and current testing, not a claim of conformance. No external audit or screen-reader session has been done.

## Target
WCAG 2.2 Level AA for the first-run flow and the main board: open the site, identify yourself, read the next step, open the sheet, sign up. Other scenes are in scope but are not yet checked to the same depth.

## What is tested
- **axe-core in CI**: `tests/browser/axe.mjs` runs on every pull request preview (`Preview Tests`). It scans the first screen and the Next steps sheet in Chromium at 390x844 (touch) and 1366x768, with motion reduced. It fails on serious or critical violations and prints minor and moderate ones as warnings. It currently loads the WCAG 2.0/2.1 A and AA rule tags only, not the 2.2 tags (`wcag22aa`); adding them is an open task.
- Automated checks find only a part of the problems (commonly cited as roughly a third); they do not replace manual review.

## What is not tested yet
- Keyboard-only walk-through of every scene, focus order and visible focus (2.4.7, 2.4.11 Focus Not Obscured, 2.5.8 Target Size minimum 24 px) by a person.
- Screen readers (NVDA, VoiceOver, TalkBack). An external session is planned (roadmap Q50, owner recruits).
- Zoom to 200 percent and 400 percent reflow, text spacing overrides, forced-colours mode.
- Reduced-motion parity: the axe run uses reduced motion, but animation behaviour in all scenes is not verified.
- Colour contrast over animated or image backgrounds, which axe can miss.
- The WebSocket live room and the Discord side, which is not web content.

## Known gaps (unverified until tested; listed so nobody assumes otherwise)
1. The board has many tabs and a ribbon; the roadmap decision is that the ribbon is a navigation list, not an ARIA `tablist` (Q49). Not yet confirmed in code.
2. Canvas or art-driven scenes may lack text alternatives.
3. Countdowns and live updates may not be announced to assistive technology.
4. Drag or pointer-only interactions, if any, need a single-pointer alternative (2.5.7).
5. Authentication through Discord is a third-party flow outside our control (3.3.8 Accessible Authentication applies to our part only).

## Process
- New front-end work should keep axe green and state in the PR what was checked by hand.
- Findings from external sessions are filed as issues labelled accessibility and listed here.
- Review this file each release of the first-run flow.

## Contact
Accessibility problems and requests for another format: **(contact to be added by the owner)**. Do not use a personal address here until the owner chooses a role address. Reply target: [within N working days; owner to set].
