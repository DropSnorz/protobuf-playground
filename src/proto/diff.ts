/** Compares the producer and consumer schemas from a wire-compatibility angle. */
import { shortName } from './schema';
import type { FieldDef, MessageDef, Schema } from './types';
import { wireTypeFor } from './wire';

export type Severity = 'compatible' | 'caution' | 'breaking';

export interface DiffEntry {
  where: string;
  severity: Severity;
  title: string;
  detail: string;
}

const VARINT_INTS = new Set(['int32', 'int64', 'uint32', 'uint64', 'bool']);

function typeCompat(p: FieldDef, c: FieldDef): { severity: Severity; detail: string } | null {
  const pt = p.map ? 'map' : p.kind === 'scalar' ? p.type : p.kind;
  const ct = c.map ? 'map' : c.kind === 'scalar' ? c.type : c.kind;
  if (pt === 'map' || ct === 'map') {
    if (pt === ct) return null;
    return {
      severity: 'compatible',
      detail: 'A map is wire-identical to `repeated Entry { key = 1; value = 2; }`. It stays compatible as long as the other side declares exactly that entry message.',
    };
  }
  if (pt === 'message' && ct === 'message') return null; // compared recursively
  if (pt === 'enum' && ct === 'enum') return null; // compared separately
  const pw = wireTypeFor(p.type, p.kind);
  const cw = wireTypeFor(c.type, c.kind);
  const pn = pt === 'enum' ? 'enum' : pt;
  const cn = ct === 'enum' ? 'enum' : ct;
  if (pn === cn) return null;
  const intLike = (t: string) => VARINT_INTS.has(t) || t === 'enum';
  const WIDENING = new Set(['int32>int64', 'uint32>uint64', 'uint32>int64', 'enum>int32', 'enum>int64', 'bool>int32', 'bool>int64', 'bool>uint32', 'bool>uint64']);
  if (WIDENING.has(`${pn}>${cn}`)) {
    return { severity: 'compatible', detail: 'Same VARINT encoding and the consumer type can hold every value the producer can write.' };
  }
  if (intLike(pn) && intLike(cn)) {
    return {
      severity: 'caution',
      detail:
        'Same VARINT encoding, so it parses. Values may still be truncated to 32 bits, change sign, or become `true` for any non-zero value.',
    };
  }
  if ((pn === 'sint32' || pn === 'sint64') && (cn === 'sint32' || cn === 'sint64')) {
    return { severity: 'caution', detail: 'Both use ZigZag: compatible, except values that do not fit in 32 bits get truncated.' };
  }
  if (pw === cw && pw === 0) {
    return {
      severity: 'breaking',
      detail: 'Both are VARINT on the wire, but one uses ZigZag and the other does not: values are **silently wrong** (e.g. -1 ↔ 1).',
    };
  }
  if (pn === 'string' && cn === 'bytes') {
    return { severity: 'compatible', detail: 'Both LEN: the consumer receives the raw UTF-8 bytes.' };
  }
  if (pn === 'bytes' && cn === 'string') {
    return { severity: 'caution', detail: 'Both LEN: works only while the bytes happen to be valid UTF-8. Otherwise the whole message fails to parse.' };
  }
  if (pn === 'message' && cn === 'bytes') {
    return { severity: 'compatible', detail: 'An embedded message is plain LEN bytes. The consumer gets it as an opaque blob it can forward or parse later.' };
  }
  if (pn === 'bytes' && cn === 'message') {
    return { severity: 'caution', detail: 'The consumer parses the bytes as a message: fine if they are a serialized message, garbage or a parse failure otherwise.' };
  }
  if (pw === cw) {
    return {
      severity: 'breaking',
      detail: `Same wire type (${pw === 2 ? 'LEN' : pw === 1 ? 'I64' : 'I32'}) so the parser accepts it, but the bytes mean something else: garbage values or a parse failure.`,
    };
  }
  return {
    severity: 'breaking',
    detail: 'Different wire types: the consumer cannot read the value and treats the record as an unknown field (the value is lost for it).',
  };
}

export function diffSchemas(ps: Schema, pType: string, cs: Schema, cType: string): DiffEntry[] {
  const out: DiffEntry[] = [];
  const seen = new Set<string>();
  const cShort = (n: string) => shortName(n, cs.packageName);

  const cmpMessage = (pm: MessageDef, cm: MessageDef, where: string) => {
    const key = `${pm.fullName}|${cm.fullName}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (pm.name !== cm.name) {
      out.push({
        where,
        severity: 'compatible',
        title: `Message type name: ${pm.name} → ${cm.name}`,
        detail: 'Type names never go on the wire: renaming a message is binary compatible (but not for `Any` / JSON type URLs).',
      });
    }
    const numbers = new Set([...pm.byNumber.keys(), ...cm.byNumber.keys()]);
    for (const n of [...numbers].sort((a, b) => a - b)) {
      const p = pm.byNumber.get(n);
      const c = cm.byNumber.get(n);
      const w = `${where}.${(p ?? c)!.name}`;
      if (p && !c) {
        const moved = cm.byName.get(p.name);
        if (moved) {
          out.push({
            where: w,
            severity: 'breaking',
            title: `\`${p.name}\` renumbered: #${p.number} → #${moved.number}`,
            detail: `The producer writes #${p.number}, the consumer looks for #${moved.number}: data lands in an unknown field and \`${p.name}\` reads as its default. Never change the number of an existing field.`,
          });
          continue;
        }
        const reserved = cm.reservedNumbers.some(([a, b]) => n >= a && n <= b);
        out.push({
          where: w,
          severity: 'compatible',
          title: `#${n} \`${p.name}\` unknown to the consumer`,
          detail: `The consumer skips it and keeps it as an unknown field.${reserved ? ' It is `reserved` on the consumer side (deleted field).' : ''}`,
        });
        continue;
      }
      if (!p && c) {
        if (pm.byName.get(c.name)) continue; // reported as renumbered
        out.push({
          where: w,
          severity: c.hasPresence || c.repeated || c.map ? 'compatible' : 'caution',
          title: `#${n} \`${c.name}\` never sent by the producer`,
          detail: c.hasPresence
            ? 'The consumer sees it as *not set* (has_… = false).'
            : 'The consumer sees the default value (0 / "" / false / first enum value), which looks the same as an explicit default.',
        });
        continue;
      }
      if (!p || !c) continue;
      if (p.name !== c.name) {
        out.push({
          where: w,
          severity: 'compatible',
          title: `#${n} renamed: \`${p.name}\` → \`${c.name}\``,
          detail: 'Only numbers travel in binary: renaming is safe on the wire. It does break the JSON format and code referring to the old name.',
        });
      }
      const tc = typeCompat(p, c);
      if (tc) {
        out.push({ where: w, severity: tc.severity, title: `#${n} type: ${p.displayType} → ${c.displayType}`, ...{ detail: tc.detail } });
      } else if (p.kind === 'message' && c.kind === 'message' && !p.map && !c.map) {
        const psub = ps.messages.get(p.type);
        const csub = cs.messages.get(c.type);
        if (psub && csub) cmpMessage(psub, csub, `${where}.${c.name}`);
      } else if (p.map && c.map) {
        if (p.map.keyType !== c.map.keyType || p.map.valueType.split('.').pop() !== c.map.valueType.split('.').pop()) {
          out.push({ where: w, severity: 'caution', title: `#${n} map: ${p.displayType} → ${c.displayType}`, detail: 'Key/value types differ: the same rules as for regular fields apply to the entry fields.' });
        }
        if (p.map.valueKind === 'message' && c.map.valueKind === 'message') {
          const psub = ps.messages.get(p.map.valueType);
          const csub = cs.messages.get(c.map.valueType);
          if (psub && csub) cmpMessage(psub, csub, `${where}.${c.name}{}`);
        }
      } else if (p.kind === 'enum' && c.kind === 'enum') {
        cmpEnum(p.type, c.type, w);
      }
      if (!p.map && !c.map) {
        if (p.repeated !== c.repeated) {
          const scalarNum = wireTypeFor(c.type, c.kind) !== 2;
          out.push({
            where: w,
            severity: p.repeated ? (scalarNum ? 'breaking' : 'caution') : 'compatible',
            title: `#${n} ${p.repeated ? 'repeated → singular' : 'singular → repeated'}`,
            detail: p.repeated
              ? scalarNum
                ? 'The producer packs the values in one LEN record; a singular numeric field expects a VARINT/I32/I64 → wire type mismatch, value lost.'
                : 'A singular field keeps only the **last** element (messages: all elements merged).'
              : 'Compatible: the single value arrives as a one-element list.',
          });
        } else if (p.repeated && c.repeated && p.packed !== c.packed) {
          out.push({ where: w, severity: 'compatible', title: `#${n} packed=${p.packed} → packed=${c.packed}`, detail: 'Parsers must accept both packed and unpacked encodings.' });
        }
        if (p.oneof !== c.oneof) {
          out.push({
            where: w,
            severity: 'caution',
            title: `#${n} oneof membership: ${p.oneof ?? 'none'} → ${c.oneof ?? 'none'}`,
            detail: 'Binary compatible for a single field, but moving several existing fields into a oneof can drop data (only the last one on the wire survives).',
          });
        }
        if (p.explicitOptional !== c.explicitOptional && !p.oneof && !c.oneof) {
          out.push({
            where: w,
            severity: p.explicitOptional ? 'compatible' : 'caution',
            title: `#${n} ${p.explicitOptional ? 'optional → implicit presence' : 'implicit → optional'}`,
            detail: p.explicitOptional
              ? 'Wire compatible. The consumer loses the ability to tell "set to 0" from "not set".'
              : 'Wire compatible, but the producer never writes zero values: the consumer sees *not set* when the producer meant 0.',
          });
        }
      }
    }
  };

  const cmpEnum = (pName: string, cName: string, where: string) => {
    const key = `${pName}|${cName}`;
    if (seen.has(key)) return;
    seen.add(key);
    const pe = ps.enums.get(pName)!;
    const ce = cs.enums.get(cName)!;
    const nums = new Set([...pe.byNumber.keys(), ...ce.byNumber.keys()]);
    for (const n of [...nums].sort((a, b) => a - b)) {
      const a = pe.byNumber.get(n);
      const b = ce.byNumber.get(n);
      if (a && !b) {
        out.push({
          where: `${where}: enum ${ce.name}`,
          severity: 'caution',
          title: `Enum value ${a} = ${n} unknown to the consumer`,
          detail: 'proto3 enums are open: the consumer keeps the raw number (UNRECOGNIZED in Java). Code must handle it.',
        });
      } else if (!a && b) {
        out.push({ where: `${where}: enum ${ce.name}`, severity: 'compatible', title: `Enum value ${b} = ${n} never produced`, detail: 'No impact on the wire.' });
      } else if (a && b && a !== b) {
        out.push({
          where: `${where}: enum ${ce.name}`,
          severity: 'compatible',
          title: `Enum value ${n} renamed: ${a} → ${b}`,
          detail: 'Enums travel as numbers: safe in binary, breaks JSON (which uses names).',
        });
      }
    }
  };

  const pm = ps.messages.get(pType);
  const cm = cs.messages.get(cType);
  if (pm && cm) cmpMessage(pm, cm, cShort(cType));
  return out;
}
