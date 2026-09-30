import protobuf from 'protobufjs';
import {
  SCALAR_TYPES,
  type EnumDef,
  type FieldDef,
  type MessageDef,
  type ScalarType,
  type Schema,
  type SchemaError,
} from './types';

const PACKABLE: ReadonlySet<string> = new Set([
  'double', 'float', 'int32', 'int64', 'uint32', 'uint64', 'sint32', 'sint64',
  'fixed32', 'fixed64', 'sfixed32', 'sfixed64', 'bool',
]);

export function isPackableType(type: string, kind: FieldDef['kind']): boolean {
  return kind === 'enum' || (kind === 'scalar' && PACKABLE.has(type));
}

/** Strip the leading dot and package to get something short for display. */
export function shortName(fullName: string, pkg = ''): string {
  let n = fullName.startsWith('.') ? fullName.slice(1) : fullName;
  if (pkg && n.startsWith(pkg + '.')) n = n.slice(pkg.length + 1);
  return n;
}

function kindOf(resolved: protobuf.ReflectionObject | null): FieldDef['kind'] {
  if (!resolved) return 'scalar';
  return resolved instanceof protobuf.Enum ? 'enum' : 'message';
}

export type ParseResult =
  | { ok: true; schema: Schema; warnings: string[] }
  | { ok: false; error: SchemaError };

export function parseSchema(source: string): ParseResult {
  let root: protobuf.Root;
  let parsed: protobuf.IParserResult;
  try {
    parsed = protobuf.parse(source, { keepCase: true, alternateCommentMode: true });
    root = parsed.root;
    root.resolveAll();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const m = /\(line (\d+)\)/.exec(msg);
    return {
      ok: false,
      error: { message: msg.replace(/\s*\(line \d+\)/, ''), line: m ? Number(m[1]) : undefined },
    };
  }

  const warnings: string[] = [];
  const syntaxMatch = /^\s*syntax\s*=\s*"(proto[23])"/m.exec(source);
  const editionMatch = /^\s*edition\s*=\s*"([^"]+)"/m.exec(source);
  const syntax = syntaxMatch?.[1] ?? (editionMatch ? `edition ${editionMatch[1]}` : 'proto2');
  if (syntax !== 'proto3') {
    warnings.push(
      syntaxMatch || editionMatch
        ? `This playground focuses on proto3 (found ${syntax}); presence rules follow the declared syntax.`
        : 'No `syntax = "proto3";` line: protoc would treat this file as proto2.',
    );
  }

  const messages = new Map<string, MessageDef>();
  const enums = new Map<string, EnumDef>();
  const messageNames: string[] = [];
  const pkg = parsed.package ?? '';

  const visit = (ns: protobuf.NamespaceBase) => {
    for (const obj of ns.nestedArray) {
      if (obj instanceof protobuf.Type) {
        messages.set(obj.fullName, convertType(obj));
        messageNames.push(obj.fullName);
        visit(obj);
      } else if (obj instanceof protobuf.Enum) {
        const byNumber = new Map<number, string>();
        for (const [k, v] of Object.entries(obj.values)) if (!byNumber.has(v)) byNumber.set(v, k);
        enums.set(obj.fullName, {
          kind: 'enum',
          name: obj.name,
          fullName: obj.fullName,
          values: { ...obj.values },
          byNumber,
        });
        if (syntax === 'proto3' && !byNumber.has(0)) {
          warnings.push(`enum ${obj.name}: the first value must be 0 in proto3.`);
        }
      } else if (obj instanceof protobuf.Namespace) {
        visit(obj);
      }
    }
  };

  const convertType = (t: protobuf.Type): MessageDef => {
    const fields: FieldDef[] = t.fieldsArray.map((f) => {
      const resolved = f.resolvedType;
      const kind = kindOf(resolved);
      const type = resolved ? resolved.fullName : f.type;
      const explicitOptional = Boolean(f.options && f.options.proto3_optional);
      const oneofName = f.partOf && !explicitOptional ? f.partOf.name : undefined;
      let map: FieldDef['map'];
      let displayType: string;
      if (f instanceof protobuf.MapField) {
        const valueKind = kind;
        map = { keyType: f.keyType as ScalarType, valueType: type, valueKind };
        displayType = `map<${f.keyType}, ${shortName(type, pkg)}>`;
      } else {
        displayType = shortName(type, pkg);
        if (f.repeated) displayType = `repeated ${displayType}`;
        else if (explicitOptional) displayType = `optional ${displayType}`;
      }
      const repeated = f.repeated && !map;
      const packed = repeated && isPackableType(type, kind) && f.packed;
      return {
        name: f.name,
        number: f.id,
        type,
        kind: map ? 'message' : kind,
        repeated,
        packed,
        hasPresence: !repeated && !map && (kind === 'message' || f.hasPresence),
        explicitOptional,
        oneof: oneofName,
        map,
        displayType,
      } satisfies FieldDef;
    });
    fields.sort((a, b) => a.number - b.number);
    for (const f of fields) {
      if (!f.map && f.kind === 'scalar' && !SCALAR_TYPES.has(f.type)) {
        warnings.push(`${t.name}.${f.name}: unsupported type ${f.type}.`);
      }
    }
    const reservedNumbers: [number, number][] = [];
    const reservedNames: string[] = [];
    for (const r of t.reserved ?? []) {
      if (typeof r === 'string') reservedNames.push(r);
      else reservedNumbers.push([r[0], r[1]]);
    }
    return {
      kind: 'message',
      name: t.name,
      fullName: t.fullName,
      fields,
      byNumber: new Map(fields.map((f) => [f.number, f])),
      byName: new Map(fields.map((f) => [f.name, f])),
      oneofs: t.oneofsArray
        .filter((o) => !o.fieldsArray.some((f) => f.options?.proto3_optional))
        .map((o) => ({ name: o.name, fields: o.oneof.slice() })),
      reservedNumbers,
      reservedNames,
    };
  };

  visit(root);

  if (messageNames.length === 0) {
    warnings.push('No message declared.');
  }

  return {
    ok: true,
    schema: { syntax, packageName: pkg, messages, enums, messageNames },
    warnings,
  };
}

/** Pick the consumer type matching the producer one by (short) name, else the first. */
export function matchTypeName(schema: Schema, wanted: string | undefined): string | undefined {
  if (!schema.messageNames.length) return undefined;
  if (wanted && schema.messages.has(wanted)) return wanted;
  if (wanted) {
    const simple = wanted.split('.').pop();
    const found = schema.messageNames.find((n) => n.split('.').pop() === simple);
    if (found) return found;
  }
  return schema.messageNames[0];
}
