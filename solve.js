// csv-reader-fast round 3: a fast drop-in for make.fun's csv-reader 1.0.0.
//
// run(input) returns, for {text, header}, exactly csv-reader 1.0.0's answer
// {columns, rows, errors}, following its written broken-row policy:
//
//   - a U+FEFF at the very start of the text is dropped;
//   - a record ends at LF or CRLF, and a line left with no characters is no
//     record;
//   - outside a quoted field a CR not followed by LF is dropped (stray_cr);
//   - a field that opens with a quote runs to the next quote that is not
//     doubled, "" inside it is one quote, and each CRLF or lone CR inside it
//     is read as LF; what follows its closing quote, up to the next comma or
//     line break, is appended as it stands (quote_junk, when the field ends);
//     a quote that never closes is a literal character, and the text after it
//     is read again as unquoted (unterminated_quote);
//   - a quote inside an unquoted field is a literal character; fields stay
//     strings, never trimmed or converted;
//   - columns is the first record when header is true, else null; rows holds
//     the records after it, each padded with "" (short_row, with fields: its
//     count) or cut (long_row, with extra: the cut fields) to the first
//     record's width;
//   - each error is {code, line, row}, in the order met, a field's quote_junk
//     when the field ends and a record's short_row or long_row when the
//     record ends; line is the 1-based line its record starts on.
//
// Speed: a whole-line fast path splits a line on commas when it holds no
// quote and no stray CR, and otherwise one inlined field loop reads every
// field with indexOf/slice — no call and no allocation per field. An unquoted
// field needs a single indexOf(',') because the line it sits on is tracked
// (curLineEnd), so a comma past it means the field ends at the line break.
// A quoted field that spans lines is rebuilt with replaceAll, never a
// character at a time. Pure: no clock, no randomness, nothing kept from one
// call to the next.

const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

const CC_COMMA = 44; // ,
const CC_QUOTE = 34; // "
const CC_CR = 13; // \r
const CC_LF = 10; // \n
const CC_BOM = 0xfeff;

/** csv-reader 1.0.0's answer for one case's input {text, header}. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const len = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (text.charCodeAt(0) === CC_BOM) pos = 1;

  // The record being read: the line it starts on and the index in rows it
  // takes (null: the header).
  let recordLine = 1;
  let recordRow = null;

  while (true) {
    // Lines with no characters are no records.
    while (pos < len) {
      const ch = text.charCodeAt(pos);
      if (ch === CC_LF) {
        pos += 1;
        line += 1;
      } else if (ch === CC_CR && text.charCodeAt(pos + 1) === CC_LF) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= len) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    // The end of the physical line the record starts on: the next LF, or the
    // end of the text. The slow path below keeps curLineEnd on the line the
    // field being read sits on.
    const le = text.indexOf('\n', pos);
    const lineEnd = le === -1 ? len : le;
    let contentEnd = lineEnd;
    if (le !== -1 && lineEnd > pos && text.charCodeAt(lineEnd - 1) === CC_CR) contentEnd = lineEnd - 1;

    let fields = null; // set by the fast path, else read field by field
    let lastQuoted = false;

    // Fast path: the whole record is one line holding no quote and no stray
    // CR, so its fields are the line split on commas.
    if (contentEnd > pos) {
      const seg = text.slice(pos, contentEnd);
      if (seg.indexOf('"') === -1 && seg.indexOf('\r') === -1) {
        fields = seg.split(',');
        if (le === -1) {
          pos = len;
        } else {
          pos = le + 1;
          line += 1;
        }
      }
    }

    if (fields === null) {
      fields = [];
      let curLe = le; // the next LF at or after pos, or -1 when there is none
      let curLineEnd = lineEnd; // its position, or len
      for (;;) {
        let value;
        let ended;
        // An unquoted read is needed from uStart with uInitial already in
        // the value (a plain field, a quote re-read as unquoted, or junk
        // after a closing quote); -1 when the quoted field ended on its own.
        let uStart = -1;
        let uInitial = '';
        let junk = false;

        if (text.charCodeAt(pos) === CC_QUOTE) {
          lastQuoted = true;
          // The closing quote: the next quote that is not doubled.
          let q = text.indexOf('"', pos + 1);
          let doubled = false;
          while (q !== -1 && text.charCodeAt(q + 1) === CC_QUOTE) {
            doubled = true;
            q = text.indexOf('"', q + 2);
          }
          if (q === -1) {
            // The quote never closes: it is a literal character, and the
            // text after it is read again as unquoted. No line was crossed.
            errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
            uStart = pos + 1;
            uInitial = '"';
          } else {
            const raw = text.slice(pos + 1, q);
            // The closing quote sits past the line end exactly when the
            // field spans lines, so raw holds an LF; a lone CR can hide on
            // one line, so it is checked on its own.
            const spansLines = q > curLineEnd;
            const hasCR = raw.indexOf('\r') !== -1;
            let v;
            if (!spansLines && !hasCR) {
              v = doubled ? raw.replaceAll('""', '"') : raw;
            } else {
              // "" pairs become one quote, every CRLF or lone CR becomes
              // LF; the LFs left count the lines crossed inside the quotes.
              let w = doubled ? raw.replaceAll('""', '"') : raw;
              if (hasCR) w = w.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
              let inc = 0;
              let idx = -1;
              while ((idx = w.indexOf('\n', idx + 1)) !== -1) inc += 1;
              line += inc;
              v = w;
              if (spansLines) {
                curLe = text.indexOf('\n', q + 1);
                curLineEnd = curLe === -1 ? len : curLe;
              }
            }
            const after = q + 1;
            if (after >= len) {
              value = v;
              ended = END;
              pos = len;
            } else {
              const c = text.charCodeAt(after);
              if (c === CC_COMMA) {
                value = v;
                ended = COMMA;
                pos = after + 1;
              } else if (c === CC_LF) {
                value = v;
                ended = LINE_BREAK;
                pos = after + 1;
                line += 1;
              } else if (c === CC_CR && text.charCodeAt(after + 1) === CC_LF) {
                value = v;
                ended = LINE_BREAK;
                pos = after + 2;
                line += 1;
              } else {
                // What follows the closing quote is appended as it stands,
                // up to the next comma or line break.
                uStart = after;
                uInitial = v;
                junk = true;
              }
            }
          }
        } else {
          lastQuoted = false;
          uStart = pos;
        }

        if (uStart !== -1) {
          // An unquoted field from uStart: it ends at the next comma before
          // the line end, else at the line break (a CR just before the LF
          // is the CRLF line ending) or at the end of the text. Any other
          // CR inside it is a stray one, dropped.
          const c = text.indexOf(',', uStart);
          let fEnd;
          if (c !== -1 && c < curLineEnd) {
            fEnd = c;
            ended = COMMA;
          } else if (curLe !== -1) {
            fEnd = curLineEnd;
            if (fEnd > uStart && text.charCodeAt(fEnd - 1) === CC_CR) fEnd -= 1;
            ended = LINE_BREAK;
          } else {
            fEnd = len;
            ended = END;
          }
          const seg = text.slice(uStart, fEnd);
          if (seg.indexOf('\r') === -1) {
            value = uInitial === '' ? seg : uInitial + seg;
          } else {
            let v2 = uInitial;
            let cur = 0;
            for (;;) {
              const r = seg.indexOf('\r', cur);
              if (r === -1) {
                const tail = seg.slice(cur);
                if (tail !== '') v2 = v2 === '' ? tail : v2 + tail;
                break;
              }
              const head = seg.slice(cur, r);
              if (head !== '') v2 = v2 === '' ? head : v2 + head;
              errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
              cur = r + 1;
            }
            value = v2;
          }
          if (ended === COMMA) {
            pos = fEnd + 1;
          } else if (ended === LINE_BREAK) {
            pos = curLineEnd + 1;
            line += 1;
          } else {
            pos = len;
          }
          if (junk && value.length > uInitial.length) {
            errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
          }
        }

        fields.push(value);
        if (ended !== COMMA) break;
      }
    }

    // A line that held only stray CRs is left with no characters: no record
    // (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !lastQuoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
