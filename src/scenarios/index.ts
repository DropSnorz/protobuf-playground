import type { Scenario } from './types';

export type { Scenario, Verdict } from './types';

const proto = (body: string) => `syntax = "proto3";\n\n${body.trim()}\n`;

export const CATEGORIES = [
  'Start here',
  'Wire format basics',
  'Presence & default values',
  'Collections & structure',
  'Evolution: safe changes',
  'Evolution: lossy changes',
  'Breaking changes',
  'Malformed & tricky bytes',
] as const;

const ORDER_PROTO = proto(`
package shop;

// Edit this schema, the message JSON, or the consumer schema on the right.
enum Status {
  STATUS_UNSPECIFIED = 0;
  PENDING = 1;
  PAID = 2;
  SHIPPED = 3;
}

message Customer {
  string name = 1;
  string email = 2;
}

message LineItem {
  string sku = 1;
  int32 quantity = 2;
  double unit_price = 3;
}

message Order {
  string id = 1;
  Customer customer = 2;
  repeated LineItem items = 3;
  Status status = 4;
  map<string, string> metadata = 5;
  int64 created_at = 6;
  bool gift = 7;
}
`);

export const SCENARIOS: Scenario[] = [
  // ───────────────────────────── Start here ─────────────────────────────
  {
    id: 'playground',
    category: 'Start here',
    title: 'Playground: an Order',
    verdict: 'learn',
    summary: 'A realistic message with nesting, repeated fields, an enum and a map.',
    description: [
      'The **producer** (left) serializes the JSON message with its `.proto`; the bytes travel over the wire; the **consumer** (right) parses them with *its own* `.proto`.',
      'Press **Play** to watch each field being turned into bytes and read back. Hover any byte to see what it means on both sides.',
      'Edit anything: the schemas, the message, or unlink the consumer schema to simulate a different version.',
    ],
    observe: [
      '`gift = false` is never written: it is the default value.',
      'Nested messages (`customer`, `items`) are length-prefixed blobs.',
      'The map is encoded as repeated `{key, value}` entries.',
    ],
    producer: { proto: ORDER_PROTO, type: '.shop.Order' },
    value: {
      id: 'ord-42',
      customer: { name: 'Ada', email: 'ada@example.com' },
      items: [
        { sku: 'BOOK-1', quantity: 2, unit_price: 12.5 },
        { sku: 'PEN', quantity: 10, unit_price: 0.99 },
      ],
      status: 'PAID',
      metadata: { channel: 'web' },
      created_at: '1767225600',
      gift: false,
    },
  },

  // ─────────────────────────── Wire format basics ───────────────────────
  {
    id: 'varint-150',
    category: 'Wire format basics',
    title: 'Varints: encoding 150',
    verdict: 'learn',
    summary: 'How an integer becomes 1–10 bytes.',
    description: [
      'The example from the official encoding guide: `a = 150` serializes to `08 96 01`.',
      '`08` is the **tag**: `(field_number << 3) | wire_type` = `(1 << 3) | 0`. Then 150 is a **varint**: split into 7-bit groups, least-significant group first, each byte having its high bit (MSB) set when more bytes follow.',
    ],
    observe: ['Step through: the varint worksheet shows the 7-bit groups and continuation bits.', 'Try 1, 127, 128, 300, 16384 and see the size change.'],
    producer: { proto: proto('message Test1 {\n  int32 a = 1;\n}'), type: '.Test1' },
    value: { a: 150 },
  },
  {
    id: 'tag-sizes',
    category: 'Wire format basics',
    title: 'Field numbers 1–15 are cheaper',
    verdict: 'learn',
    summary: 'The tag itself is a varint: big field numbers cost more bytes.',
    description: [
      'Every record starts with a tag = `(field_number << 3) | wire_type`, encoded as a varint.',
      'Field numbers 1–15 fit in **one** tag byte, 16–2047 need **two**, 2048–262143 need **three**. Reserve 1–15 for frequently-set fields.',
    ],
    observe: ['Compare the tag bytes of `f1`, `f15`, `f16`, `f2047` and `f2048`: all carry the value 1.'],
    producer: {
      proto: proto(`
message Tags {
  int32 f1 = 1;
  int32 f15 = 15;
  int32 f16 = 16;
  int32 f2047 = 2047;
  int32 f2048 = 2048;
}`),
      type: '.Tags',
    },
    value: { f1: 1, f15: 1, f16: 1, f2047: 1, f2048: 1 },
  },
  {
    id: 'negative-numbers',
    category: 'Wire format basics',
    title: 'Negative numbers: int32 vs sint32',
    verdict: 'learn',
    summary: 'int32 -1 costs 10 bytes; sint32 -1 costs 1 byte thanks to ZigZag.',
    description: [
      '`int32`/`int64` store negative numbers as 64-bit two\'s complement: the varint is **always 10 bytes**.',
      '`sint32`/`sint64` first apply **ZigZag** encoding (`0→0, -1→1, 1→2, -2→3…`) so small magnitudes stay small.',
    ],
    observe: ['`as_int32 = -1` → 10 value bytes.', '`as_sint32 = -1` → 1 byte (`01`), `as_sint32_pos = 1` → `02`.'],
    producer: {
      proto: proto(`
message Numbers {
  int32 as_int32 = 1;
  sint32 as_sint32 = 2;
  sint32 as_sint32_pos = 3;
  sint64 as_sint64 = 4;
  uint32 as_uint32 = 5;
}`),
      type: '.Numbers',
    },
    value: { as_int32: -1, as_sint32: -1, as_sint32_pos: 1, as_sint64: -64, as_uint32: 4294967295 },
  },
  {
    id: 'fixed-width',
    category: 'Wire format basics',
    title: 'Fixed-width: fixed32, float, double',
    verdict: 'learn',
    summary: 'I32 / I64 wire types: always 4 or 8 bytes, little-endian.',
    description: [
      '`fixed32`, `sfixed32` and `float` use wire type **I32** (5): exactly 4 bytes, little-endian. `fixed64`, `sfixed64` and `double` use **I64** (1): 8 bytes.',
      'Fixed types beat varints for large values (e.g. hashes, IDs > 2^28) and are cheaper to parse.',
    ],
    observe: ['`small = 1` takes 4 bytes as fixed32 (a varint would take 1).', 'Floating-point numbers follow IEEE 754: `0.1` is not exact.'],
    producer: {
      proto: proto(`
message Measure {
  fixed32 small = 1;
  fixed64 id = 2;
  sfixed32 offset = 3;
  float celsius = 4;
  double precise = 5;
}`),
      type: '.Measure',
    },
    value: { small: 1, id: '18000000000000000000', offset: -2, celsius: 21.5, precise: 0.1 },
  },
  {
    id: 'strings-bytes',
    category: 'Wire format basics',
    title: 'Strings & bytes (length-delimited)',
    verdict: 'learn',
    summary: 'LEN records: tag, length varint, raw payload.',
    description: [
      'Wire type **LEN** (2) is used for `string`, `bytes`, embedded messages and packed repeated fields: the tag is followed by a varint length, then that many bytes.',
      '`string` must be valid **UTF-8**: non-ASCII characters take 2–4 bytes. `bytes` in JSON are base64.',
    ],
    observe: ['`"héllo 𝄞"` is 7 characters but 11 bytes (é takes 2 bytes, 𝄞 takes 4).', '`bytes` payload `3q2+7w==` is `DE AD BE EF`.'],
    producer: {
      proto: proto(`
message Text {
  string ascii = 1;
  string unicode = 2;
  bytes raw = 3;
}`),
      type: '.Text',
    },
    value: { ascii: 'hi', unicode: 'héllo 𝄞', raw: '3q2+7w==' },
  },
  {
    id: 'field-order',
    category: 'Wire format basics',
    title: 'Field order on the wire does not matter',
    verdict: 'learn',
    summary: 'Records may arrive in any order; parsers must accept it.',
    description: [
      'Serializers usually write fields in field-number order, but parsers must accept **any order**, for example when messages are concatenated or a proxy appends fields.',
      'Here the bytes were hand-crafted with field 2 before field 1.',
    ],
    observe: ['The consumer reads `name` first, then `id`, and the result is the same.'],
    producer: { proto: proto('message User {\n  int32 id = 1;\n  string name = 2;\n}'), type: '.User' },
    value: { id: 7, name: 'hi' },
    wireHex: '12 02 68 69 08 07',
  },
  {
    id: 'empty-message',
    category: 'Wire format basics',
    title: 'An all-default message is 0 bytes',
    verdict: 'learn',
    summary: 'Nothing set → nothing written.',
    description: [
      'In proto3, fields holding their default value (0, "", false, first enum value, empty list) are not serialized. A message where everything is default serializes to **zero bytes**, and that is a valid message.',
    ],
    observe: ['Every field is skipped.', 'The consumer still reads a valid message with all defaults.'],
    producer: {
      proto: proto(`
enum Level { LEVEL_UNSPECIFIED = 0; LOW = 1; }
message Settings {
  int32 retries = 1;
  string label = 2;
  bool enabled = 3;
  Level level = 4;
  repeated string hosts = 5;
}`),
      type: '.Settings',
    },
    value: { retries: 0, label: '', enabled: false, level: 'LEVEL_UNSPECIFIED', hosts: [] },
  },

  // ───────────────────────── Presence & default values ─────────────────────────
  {
    id: 'defaults-not-sent',
    category: 'Presence & default values',
    title: 'Default values are not sent',
    verdict: 'learn',
    summary: 'Implicit presence: 0 and "not set" look identical.',
    description: [
      'Plain proto3 scalar fields have **implicit presence**: the serializer writes them only if they differ from the default.',
      'As a result, the consumer cannot know whether `stock = 0` was sent explicitly or never set.',
    ],
    observe: ['`stock`, `discount` and `archived` are skipped by the producer.', 'The consumer shows them as *default*.'],
    producer: {
      proto: proto(`
message Product {
  string name = 1;
  int32 stock = 2;
  double discount = 3;
  bool archived = 4;
}`),
      type: '.Product',
    },
    value: { name: 'Lamp', stock: 0, discount: 0, archived: false },
  },
  {
    id: 'optional-presence',
    category: 'Presence & default values',
    title: 'proto3 `optional`: explicit presence',
    verdict: 'learn',
    summary: '`optional` fields are written even when zero, and have has_xxx().',
    description: [
      'Since protobuf 3.15, `optional` brings back **explicit presence**: the field is written whenever it is *set*, even to 0, and the consumer gets a `has_stock()` accessor.',
      'Under the hood `optional int32 stock` is a synthetic one-field oneof.',
    ],
    observe: ['`stock = 0` **is** written (tag + `00`) because it is `optional`.', '`legacy_stock = 0` is skipped.', 'Unset `optional` fields show as *not set*, not as 0.'],
    producer: {
      proto: proto(`
message Product {
  string name = 1;
  optional int32 stock = 2;
  int32 legacy_stock = 3;
  optional string note = 4;
}`),
      type: '.Product',
    },
    value: { name: 'Lamp', stock: 0, legacy_stock: 0 },
  },
  {
    id: 'presence-mismatch',
    category: 'Presence & default values',
    title: 'Producer without presence, consumer with `optional`',
    verdict: 'caution',
    summary: 'The consumer checks has_discount(), but the producer never sent the 0.',
    description: [
      'The producer uses a plain `int32 discount` and sets it to 0 → nothing on the wire. The consumer, newer, declares `optional int32 discount` and relies on `has_discount()` to tell "no discount" from "0%".',
      'Adding `optional` is wire-compatible, but presence information only exists if the **producer** tracks it.',
    ],
    observe: ['The consumer sees `discount` as *not set*, although the producer set it explicitly to 0.'],
    producer: { proto: proto('message Offer {\n  string code = 1;\n  int32 discount = 2;\n}'), type: '.Offer', label: 'v1' },
    consumer: { proto: proto('message Offer {\n  string code = 1;\n  optional int32 discount = 2;\n}'), type: '.Offer', label: 'v2' },
    value: { code: 'SUMMER', discount: 0 },
  },
  {
    id: 'negative-zero',
    category: 'Presence & default values',
    title: '-0.0 is not the default',
    verdict: 'learn',
    summary: 'Presence is checked on the bits, not on numeric equality.',
    description: [
      'For `float`/`double`, proto3 compares the **bit pattern** with zero. `-0.0 == 0.0` numerically, but its sign bit is set, so it is serialized.',
    ],
    observe: ['`zero` is skipped, `minus_zero` is written as `00 00 00 00 00 00 00 80`.'],
    producer: { proto: proto('message Temp {\n  double zero = 1;\n  double minus_zero = 2;\n}'), type: '.Temp' },
    value: { zero: 0, minus_zero: -0 },
  },
  {
    id: 'empty-submessage',
    category: 'Presence & default values',
    title: 'An empty sub-message is still sent',
    verdict: 'learn',
    summary: 'Message fields always have presence.',
    description: [
      'Sub-message fields always track presence. Setting `shipping` to an empty object still writes the record (tag + length `00`), so the consumer knows it is present.',
    ],
    observe: ['`shipping = {}` → 2 bytes: `12 00`.', '`billing` is not set: nothing written, consumer sees *not set*.'],
    producer: {
      proto: proto(`
message Address { string city = 1; }
message Checkout {
  string id = 1;
  Address shipping = 2;
  Address billing = 3;
}`),
      type: '.Checkout',
    },
    value: { id: 'c1', shipping: {} },
  },

  // ───────────────────────── Collections & structure ─────────────────────────
  {
    id: 'packed-vs-unpacked',
    category: 'Collections & structure',
    title: 'Repeated: packed vs unpacked',
    verdict: 'learn',
    summary: 'proto3 packs repeated numbers by default.',
    description: [
      'Repeated scalar numeric fields are **packed** by default in proto3: one tag, one length, then all values back to back.',
      'With `[packed = false]` each element gets its own tag.',
    ],
    observe: ['Same 4 values: packed = 1 tag + 1 length + 5 value bytes; unpacked = 4 tags + 5 value bytes.'],
    producer: {
      proto: proto(`
message Series {
  repeated int32 packed_values = 1;
  repeated int32 unpacked_values = 2 [packed = false];
}`),
      type: '.Series',
    },
    value: { packed_values: [1, 2, 3, 300], unpacked_values: [1, 2, 3, 300] },
  },
  {
    id: 'repeated-strings-messages',
    category: 'Collections & structure',
    title: 'Repeated strings & messages',
    verdict: 'learn',
    summary: 'Length-delimited elements can never be packed.',
    description: ['`string`, `bytes` and message elements are each written as a separate LEN record with the same tag.'],
    observe: ['The tag `0A` appears once per tag string, `12` once per item.'],
    producer: {
      proto: proto(`
message Item { string name = 1; int32 qty = 2; }
message Cart {
  repeated string tags = 1;
  repeated Item items = 2;
}`),
      type: '.Cart',
    },
    value: { tags: ['promo', 'vip'], items: [{ name: 'apple', qty: 3 }, { name: 'pear' }] },
  },
  {
    id: 'deep-nesting',
    category: 'Collections & structure',
    title: 'Nested messages (4 levels)',
    verdict: 'learn',
    summary: 'Length prefixes all the way down.',
    description: [
      'An embedded message is serialized *first*, then written as a LEN record. Each level adds a tag and a length prefix.',
      'That is why nested length prefixes must be computed bottom-up by the serializer.',
    ],
    observe: ['Follow the nested lengths: each one covers all the bytes of the levels below.'],
    producer: {
      proto: proto(`
message Company {
  string name = 1;
  Department dept = 2;
}
message Department {
  string title = 1;
  Employee lead = 2;
}
message Employee {
  string name = 1;
  Address home = 2;
}
message Address {
  string city = 1;
  int32 zip = 2;
}`),
      type: '.Company',
    },
    value: { name: 'Acme', dept: { title: 'R&D', lead: { name: 'Lin', home: { city: 'Oslo', zip: 150 } } } },
  },
  {
    id: 'recursive-tree',
    category: 'Collections & structure',
    title: 'Recursive message: a tree',
    verdict: 'learn',
    summary: 'A message can contain itself.',
    description: ['Recursive types work: each child is another embedded LEN record. Parsers enforce a recursion limit (100 by default in C++/Java).'],
    observe: ['The same tag `12` (children) appears at several depths.'],
    producer: {
      proto: proto(`
message TreeNode {
  string name = 1;
  repeated TreeNode children = 2;
}`),
      type: '.TreeNode',
    },
    value: { name: 'root', children: [{ name: 'a', children: [{ name: 'a1' }] }, { name: 'b' }] },
  },
  {
    id: 'maps',
    category: 'Collections & structure',
    title: 'Maps are repeated entries',
    verdict: 'learn',
    summary: '`map<K,V>` = `repeated Entry { K key = 1; V value = 2; }`.',
    description: [
      'Maps have no wire type of their own. Each entry is a LEN record containing a tiny message with `key` = field 1 and `value` = field 2.',
      'Order is not preserved and duplicate keys resolve to the last one.',
    ],
    observe: ['Each entry repeats the map field tag.', 'Message values are nested one level deeper.'],
    producer: {
      proto: proto(`
message Product { string name = 1; double price = 2; }
message Inventory {
  map<string, int32> stock = 1;
  map<int32, Product> catalog = 2;
}`),
      type: '.Inventory',
    },
    value: { stock: { apple: 12, pear: 3 }, catalog: { '7': { name: 'Lamp', price: 19.9 } } },
  },
  {
    id: 'oneof',
    category: 'Collections & structure',
    title: 'Oneof',
    verdict: 'learn',
    summary: 'At most one member is set, and it is written even when zero.',
    description: [
      'A `oneof` is a set of fields where at most one can be set. On the wire the members are ordinary fields; the *parser* clears the others when one is read.',
      'Oneof members have presence: `cash = false` is still written because it is the active case.',
    ],
    observe: ['`cash = false` is written as `20 00`.', 'Try setting two members in the JSON: the producer refuses.'],
    producer: {
      proto: proto(`
message Card { string number = 1; int32 cvv = 2; }
message Payment {
  int64 amount_cents = 1;
  oneof method {
    Card card = 2;
    string iban = 3;
    bool cash = 4;
  }
}`),
      type: '.Payment',
    },
    value: { amount_cents: 1999, cash: false },
  },
  {
    id: 'multiple-types',
    category: 'Collections & structure',
    title: 'Several message types in one file',
    verdict: 'learn',
    summary: 'Pick which message to serialize. The bytes never say which type they are.',
    description: [
      'A `.proto` file usually declares many messages and enums, including nested types (`Event.Kind`) and shared ones.',
      'Use the **type selector** above the editors to choose the root message on each side. Nothing on the wire identifies the type: sender and receiver must agree out-of-band (topic, RPC method, `Any` type URL…).',
    ],
    observe: ['Switch the producer to `Heartbeat` and edit the JSON accordingly.', 'Nested enum `Event.Kind` is referenced from the outer message.'],
    producer: {
      proto: proto(`
package events;

message Meta {
  string source = 1;
  int64 timestamp = 2;
}

message Event {
  enum Kind { KIND_UNSPECIFIED = 0; CREATED = 1; DELETED = 2; }
  Meta meta = 1;
  Kind kind = 2;
  string entity_id = 3;
}

message Heartbeat {
  Meta meta = 1;
  uint32 sequence = 2;
}

message Envelope {
  repeated Event events = 1;
  Heartbeat last_heartbeat = 2;
}`),
      type: '.events.Envelope',
    },
    value: {
      events: [
        { meta: { source: 'api', timestamp: '1700000000' }, kind: 'CREATED', entity_id: 'u-1' },
        { kind: 'DELETED', entity_id: 'u-2' },
      ],
      last_heartbeat: { sequence: 42 },
    },
  },

  // ───────────────────────── Evolution: safe ─────────────────────────
  {
    id: 'new-field-old-consumer',
    category: 'Evolution: safe changes',
    title: 'New field, old consumer',
    verdict: 'compatible',
    summary: 'Forward compatibility: unknown fields are skipped and preserved.',
    description: [
      'The producer (v2) added `phone = 4`. The consumer (v1) does not know field 4.',
      'The wire type tells the parser how many bytes to skip. Since protobuf 3.5, unknown fields are **kept** and re-emitted if the consumer re-serializes the message (important for proxies).',
    ],
    observe: ['Field #4 shows up as an **unknown field** on the consumer side.', 'All other fields decode normally.'],
    producer: {
      proto: proto(`
message Contact {
  int32 id = 1;
  string name = 2;
  string email = 3;
  string phone = 4; // added in v2
}`),
      type: '.Contact',
      label: 'v2',
    },
    consumer: {
      proto: proto(`
message Contact {
  int32 id = 1;
  string name = 2;
  string email = 3;
}`),
      type: '.Contact',
      label: 'v1',
    },
    value: { id: 1, name: 'Ada', email: 'ada@example.com', phone: '+33 6 12 34 56 78' },
  },
  {
    id: 'new-field-old-producer',
    category: 'Evolution: safe changes',
    title: 'New field, old producer',
    verdict: 'compatible',
    summary: 'Backward compatibility: missing fields read as defaults.',
    description: [
      'The consumer (v2) expects `phone = 4` and `loyalty_points = 5`; the producer (v1) never sends them.',
      'They read as their defaults. Make sure your code treats the default as "unknown / not provided" when that matters, or use `optional`.',
    ],
    observe: ['`phone` → `""`, `loyalty_points` → *not set* (it is `optional`).'],
    producer: {
      proto: proto(`
message Contact {
  int32 id = 1;
  string name = 2;
  string email = 3;
}`),
      type: '.Contact',
      label: 'v1',
    },
    consumer: {
      proto: proto(`
message Contact {
  int32 id = 1;
  string name = 2;
  string email = 3;
  string phone = 4;
  optional int32 loyalty_points = 5;
}`),
      type: '.Contact',
      label: 'v2',
    },
    value: { id: 1, name: 'Ada', email: 'ada@example.com' },
  },
  {
    id: 'renamed-field',
    category: 'Evolution: safe changes',
    title: 'Renamed field (same number)',
    verdict: 'compatible',
    summary: 'Only field numbers are on the wire, not names.',
    description: [
      'The consumer renamed `user_name` to `login`. The binary format only carries field **numbers**, so nothing changes on the wire.',
      'Renaming still breaks the JSON mapping and anything that uses field names (FieldMasks, reflection-based code).',
    ],
    observe: ['Field #2 is read into `login`.'],
    producer: { proto: proto('message Account {\n  int32 id = 1;\n  string user_name = 2;\n}'), type: '.Account', label: 'v1' },
    consumer: { proto: proto('message Account {\n  int32 id = 1;\n  string login = 2;\n}'), type: '.Account', label: 'v2' },
    value: { id: 9, user_name: 'ada' },
  },
  {
    id: 'removed-reserved',
    category: 'Evolution: safe changes',
    title: 'Removed field + `reserved`',
    verdict: 'compatible',
    summary: 'Delete fields safely by reserving their number and name.',
    description: [
      'The consumer deleted `fax` and marked `reserved 3; reserved "fax";` so nobody can reuse number 3 with a different meaning later.',
      'Old producers still send #3: it becomes an unknown field.',
    ],
    observe: ['Field #3 is flagged as unknown **and reserved** on the consumer side.'],
    producer: {
      proto: proto(`
message Contact {
  int32 id = 1;
  string name = 2;
  string fax = 3;
}`),
      type: '.Contact',
      label: 'old',
    },
    consumer: {
      proto: proto(`
message Contact {
  reserved 3;
  reserved "fax";
  int32 id = 1;
  string name = 2;
}`),
      type: '.Contact',
      label: 'new',
    },
    value: { id: 1, name: 'Ada', fax: '+1 555 0100' },
  },
  {
    id: 'packed-unpacked-compat',
    category: 'Evolution: safe changes',
    title: 'Packed to unpacked',
    verdict: 'compatible',
    summary: 'Parsers accept both encodings of repeated numbers.',
    description: [
      'The producer uses `[packed = false]` (e.g. an old proto2-era writer), the consumer the proto3 default (packed).',
      'Parsers are required to accept both forms, so toggling `packed` is safe.',
    ],
    observe: ['Three separate records on the wire, merged into one list by the consumer.'],
    producer: { proto: proto('message Samples {\n  repeated sint32 values = 1 [packed = false];\n}'), type: '.Samples', label: 'legacy' },
    consumer: { proto: proto('message Samples {\n  repeated sint32 values = 1;\n}'), type: '.Samples', label: 'new' },
    value: { values: [-1, 0, 64] },
  },
  {
    id: 'int32-to-int64',
    category: 'Evolution: safe changes',
    title: 'Widening int32 → int64',
    verdict: 'compatible',
    summary: 'Same varint encoding: widening is safe.',
    description: [
      '`int32`, `uint32`, `int64`, `uint64` and `bool` share the VARINT wire type. Widening from 32 to 64 bits is always safe, including for negative numbers, because `int32` already sign-extends to 64 bits.',
    ],
    observe: ['`-5` survives because it was written as a 10-byte, 64-bit two\'s complement.'],
    producer: { proto: proto('message Balance {\n  int32 cents = 1;\n  int32 delta = 2;\n}'), type: '.Balance', label: 'v1' },
    consumer: { proto: proto('message Balance {\n  int64 cents = 1;\n  int64 delta = 2;\n}'), type: '.Balance', label: 'v2' },
    value: { cents: 2000000000, delta: -5 },
  },
  {
    id: 'singular-to-repeated',
    category: 'Evolution: safe changes',
    title: 'Singular → repeated',
    verdict: 'compatible',
    summary: 'A single value arrives as a one-element list.',
    description: [
      'Turning `string tag` into `repeated string tags` (same number) is compatible: a repeated field is the same record appearing several times.',
    ],
    observe: ['The consumer gets `tags = ["urgent"]`.'],
    producer: { proto: proto('message Ticket {\n  string title = 1;\n  string tag = 2;\n}'), type: '.Ticket', label: 'v1' },
    consumer: { proto: proto('message Ticket {\n  string title = 1;\n  repeated string tags = 2;\n}'), type: '.Ticket', label: 'v2' },
    value: { title: 'Printer on fire', tag: 'urgent' },
  },
  {
    id: 'message-renamed',
    category: 'Evolution: safe changes',
    title: 'Message type renamed',
    verdict: 'compatible',
    summary: 'Type names are not on the wire either.',
    description: [
      'The consumer calls the message `Account` and the nested type `Money` instead of `UserProfile` / `Amount`. Binary serialization does not care.',
      'Type names do matter for `google.protobuf.Any` (type URL) and gRPC service paths.',
    ],
    observe: ['Pick `Account` as consumer type: everything decodes.'],
    producer: {
      proto: proto(`
package crm;
message Amount { int64 units = 1; string currency = 2; }
message UserProfile {
  string name = 1;
  Amount balance = 2;
}`),
      type: '.crm.UserProfile',
      label: 'team A',
    },
    consumer: {
      proto: proto(`
package billing;
message Money { int64 units = 1; string currency = 2; }
message Account {
  string holder = 1;
  Money balance = 2;
}`),
      type: '.billing.Account',
      label: 'team B',
    },
    value: { name: 'Ada', balance: { units: '120', currency: 'EUR' } },
  },
  {
    id: 'string-bytes',
    category: 'Evolution: safe changes',
    title: 'string → bytes',
    verdict: 'compatible',
    summary: 'Both are LEN: bytes receives the raw UTF-8.',
    description: ['`string` and `bytes` are both length-delimited. A `bytes` consumer gets the raw UTF-8 bytes. The opposite direction only works for valid UTF-8 (see the breaking changes).'],
    observe: ['`é` shows up as `C3 A9` on the consumer side.'],
    producer: { proto: proto('message Doc {\n  string body = 1;\n}'), type: '.Doc', label: 'text' },
    consumer: { proto: proto('message Doc {\n  bytes body = 1;\n}'), type: '.Doc', label: 'binary' },
    value: { body: 'café' },
  },
  {
    id: 'message-as-bytes',
    category: 'Evolution: safe changes',
    title: 'Embedded message read as `bytes`',
    verdict: 'compatible',
    summary: 'Envelope pattern: forward a payload without parsing it.',
    description: [
      'An embedded message is plain LEN bytes. A router can declare the payload as `bytes` and forward it untouched, without depending on the payload schema. This is the common *envelope* pattern.',
    ],
    observe: ['The router sees `payload` as opaque bytes, identical to the serialized `Order`.'],
    producer: {
      proto: proto(`
message Order { string id = 1; int32 qty = 2; }
message Envelope {
  string topic = 1;
  Order payload = 2;
}`),
      type: '.Envelope',
      label: 'service',
    },
    consumer: { proto: proto('message Envelope {\n  string topic = 1;\n  bytes payload = 2;\n}'), type: '.Envelope', label: 'router' },
    value: { topic: 'orders', payload: { id: 'A1', qty: 3 } },
  },
  {
    id: 'map-as-repeated',
    category: 'Evolution: safe changes',
    title: 'map to repeated entry message',
    verdict: 'compatible',
    summary: 'A map is wire-identical to a repeated key/value message.',
    description: [
      'The consumer declares `repeated LabelsEntry labels` with `string key = 1; string value = 2;`, which is how a map is encoded on the wire.',
      'Useful for languages or tools without map support, or to keep duplicate keys and order.',
    ],
    observe: ['Entries arrive as list items with `key` and `value` fields.'],
    producer: { proto: proto('message Pod {\n  string name = 1;\n  map<string, string> labels = 2;\n}'), type: '.Pod', label: 'map' },
    consumer: {
      proto: proto(`
message LabelsEntry {
  string key = 1;
  string value = 2;
}
message Pod {
  string name = 1;
  repeated LabelsEntry labels = 2;
}`),
      type: '.Pod',
      label: 'list',
    },
    value: { name: 'web-1', labels: { app: 'web', tier: 'front' } },
  },

  // ───────────────────────── Evolution: lossy ─────────────────────────
  {
    id: 'new-enum-value',
    category: 'Evolution: lossy changes',
    title: 'New enum value, old consumer',
    verdict: 'caution',
    summary: 'proto3 enums are open: the unknown number is kept.',
    description: [
      'The producer added `REFUNDED = 4`. The old consumer does not know it.',
      'proto3 enums are **open**: the numeric value is preserved (Java: `UNRECOGNIZED` + `getStatusValue() == 4`, C++: plain int). Your `switch` needs a default branch!',
    ],
    observe: ['`status` decodes to the bare number `4` with a warning.'],
    producer: {
      proto: proto(`
enum Status {
  STATUS_UNSPECIFIED = 0;
  PENDING = 1;
  PAID = 2;
  SHIPPED = 3;
  REFUNDED = 4; // new
}
message Order {
  string id = 1;
  Status status = 2;
  repeated Status history = 3;
}`),
      type: '.Order',
      label: 'v2',
    },
    consumer: {
      proto: proto(`
enum Status {
  STATUS_UNSPECIFIED = 0;
  PENDING = 1;
  PAID = 2;
  SHIPPED = 3;
}
message Order {
  string id = 1;
  Status status = 2;
  repeated Status history = 3;
}`),
      type: '.Order',
      label: 'v1',
    },
    value: { id: 'o-1', status: 'REFUNDED', history: ['PENDING', 'PAID', 'REFUNDED'] },
  },
  {
    id: 'enum-renamed',
    category: 'Evolution: lossy changes',
    title: 'Enum value renamed',
    verdict: 'compatible',
    summary: 'Enums travel as numbers.',
    description: ['Renaming `SHIPPED` to `DISPATCHED` is binary-safe (the number 3 is sent), but breaks JSON, which uses names.'],
    observe: ['The consumer reads 3 as `DISPATCHED`.'],
    producer: { proto: proto('enum Status { STATUS_UNSPECIFIED = 0; SHIPPED = 3; }\nmessage Parcel {\n  Status status = 1;\n}'), type: '.Parcel', label: 'v1' },
    consumer: { proto: proto('enum Status { STATUS_UNSPECIFIED = 0; DISPATCHED = 3; }\nmessage Parcel {\n  Status status = 1;\n}'), type: '.Parcel', label: 'v2' },
    value: { status: 'SHIPPED' },
  },
  {
    id: 'int64-to-int32',
    category: 'Evolution: lossy changes',
    title: 'Narrowing int64 → int32',
    verdict: 'caution',
    summary: 'Parses fine, silently truncates to 32 bits.',
    description: [
      'Same VARINT wire type, so there is no error. The consumer keeps only the lower 32 bits, like a C cast.',
    ],
    observe: ['`4294967297` (2^32 + 1) becomes `1`.', '`3000000000` becomes negative.', '`42` is fine.'],
    producer: { proto: proto('message Stats {\n  int64 views = 1;\n  int64 bytes_sent = 2;\n  int64 likes = 3;\n}'), type: '.Stats', label: 'v2' },
    consumer: { proto: proto('message Stats {\n  int32 views = 1;\n  int32 bytes_sent = 2;\n  int32 likes = 3;\n}'), type: '.Stats', label: 'v1' },
    value: { views: '4294967297', bytes_sent: '3000000000', likes: 42 },
  },
  {
    id: 'uint-int-sign',
    category: 'Evolution: lossy changes',
    title: 'uint32 to int32: sign flip',
    verdict: 'caution',
    summary: 'Values ≥ 2^31 come out negative.',
    description: ['`uint32 4294967295` has the same 32 low bits as `int32 -1`. The consumer reinterprets them as signed.'],
    observe: ['`mask` becomes `-1`, `small` stays `10`.'],
    producer: { proto: proto('message Flags {\n  uint32 mask = 1;\n  uint32 small = 2;\n}'), type: '.Flags', label: 'unsigned' },
    consumer: { proto: proto('message Flags {\n  int32 mask = 1;\n  int32 small = 2;\n}'), type: '.Flags', label: 'signed' },
    value: { mask: 4294967295, small: 10 },
  },
  {
    id: 'int-to-bool',
    category: 'Evolution: lossy changes',
    title: 'int32 → bool',
    verdict: 'caution',
    summary: 'Any non-zero varint is `true`.',
    description: ['`bool` is a VARINT too. A count of 42 becomes `true`; the number is lost. A count of 0 was never sent, so it reads as `false`.'],
    observe: ['`retries = 42` → `true` (with a warning).'],
    producer: { proto: proto('message Job {\n  int32 retries = 1;\n}'), type: '.Job', label: 'v1' },
    consumer: { proto: proto('message Job {\n  bool retries = 1;\n}'), type: '.Job', label: 'v2' },
    value: { retries: 42 },
  },
  {
    id: 'repeated-to-singular',
    category: 'Evolution: lossy changes',
    title: 'repeated → singular: last one wins',
    verdict: 'caution',
    summary: 'Only the last element survives (messages: merged).',
    description: [
      'The consumer declares `string email` where the producer sends `repeated string emails`. Each element is a separate record; for a singular field every new record **overwrites** the previous one.',
      'For a singular *message* field, the records would be **merged** instead.',
    ],
    observe: ['The consumer ends up with the last address only, with "last value wins" warnings.'],
    producer: { proto: proto('message User {\n  repeated string emails = 1;\n}'), type: '.User', label: 'v2' },
    consumer: { proto: proto('message User {\n  string email = 1;\n}'), type: '.User', label: 'v1' },
    value: { emails: ['a@x.io', 'b@x.io', 'c@x.io'] },
  },
  {
    id: 'into-oneof',
    category: 'Evolution: lossy changes',
    title: 'Moving existing fields into a oneof',
    verdict: 'caution',
    summary: 'If several were set, only the last survives.',
    description: [
      'The producer has two independent fields; the consumer grouped them into `oneof contact`. When the producer sets both, the consumer keeps **only the last one on the wire**.',
    ],
    observe: ['`phone` clears `email` on the consumer side.'],
    producer: { proto: proto('message Person {\n  string email = 1;\n  string phone = 2;\n}'), type: '.Person', label: 'v1' },
    consumer: { proto: proto('message Person {\n  oneof contact {\n    string email = 1;\n    string phone = 2;\n  }\n}'), type: '.Person', label: 'v2' },
    value: { email: 'ada@example.com', phone: '+1 555 0100' },
  },

  // ───────────────────────── Breaking changes ─────────────────────────
  {
    id: 'renumbered',
    category: 'Breaking changes',
    title: 'Changed field number',
    verdict: 'breaking',
    summary: 'Same name, different number → data lost.',
    description: [
      'Someone "tidied up" the numbers: `email` went from 3 to 4. The consumer looks for #4, the producer writes #3.',
      'Field numbers are the contract. **Never change them.**',
    ],
    observe: ['#3 is an unknown field; `email` reads as `""`.'],
    producer: { proto: proto('message Contact {\n  int32 id = 1;\n  string name = 2;\n  string email = 3;\n}'), type: '.Contact', label: 'v1' },
    consumer: { proto: proto('message Contact {\n  int32 id = 1;\n  string name = 2;\n  string email = 4;\n}'), type: '.Contact', label: 'v2' },
    value: { id: 1, name: 'Ada', email: 'ada@example.com' },
  },
  {
    id: 'reused-number',
    category: 'Breaking changes',
    title: 'Reused field number, new type',
    verdict: 'breaking',
    summary: 'Wire type mismatch → value unreadable.',
    description: [
      '`age` (#3, int32) was deleted and #3 was reused for `nickname` (string) without being `reserved`. Old producers still send an int at #3.',
      'VARINT ≠ LEN: the consumer cannot interpret the record. C++/Java keep it as an unknown field; some libraries throw.',
    ],
    observe: ['The record #3 shows a **wire type mismatch**.', 'Use `reserved 3;` when deleting a field to prevent this.'],
    producer: { proto: proto('message Profile {\n  int32 id = 1;\n  string name = 2;\n  int32 age = 3;\n}'), type: '.Profile', label: 'old' },
    consumer: { proto: proto('message Profile {\n  int32 id = 1;\n  string name = 2;\n  string nickname = 3;\n}'), type: '.Profile', label: 'new' },
    value: { id: 1, name: 'Ada', age: 36 },
  },
  {
    id: 'zigzag-mismatch',
    category: 'Breaking changes',
    title: 'int32 to sint32: ZigZag mismatch',
    verdict: 'breaking',
    summary: 'Same wire type, silently wrong values.',
    description: [
      'Both are VARINT, so the parser accepts the values, but `sint32` expects ZigZag encoding. `1` becomes `-1`, `2` becomes `1`, and `-1` (10 bytes of 1s) becomes `-2147483648`.',
      'No error is raised, so the wrong values go unnoticed.',
    ],
    observe: ['Compare producer and consumer values field by field.'],
    producer: { proto: proto('message Delta {\n  int32 a = 1;\n  int32 b = 2;\n  int32 c = 3;\n}'), type: '.Delta', label: 'int32' },
    consumer: { proto: proto('message Delta {\n  sint32 a = 1;\n  sint32 b = 2;\n  sint32 c = 3;\n}'), type: '.Delta', label: 'sint32' },
    value: { a: 1, b: 2, c: -1 },
  },
  {
    id: 'float-fixed32',
    category: 'Breaking changes',
    title: 'float to fixed32: reinterpreted bits',
    verdict: 'breaking',
    summary: 'Same 4 bytes, completely different number.',
    description: ['Both are I32: 4 little-endian bytes. The consumer reads the IEEE-754 bits of `1.5` as an unsigned integer.'],
    observe: ['`1.5` becomes `1069547520`.'],
    producer: { proto: proto('message Reading {\n  float value = 1;\n}'), type: '.Reading', label: 'float' },
    consumer: { proto: proto('message Reading {\n  fixed32 value = 1;\n}'), type: '.Reading', label: 'fixed32' },
    value: { value: 1.5 },
  },
  {
    id: 'string-to-message',
    category: 'Breaking changes',
    title: 'string → message',
    verdict: 'breaking',
    summary: 'The text is parsed as protobuf… and fails.',
    description: [
      'Both are LEN, so the consumer tries to parse the UTF-8 text `"hello"` as a `Note` message. `h` = `0x68` = field 13, VARINT; `e`… until `l` = `0x6C` → wire type 4, an invalid group end.',
      'Other text may parse without error and produce wrong fields, which is harder to detect.',
    ],
    observe: ['Parsing fails inside the nested message: the **whole** message is rejected.'],
    producer: { proto: proto('message Post {\n  int32 id = 1;\n  string note = 2;\n}'), type: '.Post', label: 'v1' },
    consumer: { proto: proto('message Note {\n  string text = 1;\n}\nmessage Post {\n  int32 id = 1;\n  Note note = 2;\n}'), type: '.Post', label: 'v2' },
    value: { id: 1, note: 'hello' },
    expect: 'fail',
  },
  {
    id: 'bytes-to-string',
    category: 'Breaking changes',
    title: 'bytes → string with binary data',
    verdict: 'breaking',
    summary: 'Invalid UTF-8 in a proto3 string → parse failure.',
    description: [
      'The producer sends arbitrary binary in a `bytes` field; the consumer declared it as `string`. proto3 parsers validate UTF-8 for `string` fields and reject the message.',
    ],
    observe: ['`FF FE` is not valid UTF-8: the parse fails.'],
    producer: { proto: proto('message Blob {\n  string name = 1;\n  bytes data = 2;\n}'), type: '.Blob', label: 'bytes' },
    consumer: { proto: proto('message Blob {\n  string name = 1;\n  string data = 2;\n}'), type: '.Blob', label: 'string' },
    value: { name: 'img', data: '//4A' },
    expect: 'fail',
  },
  {
    id: 'repeated-num-to-singular',
    category: 'Breaking changes',
    title: 'Packed repeated → singular number',
    verdict: 'breaking',
    summary: 'Packed LEN record vs expected VARINT.',
    description: [
      'The producer packs `repeated int32 scores` into one LEN record. The consumer declares `int32 score` and expects VARINT → wire type mismatch, the values are lost for it.',
      '(An *unpacked* list would have worked, keeping the last value.)',
    ],
    observe: ['Record #1 is a LEN record: mismatch, treated as unknown.'],
    producer: { proto: proto('message Game {\n  repeated int32 scores = 1;\n}'), type: '.Game', label: 'v2' },
    consumer: { proto: proto('message Game {\n  int32 score = 1;\n}'), type: '.Game', label: 'v1' },
    value: { scores: [10, 20, 30] },
  },
  {
    id: 'enum-to-string',
    category: 'Breaking changes',
    title: 'enum → string',
    verdict: 'breaking',
    summary: 'VARINT vs LEN: unreadable.',
    description: ['An enum is a VARINT on the wire; a string is LEN. Changing between them breaks every existing message.'],
    observe: ['`status` is lost: mismatch → unknown field, consumer reads `""`.'],
    producer: { proto: proto('enum Status { STATUS_UNSPECIFIED = 0; ACTIVE = 1; }\nmessage Account {\n  Status status = 1;\n}'), type: '.Account', label: 'enum' },
    consumer: { proto: proto('message Account {\n  string status = 1;\n}'), type: '.Account', label: 'string' },
    value: { status: 'ACTIVE' },
  },
  {
    id: 'wrong-type',
    category: 'Breaking changes',
    title: 'Decoded with the wrong message type',
    verdict: 'breaking',
    summary: 'Parses "successfully" into nonsense.',
    description: [
      'Bytes carry no type information. A consumer reading a `UserCreated` event with the `PaymentDone` schema often gets **no error**, only wrong values and unknown fields.',
      'This happens with mis-routed Kafka topics or wrong gRPC stubs. Consider an envelope with a type discriminator or `google.protobuf.Any`.',
    ],
    observe: ['`user_id` string becomes `payment_id`, the age becomes an amount…'],
    producer: {
      proto: proto(`
message UserCreated {
  string user_id = 1;
  int32 age = 2;
  string email = 3;
}
message PaymentDone {
  string payment_id = 1;
  int64 amount_cents = 2;
  bool refunded = 4;
}`),
      type: '.UserCreated',
    },
    consumer: {
      proto: proto(`
message UserCreated {
  string user_id = 1;
  int32 age = 2;
  string email = 3;
}
message PaymentDone {
  string payment_id = 1;
  int64 amount_cents = 2;
  bool refunded = 4;
}`),
      type: '.PaymentDone',
    },
    value: { user_id: 'u-77', age: 36, email: 'ada@example.com' },
  },

  // ───────────────────────── Malformed & tricky bytes ─────────────────────────
  {
    id: 'last-wins',
    category: 'Malformed & tricky bytes',
    title: 'Duplicate scalar: last one wins',
    verdict: 'learn',
    summary: 'The same field twice → the later value overwrites.',
    description: ['Hand-crafted bytes contain `id` twice (`08 01` then `08 02`). For singular scalar fields the **last** value on the wire wins; no error.'],
    observe: ['`id` ends up as 2.'],
    producer: { proto: proto('message User {\n  int32 id = 1;\n  string name = 2;\n}'), type: '.User' },
    value: { id: 1, name: 'Ann' },
    wireHex: '08 01 12 03 41 6E 6E 08 02',
  },
  {
    id: 'concat-merge',
    category: 'Malformed & tricky bytes',
    title: 'Concatenated messages merge',
    verdict: 'learn',
    summary: 'serialize(A) + serialize(B) parses as merge(A, B).',
    description: [
      'Two serialized messages are concatenated: `{name: "Ann", tags: ["a"], address: {city: "Paris"}}` then `{tags: ["b"], address: {zip: 75}}`.',
      'Parsing the concatenation = **merging**: scalars overwritten, repeated fields appended, sub-messages merged recursively. This is why protobuf streams need length-delimiting.',
    ],
    observe: ['`tags = ["a", "b"]`, `address = {city: "Paris", zip: 75}`.'],
    producer: {
      proto: proto(`
message Address { string city = 1; int32 zip = 2; }
message Profile {
  string name = 1;
  repeated string tags = 2;
  Address address = 3;
}`),
      type: '.Profile',
    },
    value: { name: 'Ann', tags: ['a'], address: { city: 'Paris' } },
    wireHex: '0A 03 41 6E 6E 12 01 61 1A 07 0A 05 50 61 72 69 73   12 01 62 1A 02 10 4B',
  },
  {
    id: 'oneof-two-members',
    category: 'Malformed & tricky bytes',
    title: 'Oneof: two members on the wire',
    verdict: 'caution',
    summary: 'The parser keeps only the last member.',
    description: ['A buggy writer sent both `email` and `phone`, which belong to the same oneof. The parser does not fail: it keeps the last one read.'],
    observe: ['`phone` wins, `email` is cleared.'],
    producer: { proto: proto('message Person {\n  oneof contact {\n    string email = 1;\n    string phone = 2;\n  }\n}'), type: '.Person' },
    value: { email: 'a@b' },
    wireHex: '0A 03 61 40 62 12 03 35 35 35',
  },
  {
    id: 'map-duplicate-key',
    category: 'Malformed & tricky bytes',
    title: 'Map with a duplicate key',
    verdict: 'caution',
    summary: 'Last entry wins.',
    description: ['Two entries with key `"a"`. Maps keep the last value for a key.', 'The third entry is empty (`0A 00`): key and value take their defaults, giving an entry with key `""` and value 0.'],
    observe: ['`a → 2`, plus an entry `"" → 0`.'],
    producer: { proto: proto('message Counters {\n  map<string, int32> counts = 1;\n}'), type: '.Counters' },
    value: { counts: { a: 1 } },
    wireHex: '0A 05 0A 01 61 10 01   0A 05 0A 01 61 10 02   0A 00',
  },
  {
    id: 'non-canonical-varint',
    category: 'Malformed & tricky bytes',
    title: 'Over-long varint',
    verdict: 'learn',
    summary: 'Redundant continuation bytes are accepted.',
    description: ['`81 80 80 00` is a valid (but non-canonical) varint for 1: the extra groups are zeros. Parsers accept it; serializers never produce it. This is why byte-for-byte comparison of protobufs is unreliable.'],
    observe: ['`id = 1` read from 4 bytes.'],
    producer: { proto: proto('message User {\n  int32 id = 1;\n}'), type: '.User' },
    value: { id: 1 },
    wireHex: '08 81 80 80 00',
  },
  {
    id: 'truncated-len',
    category: 'Malformed & tricky bytes',
    title: 'Truncated message',
    verdict: 'breaking',
    summary: 'A length prefix promising more bytes than available.',
    description: ['The `name` record announces 5 bytes but the buffer ends after 3. This happens with a cut network frame or a wrongly sized buffer.'],
    observe: ['Parsing fails and the whole message is rejected, not only `name`.'],
    producer: { proto: proto('message User {\n  int32 id = 1;\n  string name = 2;\n}'), type: '.User' },
    value: { id: 150, name: 'hello' },
    wireHex: '08 96 01 12 05 68 65 6C',
    expect: 'fail',
  },
  {
    id: 'truncated-varint',
    category: 'Malformed & tricky bytes',
    title: 'Truncated varint',
    verdict: 'breaking',
    summary: 'The last byte still has its continuation bit set.',
    description: ['`96` has MSB = 1, meaning "more bytes follow", but the buffer ends.'],
    observe: ['Parse error at offset 1.'],
    producer: { proto: proto('message Test1 {\n  int32 a = 1;\n}'), type: '.Test1' },
    value: { a: 150 },
    wireHex: '08 96',
    expect: 'fail',
  },
  {
    id: 'invalid-wire-type',
    category: 'Malformed & tricky bytes',
    title: 'Invalid wire type / field 0',
    verdict: 'breaking',
    summary: 'Tags that cannot exist.',
    description: [
      'Tag `0F` = field 1, wire type **7**: there are only 6 wire types (0–5, with 3/4 deprecated). Tag `00` would mean field number **0**, also invalid.',
      'Edit the bytes to `00 01` to see the field-0 error.',
    ],
    observe: ['Parse error on the very first byte.'],
    producer: { proto: proto('message Test1 {\n  int32 a = 1;\n}'), type: '.Test1' },
    value: { a: 1 },
    wireHex: '0F 01',
    expect: 'fail',
  },
  {
    id: 'invalid-utf8',
    category: 'Malformed & tricky bytes',
    title: 'Invalid UTF-8 in a string',
    verdict: 'breaking',
    summary: '`C3 28` is not valid UTF-8.',
    description: ['`C3` starts a 2-byte sequence but `28` is not a continuation byte. proto3 `string` fields must be valid UTF-8.'],
    observe: ['Parse error on the string payload.'],
    producer: { proto: proto('message Text {\n  string s = 1;\n}'), type: '.Text' },
    value: { s: 'ok' },
    wireHex: '0A 02 C3 28',
    expect: 'fail',
  },
];

export const DEFAULT_SCENARIO_ID = 'playground';

export function scenarioById(id: string | null | undefined): Scenario | undefined {
  return SCENARIOS.find((s) => s.id === id);
}
