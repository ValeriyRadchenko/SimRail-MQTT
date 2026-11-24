// SimRail payload encoding (https://wiki.simrail.eu/en/MQTT/Introduction#payload-structure).
//
// Received messages carry a 1-byte type tag:
//   0x01 -> float, followed by 4 bytes (IEEE 754 single) — 5 bytes total
//   0x02 -> string, followed by the text
// Published messages are sent raw (no tag) and are almost always floats.

const TYPE_FLOAT = 0x01;
const TYPE_STRING = 0x02;

export type DecodedValue = number | string;

export function decodeReceived(payload: Buffer): DecodedValue {
  if (payload[0] === TYPE_FLOAT && payload.length === 5) return payload.readFloatLE(1);
  if (payload[0] === TYPE_STRING) return payload.toString('utf8', 1);
  // Untagged (e.g. a message published by another client): best effort as text.
  return payload.toString('utf8');
}

/** Raw float32, little-endian, no type tag (verified in game: 0.1 -> CurrentValue "0.1"). */
export function encodeFloat(value: number): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeFloatLE(value, 0);
  return buf;
}
