import { TPQN } from "./constants.js";

export function normalizeNotesForMidi(notes, { clamp, compareNotes, cloneNote }) {
  const sorted = [...notes].sort(compareNotes).map(cloneNote);
  const lastByPitch = new Map();
  for (const note of sorted) {
    note.startTick = Math.max(0, Math.round(note.startTick));
    note.durationTicks = Math.max(1, Math.round(note.durationTicks));
    note.pitch = clamp(Math.round(note.pitch), 0, 127);
    const previous = lastByPitch.get(note.pitch);
    if (previous) {
      const previousEnd = previous.startTick + previous.durationTicks;
      if (previousEnd > note.startTick) previous.durationTicks = note.startTick > previous.startTick ? note.startTick - previous.startTick : 0;
    }
    lastByPitch.set(note.pitch, note);
  }
  return sorted.filter(note => note.durationTicks > 0);
}

export function buildMidi(notes, bpm, tools) {
  const usqn = Math.round(60000000 / bpm);
  const events = [];
  const sorted = normalizeNotesForMidi(notes, tools);
  for (const note of sorted) {
    const pitch = note.pitch;
    const start = note.startTick;
    const end = Math.max(start + 1, Math.round(note.startTick + note.durationTicks));
    events.push({ tick: start, type: "on", pitch, velocity: note.velocity || 100 });
    events.push({ tick: end, type: "off", pitch, velocity: 0 });
  }
  events.sort((a, b) => a.tick - b.tick || (a.type === "off" ? -1 : 1));

  const track = [
    0x00, 0xff, 0x51, 0x03,
    (usqn >> 16) & 0xff,
    (usqn >> 8) & 0xff,
    usqn & 0xff
  ];
  let previousTick = 0;
  for (const event of events) {
    appendVlq(track, event.tick - previousTick);
    previousTick = event.tick;
    track.push(event.type === "on" ? 0x90 : 0x80, event.pitch, event.velocity);
  }
  appendVlq(track, 0);
  track.push(0xff, 0x2f, 0x00);

  const header = [
    0x4d, 0x54, 0x68, 0x64,
    0x00, 0x00, 0x00, 0x06,
    0x00, 0x00,
    0x00, 0x01,
    (TPQN >> 8) & 0xff, TPQN & 0xff
  ];
  const trackHeader = [
    0x4d, 0x54, 0x72, 0x6b,
    (track.length >> 24) & 0xff,
    (track.length >> 16) & 0xff,
    (track.length >> 8) & 0xff,
    track.length & 0xff
  ];
  return new Uint8Array([...header, ...trackHeader, ...track]);
}

export function appendVlq(bytes, value) {
  let buffer = value & 0x7f;
  while ((value >>= 7)) {
    buffer <<= 8;
    buffer |= ((value & 0x7f) | 0x80);
  }
  while (true) {
    bytes.push(buffer & 0xff);
    if (buffer & 0x80) buffer >>= 8;
    else break;
  }
}
