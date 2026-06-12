import {
  DEFAULT_BPM,
  INPUT_PITCH_HISTORY_LIMIT,
  INPUT_PITCH_HISTORY_MS,
  IS_BLACK,
  KB_HI,
  KB_LO,
  NOTE_NAMES,
  PITCH_MAX_HZ,
  PITCH_MIN_HZ,
  REST_LANE_H,
  ROLL_H,
  ROLL_LEFT_PAD,
  ROLL_RESIZE_HANDLE,
  ROLL_RIGHT_PAD,
  TPQN
} from "./constants.js";
import {
  appendVlq,
  buildMidi as buildMidiBytes,
  normalizeNotesForMidi as normalizeNotesForMidiBytes
} from "./midi.js";

const state = {
  audioCtx: null,
  analyser: null,
  stream: null,
  rafId: 0,
  running: false,
  mode: "step",
  bpm: DEFAULT_BPM,
  durationDenom: 4,
  currentTick: 0,
  nextNoteId: 1,
  nextRestId: 1,
  selectedNoteId: null,
  notes: [],
  rests: [],
  history: [],
  view: {
    // Base scale at DEFAULT_BPM. The roll display stretches by BPM for a lightweight bar-adjust view.
    pxPerTick: 0.08,
    scrollX: 0
  },
  drag: {
    mode: null,
    noteId: null,
    startMouseX: 0,
    startMouseY: 0,
    originalNote: null,
    didMove: false
  },
  suppressRollClick: false,
  rawPitch: null,
  smoothedMidi: null,
  stablePitch: null,
  pitchHistory: [],
  pendingNote: null,
  pendingFrames: 0,
  holdStart: null,
  lastBuffer: null
};

const els = {
  keyboard: document.getElementById("keyboard"),
  scope: document.getElementById("scope"),
  roll: document.getElementById("roll"),
  rollWrap: document.getElementById("roll-wrap"),
  btnStart: document.getElementById("btn-start"),
  modeStep: document.getElementById("mode-step"),
  modeHold: document.getElementById("mode-hold"),
  btnInput: document.getElementById("btn-input"),
  btnRest: document.getElementById("btn-rest"),
  btnUndo: document.getElementById("btn-undo"),
  btnDelete: document.getElementById("btn-delete"),
  btnFillGap: document.getElementById("btn-fill-gap"),
  btnCompact: document.getElementById("btn-compact"),
  btnClear: document.getElementById("btn-clear"),
  btnMidi: document.getElementById("btn-midi"),
  bpmInput: document.getElementById("bpm-input"),
  durationGrid: document.getElementById("duration-grid"),
  noteName: document.getElementById("note-name"),
  noteFreq: document.getElementById("note-freq"),
  noteCents: document.getElementById("note-cents"),
  noteStability: document.getElementById("note-stability"),
  centsFill: document.getElementById("cents-bar-fill"),
  statusText: document.getElementById("status-text"),
  noteCount: document.getElementById("note-count"),
  positionReadout: document.getElementById("position-readout"),
  lengthReadout: document.getElementById("length-readout"),
  notesList: document.getElementById("notes-list")
};

let keyboardCtx = els.keyboard.getContext("2d");
let scopeCtx = els.scope.getContext("2d");
let rollCtx = els.roll.getContext("2d");

function durationTicks() {
  return Math.round(TPQN * 4 / state.durationDenom);
}

function gridTicks() {
  return Math.round(TPQN / 4);
}

function secondsToTicks(seconds) {
  return Math.round(seconds * state.bpm / 60 * TPQN);
}

function ticksToSeconds(ticks) {
  return ticks / TPQN * 60 / state.bpm;
}

function quantizeTicks(ticks) {
  const grid = gridTicks();
  return Math.max(grid, Math.round(ticks / grid) * grid);
}

function quantizeStartTicks(ticks) {
  const grid = gridTicks();
  return Math.max(0, Math.round(ticks / grid) * grid);
}

function freqToMidi(freq) {
  return 69 + 12 * Math.log2(freq / 440);
}

function midiToFreq(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

function midiToNoteName(midi) {
  const n = Math.max(0, Math.min(127, Math.round(midi)));
  return NOTE_NAMES[n % 12] + (Math.floor(n / 12) - 1);
}

function midiToCents(midi) {
  return Math.round((midi - Math.round(midi)) * 100);
}

function nearestMidi(midi) {
  return clamp(Math.round(midi), 0, 127);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function compareNotes(a, b) {
  return a.startTick - b.startTick || a.pitch - b.pitch || (a.id || 0) - (b.id || 0);
}

function createNote(pitch, startTick, noteDurationTicks) {
  return {
    id: state.nextNoteId++,
    pitch,
    startTick,
    durationTicks: noteDurationTicks,
    velocity: 100
  };
}

function createRest(startTick, restDurationTicks) {
  return {
    id: state.nextRestId++,
    startTick,
    durationTicks: restDurationTicks
  };
}

function cloneNote(note) {
  return { ...note };
}

function cloneRest(rest) {
  return { ...rest };
}

function timelineItems(options = {}) {
  const excludeType = options.excludeType || null;
  const excludeId = options.excludeId || null;
  return [
    ...state.notes.map(note => ({ type: "note", ...note })),
    ...state.rests.map(rest => ({ type: "rest", ...rest }))
  ]
    .filter(item => !(item.type === excludeType && item.id === excludeId))
    .sort((a, b) => a.startTick - b.startTick || (a.type === "rest" ? -1 : 1) || (a.id || 0) - (b.id || 0));
}

function itemEnd(item) {
  return item.startTick + item.durationTicks;
}

function rangesOverlap(startA, durationA, startB, durationB) {
  return startA < startB + durationB && startA + durationA > startB;
}

function hasTimelineOverlap(startTick, durationTicks, options = {}) {
  return timelineItems(options).some(item => rangesOverlap(startTick, durationTicks, item.startTick, item.durationTicks));
}

function adjacentBoundsForRange(startTick, durationTicks, options = {}) {
  const endTick = startTick + durationTicks;
  let minStart = 0;
  let maxEnd = Infinity;
  for (const item of timelineItems(options)) {
    const end = itemEnd(item);
    if (end <= startTick) minStart = Math.max(minStart, end);
    if (item.startTick >= endTick) maxEnd = Math.min(maxEnd, item.startTick);
  }
  return { minStart, maxEnd };
}

function clampStartToTimeline(startTick, durationTicks, originalStartTick, options = {}) {
  const bounds = adjacentBoundsForRange(originalStartTick, durationTicks, options);
  const maxStart = Number.isFinite(bounds.maxEnd) ? Math.max(bounds.minStart, bounds.maxEnd - durationTicks) : Infinity;
  return Math.max(bounds.minStart, Math.min(startTick, maxStart));
}

function maxDurationForStart(startTick, options = {}) {
  let maxEnd = Infinity;
  for (const item of timelineItems(options)) {
    if (item.startTick >= startTick) maxEnd = Math.min(maxEnd, item.startTick);
  }
  return Number.isFinite(maxEnd) ? Math.max(gridTicks(), maxEnd - startTick) : Infinity;
}

function snapshotTimeline() {
  return {
    notes: state.notes.map(cloneNote),
    rests: state.rests.map(cloneRest),
    currentTick: state.currentTick,
    selectedNoteId: state.selectedNoteId,
    nextNoteId: state.nextNoteId,
    nextRestId: state.nextRestId
  };
}

function restoreTimeline(snapshot) {
  state.notes = snapshot.notes.map(cloneNote);
  state.rests = snapshot.rests.map(cloneRest);
  state.currentTick = snapshot.currentTick;
  state.selectedNoteId = snapshot.selectedNoteId;
  state.nextNoteId = snapshot.nextNoteId;
  state.nextRestId = snapshot.nextRestId;
}

function selectedNote() {
  return state.notes.find(note => note.id === state.selectedNoteId) || null;
}

function selectNote(noteId) {
  state.selectedNoteId = state.notes.some(note => note.id === noteId) ? noteId : null;
  updateInputEnabled();
  updateNotesList();
  drawRoll();
}

function recomputeCurrentTick() {
  const noteEnd = state.notes.reduce((maxTick, note) => Math.max(maxTick, note.startTick + note.durationTicks), 0);
  const restEnd = state.rests.reduce((maxTick, rest) => Math.max(maxTick, rest.startTick + rest.durationTicks), 0);
  state.currentTick = Math.max(noteEnd, restEnd);
}

function restoreNote(snapshot) {
  const index = state.notes.findIndex(note => note.id === snapshot.id);
  if (index >= 0) state.notes[index] = cloneNote(snapshot);
  else state.notes.push(cloneNote(snapshot));
  state.nextNoteId = Math.max(state.nextNoteId, snapshot.id + 1);
}

function restoreRest(snapshot) {
  const index = state.rests.findIndex(rest => rest.id === snapshot.id);
  if (index >= 0) state.rests[index] = cloneRest(snapshot);
  else state.rests.push(cloneRest(snapshot));
  state.nextRestId = Math.max(state.nextRestId, snapshot.id + 1);
}

function readBpm() {
  const next = clamp(Number.parseInt(els.bpmInput.value, 10) || DEFAULT_BPM, 30, 240);
  state.bpm = next;
  els.bpmInput.value = String(next);
  updateSummary();
  drawRoll();
}

function setMode(mode) {
  if (state.holdStart) finishHoldInput();
  state.mode = mode;
  els.modeStep.classList.toggle("active", mode === "step");
  els.modeHold.classList.toggle("active", mode === "hold");
  els.btnInput.textContent = mode === "step" ? "⏺ 入力" : "⏺ 押して記録";
  updateInputEnabled();
  drawRoll();
}

function resizeCanvases() {
  const dpr = window.devicePixelRatio || 1;
  const topRect = document.getElementById("row-top").getBoundingClientRect();
  const keyboardW = 34;
  els.keyboard.width = Math.round(keyboardW * dpr);
  els.keyboard.height = Math.round(topRect.height * dpr);
  els.keyboard.style.width = keyboardW + "px";
  keyboardCtx = els.keyboard.getContext("2d");
  keyboardCtx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const scopeRect = document.getElementById("scope-area").getBoundingClientRect();
  els.scope.width = Math.max(1, Math.round(scopeRect.width * dpr));
  els.scope.height = Math.max(1, Math.round(scopeRect.height * dpr));
  scopeCtx = els.scope.getContext("2d");
  scopeCtx.setTransform(dpr, 0, 0, dpr, 0, 0);

  syncRollCanvasSize(dpr);

  drawKeyboard();
  drawScope(state.lastBuffer);
  drawRoll();
}

function midiToKeyboardY(midi) {
  const h = els.keyboard.clientHeight;
  return (KB_HI - midi) / (KB_HI - KB_LO) * h;
}

function drawKeyboard() {
  const w = els.keyboard.clientWidth;
  const h = els.keyboard.clientHeight;
  const semH = h / (KB_HI - KB_LO);
  keyboardCtx.clearRect(0, 0, w, h);
  keyboardCtx.fillStyle = "#0f0f14";
  keyboardCtx.fillRect(0, 0, w, h);

  for (let midi = KB_LO; midi < KB_HI; midi++) {
    if (IS_BLACK[midi % 12]) continue;
    const y = midiToKeyboardY(midi + 1);
    const active = state.stablePitch && state.stablePitch.pitch === midi;
    const holding = state.holdStart && state.holdStart.pitch === midi;
    keyboardCtx.fillStyle = holding ? "rgba(255,51,85,0.86)" : active ? "#00e5a0" : "#d8d8e8";
    keyboardCtx.fillRect(0, y, w - 1, semH);
    keyboardCtx.strokeStyle = "#45455a";
    keyboardCtx.lineWidth = 0.5;
    keyboardCtx.beginPath();
    keyboardCtx.moveTo(0, y + semH);
    keyboardCtx.lineTo(w - 1, y + semH);
    keyboardCtx.stroke();
    if (NOTE_NAMES[midi % 12] === "C") {
      keyboardCtx.fillStyle = active ? "#002419" : "#666680";
      keyboardCtx.font = "7px Share Tech Mono, monospace";
      keyboardCtx.textAlign = "right";
      keyboardCtx.fillText("C" + (Math.floor(midi / 12) - 1), w - 3, y + semH - 2);
    }
  }

  for (let midi = KB_LO; midi < KB_HI; midi++) {
    if (!IS_BLACK[midi % 12]) continue;
    const y = midiToKeyboardY(midi + 0.82);
    const active = state.stablePitch && state.stablePitch.pitch === midi;
    const holding = state.holdStart && state.holdStart.pitch === midi;
    keyboardCtx.fillStyle = holding ? "rgba(255,51,85,0.92)" : active ? "#00c888" : "#15151d";
    keyboardCtx.fillRect(0, y, w * 0.66, semH * 0.64);
    keyboardCtx.strokeStyle = "#050508";
    keyboardCtx.strokeRect(0, y, w * 0.66, semH * 0.64);
  }

  if (state.smoothedMidi != null) {
    const y = midiToKeyboardY(state.smoothedMidi + 0.5);
    keyboardCtx.strokeStyle = "rgba(0,229,160,0.88)";
    keyboardCtx.lineWidth = 1.5;
    keyboardCtx.beginPath();
    keyboardCtx.moveTo(0, y);
    keyboardCtx.lineTo(w, y);
    keyboardCtx.stroke();
  }
}

function drawScope(buffer) {
  const w = els.scope.clientWidth;
  const h = els.scope.clientHeight;
  scopeCtx.clearRect(0, 0, w, h);
  scopeCtx.fillStyle = "#0f0f14";
  scopeCtx.fillRect(0, 0, w, h);

  scopeCtx.strokeStyle = "#191922";
  scopeCtx.lineWidth = 0.5;
  for (let x = 0; x < w; x += 60) {
    scopeCtx.beginPath();
    scopeCtx.moveTo(x, 0);
    scopeCtx.lineTo(x, h);
    scopeCtx.stroke();
  }
  for (let y = 0; y < h; y += h / 8) {
    scopeCtx.beginPath();
    scopeCtx.moveTo(0, y);
    scopeCtx.lineTo(w, y);
    scopeCtx.stroke();
  }

  scopeCtx.strokeStyle = "#252535";
  scopeCtx.beginPath();
  scopeCtx.moveTo(0, h / 2);
  scopeCtx.lineTo(w, h / 2);
  scopeCtx.stroke();

  if (buffer && buffer.length) {
    const color = state.stablePitch ? "#00e5a0" : "#293243";
    scopeCtx.strokeStyle = color;
    scopeCtx.lineWidth = 1.4;
    scopeCtx.shadowColor = color;
    scopeCtx.shadowBlur = state.stablePitch ? 5 : 0;
    scopeCtx.beginPath();
    for (let i = 0; i < buffer.length; i++) {
      const x = i / (buffer.length - 1) * w;
      const y = h / 2 + buffer[i] * (h / 2 - 4);
      if (i === 0) scopeCtx.moveTo(x, y);
      else scopeCtx.lineTo(x, y);
    }
    scopeCtx.stroke();
    scopeCtx.shadowBlur = 0;
  }

  if (state.smoothedMidi != null) {
    const y = (1 - (state.smoothedMidi - KB_LO) / (KB_HI - KB_LO)) * h;
    const grad = scopeCtx.createLinearGradient(0, y - 13, 0, y + 13);
    grad.addColorStop(0, "rgba(0,229,160,0)");
    grad.addColorStop(0.5, "rgba(0,229,160,0.14)");
    grad.addColorStop(1, "rgba(0,229,160,0)");
    scopeCtx.fillStyle = grad;
    scopeCtx.fillRect(0, y - 13, w, 26);
    scopeCtx.strokeStyle = "rgba(0,229,160,0.58)";
    scopeCtx.setLineDash([6, 5]);
    scopeCtx.beginPath();
    scopeCtx.moveTo(0, y);
    scopeCtx.lineTo(w, y);
    scopeCtx.stroke();
    scopeCtx.setLineDash([]);
    scopeCtx.fillStyle = "rgba(0,229,160,0.82)";
    scopeCtx.font = "bold 9px Share Tech Mono, monospace";
    scopeCtx.textAlign = "right";
    scopeCtx.fillText(midiToNoteName(state.smoothedMidi), w - 5, y - 4);
  }
}

function rollBounds() {
  const noteEnds = state.notes.map(note => note.startTick + note.durationTicks);
  const restEnds = state.rests.map(rest => rest.startTick + rest.durationTicks);
  const maxEnd = Math.max(state.currentTick, ...noteEnds, ...restEnds, TPQN * 4);
  const totalTicks = Math.ceil(maxEnd / (TPQN * 4)) * TPQN * 4;
  return { totalTicks };
}

function rollContentWidth() {
  const { totalTicks } = rollBounds();
  const viewportW = Math.max(1, els.rollWrap.clientWidth || els.roll.clientWidth || 1);
  return Math.max(viewportW, Math.ceil(ROLL_LEFT_PAD + totalTicks * effectivePxPerTick() + ROLL_RIGHT_PAD));
}

function syncRollCanvasSize(dpr = window.devicePixelRatio || 1) {
  const contentW = rollContentWidth();
  const pixelW = Math.max(1, Math.round(contentW * dpr));
  const pixelH = Math.round(ROLL_H * dpr);
  if (els.roll.width !== pixelW || els.roll.height !== pixelH) {
    els.roll.width = pixelW;
    els.roll.height = pixelH;
    els.roll.style.width = contentW + "px";
    els.roll.style.height = ROLL_H + "px";
    rollCtx = els.roll.getContext("2d");
    rollCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
}

function tickToX(tick) {
  return ROLL_LEFT_PAD + tick * effectivePxPerTick();
}

function xToTick(x) {
  return Math.max(0, (x - ROLL_LEFT_PAD) / effectivePxPerTick());
}

function effectivePxPerTick() {
  return state.view.pxPerTick * DEFAULT_BPM / state.bpm;
}

function midiToRollY(midi) {
  const semH = ROLL_H / (KB_HI - KB_LO);
  return ROLL_H - (midi - KB_LO + 1) * semH;
}

function rollYToMidi(y) {
  const semH = ROLL_H / (KB_HI - KB_LO);
  return clamp(KB_LO + Math.floor((ROLL_H - y) / semH), KB_LO, KB_HI - 1);
}

function drawRoll() {
  syncRollCanvasSize();
  const w = els.roll.clientWidth;
  const h = ROLL_H;
  const { totalTicks } = rollBounds();
  const semH = h / (KB_HI - KB_LO);
  rollCtx.clearRect(0, 0, w, h);
  rollCtx.fillStyle = "#0f0f14";
  rollCtx.fillRect(0, 0, w, h);

  rollCtx.fillStyle = "#101018";
  rollCtx.fillRect(0, 0, ROLL_LEFT_PAD, h);

  for (let midi = KB_LO; midi < KB_HI; midi++) {
    const y = midiToRollY(midi);
    rollCtx.fillStyle = IS_BLACK[midi % 12] ? "#12121a" : "#0f0f14";
    rollCtx.fillRect(ROLL_LEFT_PAD, y, w - ROLL_LEFT_PAD, semH);
    if (NOTE_NAMES[midi % 12] === "C") {
      rollCtx.strokeStyle = "#252535";
      rollCtx.lineWidth = 0.5;
      rollCtx.beginPath();
      rollCtx.moveTo(ROLL_LEFT_PAD, y + semH);
      rollCtx.lineTo(w, y + semH);
      rollCtx.stroke();
      rollCtx.fillStyle = "#5c5c78";
      rollCtx.font = "8px Share Tech Mono, monospace";
      rollCtx.textAlign = "right";
      rollCtx.fillText("C" + (Math.floor(midi / 12) - 1), ROLL_LEFT_PAD - 5, y + semH - 1);
    }
  }

  for (let tick = 0; tick <= totalTicks; tick += TPQN) {
    const x = tickToX(tick);
    rollCtx.strokeStyle = tick % (TPQN * 4) === 0 ? "#34344a" : "#20202e";
    rollCtx.lineWidth = tick % (TPQN * 4) === 0 ? 1 : 0.5;
    rollCtx.beginPath();
    rollCtx.moveTo(x, 0);
    rollCtx.lineTo(x, h);
    rollCtx.stroke();
  }

  const sortedNotes = [...state.notes].sort(compareNotes);
  for (const note of sortedNotes) {
    const selected = note.id === state.selectedNoteId;
    drawRollNote(
      note,
      selected ? "rgba(0,229,160,0.78)" : "rgba(124,106,255,0.76)",
      selected ? "rgba(202,255,236,0.96)" : "rgba(198,190,255,0.92)"
    );
  }

  for (const rest of [...state.rests].sort(compareNotes)) {
    drawRollRest(rest);
  }

  if (state.holdStart) {
    const elapsedTicks = Math.max(gridTicks(), secondsToTicks((performance.now() - state.holdStart.timeMs) / 1000));
    drawRollNote({
      pitch: state.holdStart.pitch,
      startTick: state.holdStart.startTick,
      durationTicks: elapsedTicks
    }, "rgba(255,51,85,0.72)", "rgba(255,150,165,0.92)");
  }

  const cursorX = tickToX(state.currentTick);
  rollCtx.strokeStyle = "rgba(0,229,160,0.9)";
  rollCtx.lineWidth = 1.5;
  rollCtx.beginPath();
  rollCtx.moveTo(cursorX, 0);
  rollCtx.lineTo(cursorX, h);
  rollCtx.stroke();
}

function drawRollNote(note, fill, stroke) {
  const semH = ROLL_H / (KB_HI - KB_LO);
  if (note.pitch < KB_LO || note.pitch >= KB_HI) return;
  const x = tickToX(note.startTick);
  const w = Math.max(5, tickToX(note.startTick + note.durationTicks) - x);
  const y = midiToRollY(note.pitch);
  rollCtx.fillStyle = fill;
  rollCtx.fillRect(x, y + 1, w, semH - 2);
  rollCtx.strokeStyle = stroke;
  rollCtx.lineWidth = 1;
  rollCtx.strokeRect(x, y + 1, w, semH - 2);
  if (w > 22) {
    rollCtx.fillStyle = "#fff";
    rollCtx.font = Math.min(10, semH + 1) + "px Share Tech Mono, monospace";
    rollCtx.textAlign = "left";
    rollCtx.fillText(midiToNoteName(note.pitch), x + 3, y + semH - 2);
  }
}

function drawRollRest(rest) {
  const x = tickToX(rest.startTick);
  const w = Math.max(5, tickToX(rest.startTick + rest.durationTicks) - x);
  const y = ROLL_H - REST_LANE_H;
  rollCtx.fillStyle = "rgba(255,255,255,0.08)";
  rollCtx.fillRect(x, y + 3, w, REST_LANE_H - 6);
  rollCtx.strokeStyle = "rgba(255,255,255,0.2)";
  rollCtx.lineWidth = 1;
  rollCtx.strokeRect(x, y + 3, w, REST_LANE_H - 6);
  if (w > 34) {
    rollCtx.fillStyle = "rgba(216,216,232,0.55)";
    rollCtx.font = "9px Share Tech Mono, monospace";
    rollCtx.textAlign = "left";
    rollCtx.fillText("REST", x + 4, y + 13);
  }
}

function rollPointFromEvent(event) {
  const rect = els.roll.getBoundingClientRect();
  return {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top
  };
}

function noteHitAtRollPoint(clientX, clientY) {
  const rect = els.roll.getBoundingClientRect();
  const x = clientX - rect.left;
  const y = clientY - rect.top;
  const semH = ROLL_H / (KB_HI - KB_LO);
  const sorted = [...state.notes].sort(compareNotes).reverse();
  for (const note of sorted) {
    if (note.pitch < KB_LO || note.pitch >= KB_HI) continue;
    const noteX = tickToX(note.startTick);
    const noteW = Math.max(5, tickToX(note.startTick + note.durationTicks) - noteX);
    const noteY = midiToRollY(note.pitch);
    if (x >= noteX && x <= noteX + noteW && y >= noteY && y <= noteY + semH) {
      return {
        note,
        mode: x >= noteX + noteW - ROLL_RESIZE_HANDLE ? "resize" : "move"
      };
    }
  }
  return null;
}

function noteAtRollPoint(clientX, clientY) {
  const hit = noteHitAtRollPoint(clientX, clientY);
  return hit ? hit.note : null;
}

function handleRollClick(event) {
  if (state.suppressRollClick) {
    state.suppressRollClick = false;
    return;
  }
  const note = noteAtRollPoint(event.clientX, event.clientY);
  selectNote(note ? note.id : null);
}

function handleRollMouseDown(event) {
  const hit = noteHitAtRollPoint(event.clientX, event.clientY);
  if (!hit) {
    selectNote(null);
    return;
  }
  const point = rollPointFromEvent(event);
  selectNote(hit.note.id);
  state.drag = {
    mode: hit.mode,
    noteId: hit.note.id,
    startMouseX: point.x,
    startMouseY: point.y,
    originalNote: cloneNote(hit.note),
    didMove: false
  };
  event.preventDefault();
}

function handleRollMouseMove(event) {
  const point = rollPointFromEvent(event);
  if (!state.drag.mode) {
    if (event.target !== els.roll) return;
    const hit = noteHitAtRollPoint(event.clientX, event.clientY);
    els.roll.style.cursor = hit ? (hit.mode === "resize" ? "ew-resize" : "move") : "default";
    return;
  }

  const note = state.notes.find(item => item.id === state.drag.noteId);
  if (!note) return;
  const original = state.drag.originalNote;
  const grid = gridTicks();
  const deltaTicks = Math.round((point.x - state.drag.startMouseX) / effectivePxPerTick() / grid) * grid;
  const semH = ROLL_H / (KB_HI - KB_LO);
  state.drag.didMove = state.drag.didMove || Math.abs(point.x - state.drag.startMouseX) > 2 || Math.abs(point.y - state.drag.startMouseY) > 2;

  if (state.drag.mode === "move") {
    const deltaPitch = Math.round((state.drag.startMouseY - point.y) / semH);
    const desiredStart = quantizeStartTicks(original.startTick + deltaTicks);
    note.startTick = clampStartToTimeline(desiredStart, original.durationTicks, original.startTick, { excludeType: "note", excludeId: note.id });
    note.pitch = clamp(original.pitch + deltaPitch, KB_LO, KB_HI - 1);
  } else {
    const desiredDuration = quantizeTicks(original.durationTicks + deltaTicks);
    const maxDuration = maxDurationForStart(original.startTick, { excludeType: "note", excludeId: note.id });
    note.durationTicks = Number.isFinite(maxDuration) ? Math.min(desiredDuration, maxDuration) : desiredDuration;
  }
  drawRoll();
}

function finishRollDrag() {
  if (!state.drag.mode) return;
  const note = state.notes.find(item => item.id === state.drag.noteId);
  const before = state.drag.originalNote;
  state.suppressRollClick = state.drag.didMove;
  state.drag = {
    mode: null,
    noteId: null,
    startMouseX: 0,
    startMouseY: 0,
    originalNote: null,
    didMove: false
  };
  els.roll.style.cursor = "default";
  if (!note || !before) return;
  const after = cloneNote(note);
  if (before.pitch === after.pitch && before.startTick === after.startTick && before.durationTicks === after.durationTicks) {
    drawRoll();
    return;
  }
  pushHistory({ type: "edit-note", noteId: note.id, before, after });
  recomputeCurrentTick();
  els.statusText.textContent = "編集: " + midiToNoteName(note.pitch) + " " + ticksToBeats(note.durationTicks);
  renderAll();
}

function handleRollDoubleClick(event) {
  if (noteAtRollPoint(event.clientX, event.clientY)) return;
  const point = rollPointFromEvent(event);
  if (point.x < ROLL_LEFT_PAD || point.y < 0 || point.y > ROLL_H) return;
  const pitch = rollYToMidi(point.y);
  const startTick = quantizeStartTicks(xToTick(point.x));
  const ticks = durationTicks();
  if (hasTimelineOverlap(startTick, ticks)) {
    els.statusText.textContent = "重なる位置には追加できません";
    return;
  }
  const note = createNote(pitch, startTick, ticks);
  state.notes.push(note);
  state.selectedNoteId = note.id;
  state.currentTick = note.startTick + note.durationTicks;
  pushHistory({ type: "add-note", noteId: note.id });
  els.statusText.textContent = "追加: " + midiToNoteName(note.pitch);
  renderAll();
}

function detectPitch(buffer, sampleRate) {
  let rms = 0;
  for (let i = 0; i < buffer.length; i++) rms += buffer[i] * buffer[i];
  rms = Math.sqrt(rms / buffer.length);
  if (rms < 0.012) return null;

  const minTau = Math.floor(sampleRate / PITCH_MAX_HZ);
  const maxTau = Math.min(Math.floor(sampleRate / PITCH_MIN_HZ), buffer.length >> 1);
  let bestTau = -1;
  let bestScore = 0;
  let previous = 0;
  let searchingPeak = false;

  for (let tau = minTau; tau <= maxTau; tau++) {
    let ac = 0;
    let divisor = 0;
    for (let i = 0; i < buffer.length - tau; i++) {
      const a = buffer[i];
      const b = buffer[i + tau];
      ac += a * b;
      divisor += a * a + b * b;
    }
    const nsdf = divisor > 0 ? 2 * ac / divisor : 0;
    if (nsdf > previous && nsdf > 0.72) searchingPeak = true;
    if (searchingPeak && nsdf < previous) {
      const score = previous;
      const tauAtPeak = tau - 1;
      if (score > bestScore) {
        bestScore = score;
        bestTau = tauAtPeak;
      }
      searchingPeak = false;
      if (bestScore > 0.93) break;
    }
    previous = nsdf;
  }

  if (bestTau < 0 || bestScore < 0.72) return null;
  const freq = sampleRate / bestTau;
  if (freq < PITCH_MIN_HZ || freq > PITCH_MAX_HZ) return null;
  return { freq, clarity: bestScore, rms };
}

function rememberInputPitch(midi, clarity) {
  const now = performance.now();
  state.pitchHistory.push({ midi, clarity, timeMs: now });
  state.pitchHistory = state.pitchHistory
    .filter(item => now - item.timeMs <= INPUT_PITCH_HISTORY_MS)
    .slice(-INPUT_PITCH_HISTORY_LIMIT);
}

function recentAveragePitch() {
  const now = performance.now();
  const recent = state.pitchHistory.filter(item => now - item.timeMs <= INPUT_PITCH_HISTORY_MS);
  if (!recent.length) return null;
  let weighted = 0;
  let weightSum = 0;
  for (const item of recent) {
    const age = now - item.timeMs;
    const ageWeight = 1 - Math.min(age, INPUT_PITCH_HISTORY_MS) / INPUT_PITCH_HISTORY_MS;
    const weight = Math.max(0.2, item.clarity || 0.5) * Math.max(0.25, ageWeight);
    weighted += item.midi * weight;
    weightSum += weight;
  }
  return weightSum > 0 ? nearestMidi(weighted / weightSum) : null;
}

function updatePitch(pitchResult) {
  if (!pitchResult) {
    state.rawPitch = null;
    state.smoothedMidi = null;
    state.stablePitch = null;
    state.pendingNote = null;
    state.pendingFrames = 0;
    els.noteName.textContent = "—";
    els.noteName.className = "silent";
    els.noteFreq.textContent = "— Hz";
    els.noteCents.textContent = "±0¢";
    els.noteStability.textContent = "NO SIGNAL";
    els.centsFill.style.left = "50%";
    els.centsFill.style.background = "var(--dim)";
    updateInputEnabled();
    return;
  }

  const rawMidi = freqToMidi(pitchResult.freq);
  const smooth = state.smoothedMidi == null ? rawMidi : state.smoothedMidi * 0.72 + rawMidi * 0.28;
  const rounded = Math.round(smooth);
  const cents = midiToCents(smooth);
  const stable = pitchResult.clarity >= 0.78 && Math.abs(cents) <= 42;

  state.rawPitch = { freq: pitchResult.freq, midi: rawMidi, clarity: pitchResult.clarity };
  state.smoothedMidi = smooth;
  rememberInputPitch(smooth, pitchResult.clarity);

  if (rounded === state.pendingNote) {
    state.pendingFrames += 1;
  } else {
    state.pendingNote = rounded;
    state.pendingFrames = 1;
  }

  if (stable && state.pendingFrames >= 3) {
    state.stablePitch = {
      pitch: clamp(rounded, 0, 127),
      freq: pitchResult.freq,
      cents,
      clarity: pitchResult.clarity
    };
  } else if (state.stablePitch && Math.abs(state.stablePitch.pitch - rounded) <= 1 && pitchResult.clarity >= 0.68) {
    state.stablePitch = {
      pitch: state.stablePitch.pitch,
      freq: pitchResult.freq,
      cents,
      clarity: pitchResult.clarity
    };
  } else {
    state.stablePitch = null;
  }

  const displayMidi = state.stablePitch ? state.stablePitch.pitch : smooth;
  const displayCents = midiToCents(smooth);
  els.noteName.textContent = midiToNoteName(displayMidi);
  els.noteName.className = state.stablePitch ? "" : "unstable";
  els.noteFreq.textContent = pitchResult.freq.toFixed(1) + " Hz";
  els.noteCents.textContent = (displayCents >= 0 ? "+" : "") + displayCents + "¢";
  els.noteStability.textContent = state.stablePitch ? "STABLE " + Math.round(pitchResult.clarity * 100) + "%" : "UNSTABLE " + Math.round(pitchResult.clarity * 100) + "%";
  els.centsFill.style.left = clamp(50 + displayCents * 0.5, 0, 100) + "%";
  els.centsFill.style.background = Math.abs(displayCents) < 10 ? "var(--accent)" : "var(--accent-2)";
  updateInputEnabled();
}

function audioLoop() {
  if (!state.analyser) return;
  const buffer = new Float32Array(state.analyser.fftSize);
  state.analyser.getFloatTimeDomainData(buffer);
  state.lastBuffer = buffer;
  updatePitch(detectPitch(buffer, state.audioCtx.sampleRate));
  drawScope(buffer);
  drawKeyboard();
  if (state.holdStart) drawRoll();
  state.rafId = requestAnimationFrame(audioLoop);
}

async function startAudio() {
  try {
    state.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      },
      video: false
    });
    state.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const source = state.audioCtx.createMediaStreamSource(state.stream);
    state.analyser = state.audioCtx.createAnalyser();
    state.analyser.fftSize = 4096;
    state.analyser.smoothingTimeConstant = 0;
    source.connect(state.analyser);
    state.running = true;
    els.btnStart.textContent = "■ 停止";
    els.btnStart.classList.add("active");
    els.statusText.textContent = "音声検出中";
    updateInputEnabled();
    state.rafId = requestAnimationFrame(audioLoop);
  } catch (error) {
    els.statusText.textContent = "マイクのアクセスが拒否されました: " + error.message;
  }
}

function stopAudio() {
  if (state.rafId) cancelAnimationFrame(state.rafId);
  if (state.stream) state.stream.getTracks().forEach(track => track.stop());
  if (state.audioCtx) state.audioCtx.close();
  state.audioCtx = null;
  state.analyser = null;
  state.stream = null;
  state.running = false;
  state.holdStart = null;
  updatePitch(null);
  els.btnStart.textContent = "▶ 開始";
  els.btnStart.classList.remove("active");
  els.statusText.textContent = "停止しました";
  drawKeyboard();
  drawRoll();
}

function currentPitchForInput() {
  if (state.stablePitch) return state.stablePitch.pitch;
  const averaged = recentAveragePitch();
  if (averaged != null) return averaged;
  if (state.smoothedMidi != null) return nearestMidi(state.smoothedMidi);
  if (state.rawPitch) return nearestMidi(state.rawPitch.midi);
  return null;
}

function updateInputEnabled() {
  const ready = state.running && currentPitchForInput() != null;
  const hasSelection = selectedNote() != null;
  els.btnInput.disabled = !ready;
  els.btnInput.classList.toggle("ready", ready);
  els.btnMidi.disabled = state.notes.length === 0;
  els.btnUndo.disabled = state.history.length === 0;
  els.btnDelete.disabled = state.notes.length === 0;
  els.btnFillGap.disabled = !hasSelection;
  els.btnCompact.disabled = state.notes.length === 0;
}

function pushHistory(entry) {
  state.history.push(entry);
  updateInputEnabled();
}

function addStepNote() {
  readBpm();
  const pitch = currentPitchForInput();
  if (pitch == null) {
    els.statusText.textContent = "音程が安定していません";
    return;
  }
  const note = createNote(pitch, state.currentTick, durationTicks());
  if (hasTimelineOverlap(note.startTick, note.durationTicks)) {
    els.statusText.textContent = "重なる位置には入力できません";
    return;
  }
  state.notes.push(note);
  state.selectedNoteId = note.id;
  state.currentTick += note.durationTicks;
  pushHistory({ type: "add-note", noteId: note.id });
  els.statusText.textContent = "入力: " + midiToNoteName(pitch);
  renderAll();
}

function addRest() {
  readBpm();
  const ticks = durationTicks();
  if (hasTimelineOverlap(state.currentTick, ticks)) {
    els.statusText.textContent = "重なる位置には休符を追加できません";
    return;
  }
  const rest = createRest(state.currentTick, ticks);
  state.rests.push(rest);
  state.currentTick += ticks;
  pushHistory({ type: "add-rest", restId: rest.id });
  els.statusText.textContent = "休符: " + durationLabel();
  renderAll();
}

function startHoldInput() {
  if (state.mode !== "hold" || state.holdStart) return;
  readBpm();
  const pitch = currentPitchForInput();
  if (pitch == null) {
    els.statusText.textContent = "音程が安定していません";
    return;
  }
  state.holdStart = {
    pitch,
    startTick: state.currentTick,
    timeMs: performance.now()
  };
  els.btnInput.classList.add("pressed");
  els.statusText.textContent = "記録中: " + midiToNoteName(pitch);
  drawRoll();
}

function finishHoldInput() {
  if (!state.holdStart) return;
  readBpm();
  const elapsedSec = (performance.now() - state.holdStart.timeMs) / 1000;
  const duration = quantizeTicks(secondsToTicks(elapsedSec));
  const note = createNote(state.holdStart.pitch, state.holdStart.startTick, duration);
  if (hasTimelineOverlap(note.startTick, note.durationTicks)) {
    els.btnInput.classList.remove("pressed");
    state.holdStart = null;
    els.statusText.textContent = "重なる位置には入力できません";
    renderAll();
    return;
  }
  state.notes.push(note);
  state.selectedNoteId = note.id;
  state.currentTick = note.startTick + note.durationTicks;
  pushHistory({ type: "add-note", noteId: note.id });
  els.btnInput.classList.remove("pressed");
  state.holdStart = null;
  els.statusText.textContent = "確定: " + midiToNoteName(note.pitch) + " " + ticksToBeats(note.durationTicks);
  renderAll();
}

function undo() {
  const last = state.history.pop();
  if (!last) return;
  if (last.type === "add-note") {
    const index = state.notes.findIndex(note => note.id === last.noteId);
    if (index >= 0) state.notes.splice(index, 1);
    if (state.selectedNoteId === last.noteId) state.selectedNoteId = null;
    recomputeCurrentTick();
  }
  if (last.type === "edit-note") {
    restoreNote(last.before);
    state.selectedNoteId = last.before.id;
    recomputeCurrentTick();
  }
  if (last.type === "delete-note") {
    restoreNote(last.note);
    state.selectedNoteId = last.note.id;
    recomputeCurrentTick();
  }
  if (last.type === "add-rest") {
    const index = state.rests.findIndex(rest => rest.id === last.restId);
    if (index >= 0) state.rests.splice(index, 1);
    recomputeCurrentTick();
  }
  if (last.type === "delete-rest") {
    restoreRest(last.rest);
    recomputeCurrentTick();
  }
  if (last.type === "compact" || last.type === "fill-gap") {
    restoreTimeline(last.before);
  }
  els.statusText.textContent = "Undo";
  renderAll();
}

function deleteSelectedOrLastNote() {
  const sorted = [...state.notes].sort(compareNotes);
  const note = selectedNote() || sorted[sorted.length - 1];
  if (!note) return;
  const index = state.notes.findIndex(item => item.id === note.id);
  if (index >= 0) state.notes.splice(index, 1);
  state.selectedNoteId = null;
  pushHistory({ type: "delete-note", note: cloneNote(note) });
  recomputeCurrentTick();
  els.statusText.textContent = "ノートを削除しました";
  renderAll();
}

function editSelectedNote(mutator, label) {
  const note = selectedNote();
  if (!note) {
    els.statusText.textContent = "編集するノートを選択してください";
    return;
  }
  const before = cloneNote(note);
  mutator(note);
  note.pitch = clamp(Math.round(note.pitch), 0, 127);
  note.durationTicks = Math.max(gridTicks(), Math.round(note.durationTicks));
  note.startTick = clampStartToTimeline(note.startTick, note.durationTicks, before.startTick, { excludeType: "note", excludeId: note.id });
  if (hasTimelineOverlap(note.startTick, note.durationTicks, { excludeType: "note", excludeId: note.id })) {
    Object.assign(note, before);
    els.statusText.textContent = "重なる位置には編集できません";
    renderAll();
    return;
  }
  const after = cloneNote(note);
  if (before.pitch === after.pitch && before.startTick === after.startTick && before.durationTicks === after.durationTicks) return;
  pushHistory({ type: "edit-note", noteId: note.id, before, after });
  recomputeCurrentTick();
  els.statusText.textContent = label + ": " + midiToNoteName(note.pitch) + " " + ticksToBeats(note.durationTicks);
  renderAll();
}

function fillSelectedGap() {
  const note = selectedNote();
  if (!note) {
    els.statusText.textContent = "詰めるノートを選択してください";
    return;
  }
  const before = snapshotTimeline();
  const previousNote = [...state.notes]
    .filter(item => item.id !== note.id && item.startTick + item.durationTicks <= note.startTick)
    .sort((a, b) => (b.startTick + b.durationTicks) - (a.startTick + a.durationTicks))[0];
  const targetStart = previousNote ? previousNote.startTick + previousNote.durationTicks : 0;
  if (targetStart >= note.startTick) {
    els.statusText.textContent = "詰める空白がありません";
    return;
  }
  const oldStart = note.startTick;
  state.rests = state.rests
    .map(rest => {
      const end = rest.startTick + rest.durationTicks;
      if (rest.startTick >= targetStart && end <= oldStart) return null;
      if (rest.startTick < targetStart && end > targetStart && end <= oldStart) {
        return { ...rest, durationTicks: targetStart - rest.startTick };
      }
      if (rest.startTick >= targetStart && rest.startTick < oldStart && end > oldStart) {
        return { ...rest, startTick: oldStart, durationTicks: end - oldStart };
      }
      return rest;
    })
    .filter(Boolean);
  note.startTick = targetStart;
  const after = snapshotTimeline();
  pushHistory({ type: "fill-gap", before, after });
  recomputeCurrentTick();
  els.statusText.textContent = "選択ノートを前に詰めました";
  renderAll();
}

function compactTimeline() {
  if (!state.notes.length) return;
  const before = snapshotTimeline();
  let cursor = 0;
  const sorted = [...state.notes].sort(compareNotes);
  for (const note of sorted) {
    note.startTick = cursor;
    cursor += note.durationTicks;
  }
  state.rests = [];
  state.currentTick = cursor;
  const after = snapshotTimeline();
  pushHistory({ type: "compact", before, after });
  els.statusText.textContent = "空白を詰めました";
  renderAll();
}

function clearAll() {
  state.notes = [];
  state.rests = [];
  state.history = [];
  state.currentTick = 0;
  state.selectedNoteId = null;
  state.holdStart = null;
  els.statusText.textContent = "記録をクリアしました";
  renderAll();
}

function ticksToBeats(ticks) {
  return (ticks / TPQN).toFixed(2) + " beats";
}

function durationLabel() {
  return "1/" + state.durationDenom;
}

function formatPosition(tick) {
  const ticksPerBar = TPQN * 4;
  const bar = Math.floor(tick / ticksPerBar) + 1;
  const inBar = tick % ticksPerBar;
  const beat = Math.floor(inBar / TPQN) + 1;
  const sub = inBar % TPQN;
  return bar + "." + beat + "." + String(sub).padStart(3, "0");
}

function updateSummary() {
  const noteEnds = state.notes.map(note => note.startTick + note.durationTicks);
  const restEnds = state.rests.map(rest => rest.startTick + rest.durationTicks);
  const maxEnd = Math.max(state.currentTick, ...noteEnds, ...restEnds, 0);
  const bars = maxEnd / (TPQN * 4);
  els.noteCount.textContent = String(state.notes.length);
  els.positionReadout.textContent = formatPosition(state.currentTick);
  els.lengthReadout.textContent = bars.toFixed(2) + " bars / " + ticksToSeconds(maxEnd).toFixed(1) + " s";
}

function updateNotesList() {
  els.notesList.innerHTML = "";
  const sorted = [...state.notes].sort(compareNotes);
  for (const note of sorted) {
    const chip = document.createElement("div");
    chip.className = "note-chip";
    chip.classList.toggle("selected", note.id === state.selectedNoteId);
    chip.dataset.noteId = String(note.id);
    chip.textContent = midiToNoteName(note.pitch) + " @" + formatPosition(note.startTick) + " " + ticksToBeats(note.durationTicks);
    els.notesList.appendChild(chip);
  }
}

function renderAll() {
  updateSummary();
  updateNotesList();
  updateInputEnabled();
  drawRoll();
}

function buildMidi(notes) {
  return buildMidiBytes(notes, state.bpm, { clamp, compareNotes, cloneNote });
}

function normalizeNotesForMidi(notes) {
  return normalizeNotesForMidiBytes(notes, { clamp, compareNotes, cloneNote });
}

function downloadMidi() {
  if (!state.notes.length) return;
  readBpm();
  const bytes = buildMidi(state.notes);
  const blob = new Blob([bytes], { type: "audio/midi" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "hum-to-midi.mid";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
  els.statusText.textContent = "MIDIファイルをダウンロードしました";
}

function handleInputPress() {
  if (state.mode === "step") addStepNote();
  else startHoldInput();
}

function handleInputRelease() {
  if (state.mode === "hold") finishHoldInput();
}

els.btnStart.addEventListener("click", () => state.running ? stopAudio() : startAudio());
els.modeStep.addEventListener("click", () => setMode("step"));
els.modeHold.addEventListener("click", () => setMode("hold"));
els.btnInput.addEventListener("mousedown", handleInputPress);
els.btnInput.addEventListener("touchstart", event => {
  event.preventDefault();
  handleInputPress();
}, { passive: false });
document.addEventListener("mouseup", handleInputRelease);
document.addEventListener("touchend", handleInputRelease);
els.btnRest.addEventListener("click", addRest);
els.btnUndo.addEventListener("click", undo);
els.btnDelete.addEventListener("click", deleteSelectedOrLastNote);
els.btnFillGap.addEventListener("click", fillSelectedGap);
els.btnCompact.addEventListener("click", compactTimeline);
els.btnClear.addEventListener("click", clearAll);
els.btnMidi.addEventListener("click", downloadMidi);
els.bpmInput.addEventListener("input", readBpm);
els.bpmInput.addEventListener("change", readBpm);
els.roll.addEventListener("click", handleRollClick);
els.roll.addEventListener("dblclick", handleRollDoubleClick);
els.roll.addEventListener("mousedown", handleRollMouseDown);
document.addEventListener("mousemove", handleRollMouseMove);
document.addEventListener("mouseup", finishRollDrag);
els.rollWrap.addEventListener("scroll", () => {
  state.view.scrollX = els.rollWrap.scrollLeft;
});
els.notesList.addEventListener("click", event => {
  const chip = event.target.closest(".note-chip");
  if (!chip) return;
  selectNote(Number.parseInt(chip.dataset.noteId, 10));
});

els.durationGrid.addEventListener("click", event => {
  const button = event.target.closest("button[data-denom]");
  if (!button) return;
  state.durationDenom = Number.parseInt(button.dataset.denom, 10);
  for (const item of els.durationGrid.querySelectorAll("button")) {
    item.classList.toggle("active", item === button);
  }
  els.statusText.textContent = "音価: " + durationLabel();
  drawRoll();
});

document.addEventListener("keydown", event => {
  if (event.code === "Space" && !event.repeat) {
    event.preventDefault();
    handleInputPress();
  }
  if ((event.code === "Delete" || event.code === "Backspace") && event.target !== els.bpmInput) {
    event.preventDefault();
    deleteSelectedOrLastNote();
  }
});

document.addEventListener("keyup", event => {
  if (event.code !== "Space") return;
  event.preventDefault();
  handleInputRelease();
});

window.addEventListener("resize", resizeCanvases);
window.addEventListener("load", () => {
  resizeCanvases();
  readBpm();
  renderAll();
});

window.__humToMidiTest = {
  freqToMidi,
  midiToFreq,
  midiToNoteName,
  midiToCents,
  buildMidi,
  normalizeNotesForMidi,
  createNote,
  createRest,
  editSelectedNote,
  deleteSelectedOrLastNote,
  timelineItems,
  hasTimelineOverlap,
  fillSelectedGap,
  compactTimeline,
  tickToX,
  xToTick,
  effectivePxPerTick,
  recomputeCurrentTick,
  currentPitchForInput,
  recentAveragePitch,
  appendVlq,
  durationTicks,
  gridTicks,
  state,
  TPQN
};
