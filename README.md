# Protobuf Playground

A browser playground for learning how **protobuf (proto3)** messages become bytes, travel between
services, and are read back. It focuses on what happens when the **producer** and the **consumer**
use different versions of the same `.proto`.

Everything runs in the browser. Nothing is sent to a server.

## What you can do

- Write a `.proto` and a message (as JSON) on the producer side, and a second `.proto` on the
  consumer side. The consumer uses the producer's schema until you choose to edit it separately.
- Play the exchange step by step: each field is encoded (tag, length, value), the bytes cross the
  wire, and the consumer reads them one record at a time with its own schema.
- See the arithmetic behind each step: how a tag is built, how an integer is split into varint
  bytes, ZigZag encoding, two's complement, little-endian numbers and UTF-8.
- Hover any byte to compare what the producer meant with what the consumer understood. The same
  field number has the same color on both sides.
- Type raw bytes directly onto the wire to simulate a buggy writer, a cut frame or concatenated
  messages.
- Browse 56 scenarios covering the wire format, default values, lists and maps, safe and unsafe
  schema changes, and malformed input.

## Principles

**Only numbers travel.** A serialized message is a sequence of records. Each record starts with a
tag, `(field_number << 3) | wire_type`, followed by the value. Field names, message names and the
schema itself are never sent. The consumer needs its own copy of the `.proto` to make sense of the
bytes, and nothing on the wire says which message type they contain.

**The wire type says how to skip.** There are four wire types in use: VARINT, I64, LEN and I32.
They tell a parser how many bytes a record takes even when it doesn't know the field. This is what
lets an old consumer skip fields added by a newer producer.

**Defaults are not written.** In proto3, a plain scalar field equal to its default value (0, "",
false, the first enum value) is not serialized. The consumer can't tell "set to 0" from "never set"
unless the field has presence (`optional`, a oneof member, or a message field).

**Field numbers are the contract.** Renaming a field or a message is safe on the wire. Changing a
field's number, or reusing a number for a different type, is not.

**Compatibility depends on the encoding, not the declared type.** Types that share an encoding
(`int32`, `int64`, `uint32`, `bool` and enums are all VARINT) can be read as one another, sometimes
with truncation or a sign change. Types that share a wire type but encode differently (`int32` and
`sint32`, `float` and `fixed32`) parse without any error and give wrong values.

## How the playground encodes and decodes

The encoder and decoder are written for this project instead of using a protobuf library. A library
returns only the final bytes; the playground needs to know which field every byte belongs to and how
it was computed, and it needs to decode bytes with a schema different from the one that wrote them.

[protobuf.js](https://github.com/protobufjs/protobuf.js) is used only to read the `.proto` text.
After that, all encoding and decoding follows the
[encoding specification](https://protobuf.dev/programming-guides/encoding/). Tests check the encoder
against protobuf.js and against the reference example from the specification (`150` encodes as
`08 96 01`).

### Encoder behaviour

- Fields are written in field-number order, as the C++ and Java libraries do. protobuf.js uses
  declaration order instead.
- Repeated numeric fields are packed by default, as proto3 requires. protobuf.js does not pack them
  by default, so its bytes can differ while decoding to the same values.
- Scalars equal to their default are skipped, except for `optional` fields and oneof members, which
  are written whenever they are set.
- `-0.0` is written: presence is checked on the bits, and its sign bit is set.
- A message field set to `{}` is written as a tag and a length of 0.
- Negative `int32` and `int64` values take 10 bytes (sign-extended to 64 bits). `sint32` and
  `sint64` use ZigZag instead.
- Map entries always contain both the key and the value, even when they are defaults.
- Invalid input is reported as an error: an unknown field name, a value out of range for its type
  (that field is left out), or two members of the same oneof (both are still written, so you can see
  what a consumer does with them).

### Decoder behaviour

Where protobuf libraries disagree, the decoder follows C++ and Java.

- Records are accepted in any order.
- A field number missing from the consumer schema becomes an unknown field. It is kept aside (as
  libraries do since protobuf 3.5) and flagged when the number is `reserved`.
- A record whose wire type doesn't match the field is treated as an unknown field and flagged as a
  mismatch. Some libraries throw an error instead.
- Repeated numeric fields accept both the packed and the unpacked form.
- A singular scalar that appears twice keeps the last value. A singular message that appears twice
  is merged: scalars are overwritten and lists are appended.
- Setting a oneof member clears any other member read before it.
- A duplicate map key keeps the last entry. An entry without a key or value uses the defaults.
- Reading a larger integer into `int32` or `uint32` keeps the lower 32 bits, with a warning.
- A `bool` read from any non-zero varint is `true`, with a warning when the value is above 1.
- An enum number unknown to the consumer is kept as a number (proto3 enums are open).
- Fields missing from the wire show their default value, or "not set" when the field has presence.

The whole message is rejected, as in the real libraries, when the decoder finds:

- invalid UTF-8 in a `string` field;
- a varint that runs out of bytes or is longer than 10 bytes;
- a length prefix larger than the remaining bytes;
- field number 0 or above 2^29 - 1;
- wire type 3 or 4 (proto2 groups) or wire type 6 or 7.

An error inside a nested message rejects the outer message too. The playground still shows the
fields read before the failure, to explain where it happened.

### Schema diff

The diff compares the two schemas field by field and rates each difference as compatible, caution
or breaking. It only looks at the schemas, so some ratings depend on the data. For example,
changing `bytes` to `string` is rated "caution" because it works until the bytes are not valid
UTF-8.

## Assumptions and limits

- The playground targets proto3. A proto2 file is accepted and its presence rules are applied, but
  custom `[default = …]` values are ignored.
- Not supported: `import`, extensions, groups, and the special handling of Google's well-known types
  (`Timestamp`, `Duration`, `Any`, wrappers).
- An unknown field that uses a group wire type is rejected. Real parsers would skip it.
- There is no recursion depth limit. Real libraries stop at around 100 levels of nesting.
- Unknown fields are shown as kept, but the playground does not re-serialize the consumer's message
  to prove it.
- The "Decoded JSON" view is close to the proto3 JSON mapping but uses field names as written in the
  `.proto`, not their lowerCamelCase JSON names. Unknown fields don't appear in it.

## Writing a message

The producer message is JSON, with these conventions:

- field names as written in the `.proto`;
- enums by name or by number;
- 64-bit integers as numbers, or as strings when larger than 2^53;
- `bytes` as base64, or as an array of byte values;
- floats also accept `"NaN"`, `"Infinity"`, `"-Infinity"` and `-0`;
- maps as JSON objects;
- a oneof by setting exactly one of its members.

## Running it locally

```bash
npm install
npm run dev     # http://localhost:5173
npm test
```

Pushes to `main` are published to GitHub Pages by `.github/workflows/deploy.yml`.
