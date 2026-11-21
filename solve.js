// csv-reader-fast: a fast drop-in for make.fun's csv-reader 1.0.0.
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
// Written from scratch for speed, never a character at a time in the common
// case: a whole-line fast path splits a line on commas when it holds no quote
// and no stray CR, and otherwise a field scanner built on indexOf/slice finds
// each field's end and slices it out whole. Pure: no clock, no randomness,
// nothing kept from one call to the next.

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

  // Reads an unquoted field starting at `start`, with `initial` already in
  // the value, up to the next comma or line break: a CR not followed by LF is
  // dropped (stray_cr). Returns [value, ended, added, endPos]; `added` counts
  // the characters kept, `line` advances past every line break crossed.
  function readUnquoted(start, initial) {
    let p = start;
    let value = initial;
    let added = 0;
    const c = text.indexOf(',', p);
    const n = text.indexOf('\n', p);
    let end; // index of the delimiter, or len
    let ended;
    if (c !== -1 && (n === -1 || c < n)) {
      end = c;
      ended = COMMA;
    } else if (n !== -1) {
      end = n;
      ended = LINE_BREAK;
    } else {
      end = len;
      ended = END;
    }
    // A CR just before the LF is the CRLF line ending, not part of the
    // field; any CR strictly inside the field is a stray one.
    let fEnd = end;
    if (ended === LINE_BREAK && end > p && text.charCodeAt(end - 1) === CC_CR) fEnd = end - 1;
    const seg = text.slice(p, fEnd);
    if (seg.indexOf('\r') === -1) {
      if (seg.length !== 0) {
        if (value.length === 0) value = seg;
        else value += seg;
        added += seg.length;
      }
    } else {
      // Stray CRs inside the field: drop each, keep the rest, in order.
      let cur = p;
      for (;;) {
        const r = text.indexOf('\r', cur);
        if (r === -1 || r >= fEnd) {
          const tail = text.slice(cur, fEnd);
          if (tail.length !== 0) {
            if (value.length === 0) value = tail;
            else value += tail;
            added += tail.length;
          }
          break;
        }
        const head = text.slice(cur, r);
        if (head.length !== 0) {
          if (value.length === 0) value = head;
          else value += head;
          added += head.length;
        }
        errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
        cur = r + 1;
      }
    }
    if (ended === COMMA) return [value, COMMA, added, end + 1];
    if (ended === LINE_BREAK) {
      line += 1;
      return [value, LINE_BREAK, added, end + 1];
    }
    return [value, END, added, len];
  }

  // Reads a quoted field whose opening quote is at `start`: the value, how it
  // ended and where the next field starts, as [value, ended, endPos].
  function readQuoted(start) {
    let q = text.indexOf('"', start + 1);
    let doubled = false;
    while (q !== -1 && text.charCodeAt(q + 1) === CC_QUOTE) {
      doubled = true;
      q = text.indexOf('"', q + 2);
    }
    if (q === -1) {
      // The quote never closes: it is a literal character, and the text after
      // it is read again as unquoted. `line` is still the line at the opening
      // quote: the scan above never moved it.
      errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
      const r = readUnquoted(start + 1, '"');
      return [r[0], r[1], r[3]];
    }
    const raw = text.slice(start + 1, q);
    let value;
    let inc = 0; // lines crossed inside the quotes
    if (raw.indexOf('\n') === -1 && raw.indexOf('\r') === -1) {
      value = doubled ? raw.replaceAll('""', '"') : raw;
    } else {
      // "" pairs become one quote, every CRLF or lone CR becomes LF.
      let v = '';
      let cut = 0;
      for (let i = 0; i < raw.length; i++) {
        const ch = raw.charCodeAt(i);
        if (ch === CC_QUOTE) {
          v += raw.slice(cut, i) + '"';
          i += 1; // skip the second quote of the pair
          cut = i + 1;
        } else if (ch === CC_CR) {
          v += raw.slice(cut, i) + '\n';
          inc += 1;
          if (raw.charCodeAt(i + 1) === CC_LF) i += 1; // CRLF is one LF
          cut = i + 1;
        } else if (ch === CC_LF) {
          v += raw.slice(cut, i) + '\n';
          inc += 1;
          cut = i + 1;
        }
      }
      v += raw.slice(cut);
      value = v;
    }
    line += inc;
    const after = q + 1;
    if (after >= len) return [value, END, len];
    const c = text.charCodeAt(after);
    if (c === CC_COMMA) return [value, COMMA, after + 1];
    if (c === CC_LF) {
      line += 1;
      return [value, LINE_BREAK, after + 1];
    }
    if (c === CC_CR && text.charCodeAt(after + 1) === CC_LF) {
      line += 1;
      return [value, LINE_BREAK, after + 2];
    }
    // What follows the closing quote is appended as it stands, up to the next
    // comma or line break.
    const r = readUnquoted(after, value);
    if (r[2] > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
    return [r[0], r[1], r[3]];
  }

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

    let fields = null; // set by the fast path, else read field by field
    let lastQuoted = false;
    let ended = END;

    // Fast path: the whole record is one line holding no quote and no stray
    // CR, so its fields are the line split on commas.
    const le = text.indexOf('\n', pos);
    const lineEnd = le === -1 ? len : le;
    let contentEnd = lineEnd;
    if (le !== -1 && lineEnd > pos && text.charCodeAt(lineEnd - 1) === CC_CR) contentEnd = lineEnd - 1;
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
      let value;
      do {
        if (text.charCodeAt(pos) === CC_QUOTE) {
          lastQuoted = true;
          const r = readQuoted(pos);
          value = r[0];
          ended = r[1];
          pos = r[2];
        } else {
          lastQuoted = false;
          const r = readUnquoted(pos, '');
          value = r[0];
          ended = r[1];
          pos = r[3];
        }
        fields.push(value);
      } while (ended === COMMA);
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
