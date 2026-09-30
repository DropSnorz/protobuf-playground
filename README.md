# Protobuf Playground

An in-browser playground to understand how **protobuf (proto3)** messages are serialized, sent and
deserialized — and what happens when the **producer** and the **consumer** don't use the same version
of the `.proto`.

Everything runs client-side: nothing is uploaded anywhere.

## Features

- **Producer / Wire / Consumer** layout: edit the producer `.proto` and message (JSON), and the
  consumer `.proto` — linked to the producer by default, or edited separately to simulate another
  version.
- **Step-by-step animation**: serialization field by field (tag, length prefix, value), bytes
  travelling over the wire, then parsing record by record against the consumer schema.
  Play / pause / step / scrub, with keyboard shortcuts (`space`, `←`, `→`, `Home`, `End`).
- **Worksheets** for every computation: tag = `(field_number << 3) | wire_type`, varint 7-bit
  groups and continuation bits, ZigZag, two's complement, little-endian fixed-width values, UTF-8.
- **Color-coded bytes**: same color = same field number on both sides; tag / length / value have
  distinct styles; unknown fields are hatched; parse errors are outlined. Hover any byte to see
  what the producer meant and what the consumer understood.
- **Consumer view** showing values read, defaults, *not set* fields, unknown fields (kept since
  protobuf 3.5), wire-type mismatches, truncations, open-enum unknown values, "last one wins",
  message merging, oneof clearing…
- **Schema diff** rating each difference as compatible / caution / breaking.
- **Byte-by-byte table**, **decoded JSON** (proto3 JSON mapping) and the full **step list**.
- **Hand-crafted bytes**: edit the wire directly to simulate buggy writers, truncation,
  concatenation, invalid tags…
- **56 scenarios** in the left menu: wire format basics, presence & defaults, collections
  (packed/unpacked, maps, oneofs, nesting, recursion, several message types), safe evolutions,
  lossy evolutions, breaking changes and malformed bytes.
- **Share** button: the link embeds the current schemas, message and bytes.

## Getting started

```bash
npm install
npm run dev       # http://localhost:5173
npm test          # encoder/decoder, scenarios and schema-diff tests
npm run build     # static site in dist/ (relative paths: host it anywhere)
```

## How it works

| Piece | Where |
| --- | --- |
| `.proto` parsing (into a simplified model) | `src/proto/schema.ts` — uses [protobuf.js](https://github.com/protobufjs/protobuf.js) only for parsing |
| Annotated encoder (JSON → bytes + trace) | `src/proto/encoder.ts` |
| Annotated decoder (bytes + consumer schema → result + trace) | `src/proto/decoder.ts` |
| Animation timeline | `src/proto/steps.ts` |
| Wire-compatibility diff | `src/proto/diff.ts` |
| Scenarios | `src/scenarios/index.ts` |

The encoder and decoder are written from scratch following the
[encoding spec](https://protobuf.dev/programming-guides/encoding/) so every byte can be traced back
to a field and a computation. The decoder follows the C++/Java behaviour where libraries differ
(e.g. a wire-type mismatch is kept as an unknown field; invalid UTF-8 in a `string` rejects the
message).

### Adding a scenario

Append an entry to `SCENARIOS` in `src/scenarios/index.ts`: producer (and optionally consumer)
`.proto` + message type, the JSON value, an optional `wireHex` to override the bytes, and the
explanation texts (`` `code` ``, `**bold**` and `*italic*` are supported). `npm test` checks that
every scenario parses, encodes and decodes as declared (`expect: 'fail'` for parse failures).

### Message JSON conventions

Field names as written in the `.proto`; enums by name or number; 64-bit integers as numbers or
strings; `bytes` as base64 (or an array of byte values); floats accept `"NaN"`, `"Infinity"`,
`"-Infinity"` and `-0`; maps as JSON objects; a oneof is set by giving exactly one of its members.
