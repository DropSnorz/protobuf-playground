/** Simplified, UI-friendly view of a parsed .proto file. */

export type ScalarType =
  | 'double' | 'float'
  | 'int32' | 'int64' | 'uint32' | 'uint64' | 'sint32' | 'sint64'
  | 'fixed32' | 'fixed64' | 'sfixed32' | 'sfixed64'
  | 'bool' | 'string' | 'bytes';

export const SCALAR_TYPES: ReadonlySet<string> = new Set<ScalarType>([
  'double', 'float', 'int32', 'int64', 'uint32', 'uint64', 'sint32', 'sint64',
  'fixed32', 'fixed64', 'sfixed32', 'sfixed64', 'bool', 'string', 'bytes',
]);

/** The four wire types still in use (3/4 = deprecated groups). */
export enum WireType {
  VARINT = 0,
  I64 = 1,
  LEN = 2,
  SGROUP = 3,
  EGROUP = 4,
  I32 = 5,
}

export const WIRE_TYPE_NAMES: Record<number, string> = {
  0: 'VARINT',
  1: 'I64',
  2: 'LEN',
  3: 'SGROUP',
  4: 'EGROUP',
  5: 'I32',
};

export interface EnumDef {
  kind: 'enum';
  name: string;
  fullName: string;
  /** name -> number */
  values: Record<string, number>;
  /** number -> first name declared with that number */
  byNumber: Map<number, string>;
}

export interface FieldDef {
  name: string;
  number: number;
  /** Scalar type name, or full name of message / enum (".pkg.Type"). */
  type: string;
  kind: 'scalar' | 'enum' | 'message';
  repeated: boolean;
  /** Only for repeated numeric scalars/enums. */
  packed: boolean;
  /** Tracks presence (proto3 `optional`, oneof member, message field). */
  hasPresence: boolean;
  /** proto3 `optional` keyword. */
  explicitOptional: boolean;
  oneof?: string;
  map?: {
    keyType: ScalarType;
    valueType: string;
    valueKind: 'scalar' | 'enum' | 'message';
  };
  /** Short, human readable type (e.g. `map<string, Address>`). */
  displayType: string;
}

export interface MessageDef {
  kind: 'message';
  name: string;
  fullName: string;
  fields: FieldDef[];
  byNumber: Map<number, FieldDef>;
  byName: Map<string, FieldDef>;
  oneofs: { name: string; fields: string[] }[];
  reservedNumbers: [number, number][];
  reservedNames: string[];
}

export interface Schema {
  syntax: string;
  packageName: string;
  messages: Map<string, MessageDef>;
  enums: Map<string, EnumDef>;
  /** Full names of top-level + nested messages, in declaration order. */
  messageNames: string[];
}

export interface SchemaError {
  message: string;
  line?: number;
}
