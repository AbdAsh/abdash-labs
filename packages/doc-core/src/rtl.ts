// Direction is decided by script, not by "is this ASCII". Two traps make the
// naive version wrong:
//
//   1. Turkish is a target language for this product and is left-to-right, but
//      its diacritics (ç ğ ı ö ş ü) are non-ASCII. A byte-range check mirrors
//      the layout for a Turkish document, which is a visible, embarrassing bug.
//   2. Arabic-Indic digits (٠-٩, U+0660–U+0669) sit *inside* the Arabic block.
//      A page of tabular figures would otherwise read as a right-to-left
//      document even when every word on it is English.
//
// So: classify by Unicode script, and only count characters that are actually
// letters or combining marks. Digits, spaces and punctuation are
// direction-neutral and are skipped entirely rather than counted for either
// side, which would dilute short samples toward a false negative.

const RTL_SCRIPT =
  /[\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}\p{Script=Samaritan}\p{Script=Mandaic}\p{Script=Adlam}]/u

const LTR_SCRIPT =
  /[\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}\p{Script=Armenian}\p{Script=Georgian}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Devanagari}\p{Script=Thai}]/u

const DIRECTIONAL = /[\p{Letter}\p{Mark}]/u

/** True when right-to-left letters outnumber left-to-right letters past the
 *  threshold. Returns false for text with no directional letters at all. */
export function isRTL(text: string, threshold = 0.3): boolean {
  let rtl = 0
  let ltr = 0

  for (const ch of text) {
    if (!DIRECTIONAL.test(ch)) continue
    if (RTL_SCRIPT.test(ch)) rtl++
    else if (LTR_SCRIPT.test(ch)) ltr++
  }

  const total = rtl + ltr
  return total > 0 && rtl / total >= threshold
}
