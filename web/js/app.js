const WORLD_W = 1000;
const DEFAULT_LINK = 0.14;
const BOARD_STEP = 0.25;
const BOARD_MAX = 2;
// Camera height as a fraction of the plan width. A linked pin is a point on the
// floor, so its distance on the plan sets how far below the horizon its marker sits.
const PLAN_EYE = 0.045;
const EYE_METERS = 1.55;
const adminMode = /^\/admin\/?$/.test(window.location.pathname);

const $ = (id) => document.getElementById(id);

function logRecord(level, msg, fields = {}) {
  const record = { time: new Date().toISOString(), level, msg };
  for (const [key, value] of Object.entries(fields)) {
    if (value instanceof Error) {
      record[key] = value.message;
      if (value.stack) record.stack = value.stack;
    } else if (value !== undefined) {
      record[key] = value;
    }
  }
  const line = JSON.stringify(record);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.info(line);
}

const log = {
  info: (msg, fields) => logRecord("info", msg, fields),
  warn: (msg, fields) => logRecord("warn", msg, fields),
  error: (msg, fields) => logRecord("error", msg, fields),
};

const els = {
  map: $("map"),
  tray: $("tray-list"),
  trayCount: $("tray-count"),
  search: $("search"),
  save: $("save-state"),
  fit: $("fit"),
  boardLeft: $("board-left"),
  boardRight: $("board-right"),
  boardUp: $("board-up"),
  boardDown: $("board-down"),
  reset: $("reset"),
  removeAll: $("remove-all"),
  addPin: $("add-pin"),
  mapHint: $("map-hint"),
  planFile: $("floorplan-file"),
  removePlan: $("remove-plan"),
  empty: $("inspector-empty"),
  inspector: $("inspector"),
  photoPick: $("photo-pick"),
  dayThumb: $("day-thumb"),
  nightThumb: $("night-thumb"),
  dayLabel: $("day-label"),
  nightLabel: $("night-label"),
  setDay: $("set-day"),
  setNight: $("set-night"),
  clearDay: $("clear-day"),
  clearNight: $("clear-night"),
  removePin: $("remove-pin"),
  name: $("insp-name"),
  placeYaw: $("place-yaw"),
  placeYawVal: $("place-yaw-val"),
  jumpList: $("jump-list"),
  addJump: $("add-jump"),
  walk: $("walk"),
  opacityWrap: $("plan-opacity-wrap"),
  opacity: $("plan-opacity"),
  viewer: $("viewer"),
  pano: $("pano"),
  hotspots: $("hotspots"),
  fade: $("fade"),
  loadMask: $("load-mask"),
  loadText: $("load-text"),
  back: $("back"),
  viewerName: $("viewer-name"),
  facing: $("facing"),
  showDay: $("show-day"),
  showNight: $("show-night"),
  yawLeft: $("yaw-left"),
  yawRight: $("yaw-right"),
  align: $("align"),
  minimap: $("minimap"),
  noLinks: $("no-links"),
  viewerError: $("viewer-error"),
  vrPanel: $("vr-panel"),
  enterVr: $("enter-vr"),
  vrNote: $("vr-note"),
};

const ctx = els.map.getContext("2d");
const state = {
  photos: [],
  tour: null,
  selected: null,
  selectedPhoto: null,
  hover: null,
  placing: false,
  time: "day",
  scale: 1,
  panX: 40,
  panY: 40,
  floorplanImage: null,
  undo: [],
  saveTimer: 0,
  drag: null,
  thumbVersion: {},
};

const look = { yaw: 0, pitch: 0, fov: 1.15 };
let xrSession = null;
const vr = {
  supported: false,
  refSpace: null,
  layer: null,
  aligned: false,
  headYaw: 0,
  yawOffset: 0,
  headForward: [0, 0, -1],
  headPos: [0, 0, 0],
  markers: [],
  lastTime: 0,
  hintUntil: 0,
  hands: {
    left: { a: false, trigger: false, forward: false },
    right: { a: false, trigger: false, forward: false },
    none: { a: false, trigger: false, forward: false },
  },
};

function setViewYaw(yaw) {
  look.yaw = yaw;
  if (xrSession && vr.aligned) vr.yawOffset = vr.headYaw - yaw;
}
let viewerPlaceId = null;
let viewerTime = "day";
let viewerFile = null;
let placedAt = 0;
const MAP_HINT = "Click Add pin, then click the plan. Drag a pin to move it. Drag the arrow to turn the place. Drag a linked pin closer or farther to move its marker in the photo. Expand adds space around the grid.";
let loadToken = 0;
let glContext = null;
let miniGeom = null;
const hotspotEls = new Map();

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function wrapDeg(degrees) {
  return ((degrees + 180) % 360 + 360) % 360 - 180;
}

function timeLabel(file) {
  const match = String(file || "").match(/_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})_/);
  if (!match) return file || "";
  let hour = Number(match[4]);
  const minute = match[5];
  const suffix = hour >= 12 ? "PM" : "AM";
  hour = hour % 12 || 12;
  return `${hour}:${minute} ${suffix}`;
}

function capturePeriod(file) {
  const match = String(file || "").match(/_(\d{8})_(\d{2})\d{4}_/);
  if (!match) return "day";
  const hour = Number(match[2]);
  return hour >= 20 || hour < 6 ? "night" : "day";
}

function newId() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function planDelta(a, b) {
  const { base } = worldSize();
  const dx = b.nx - a.nx;
  const dy = (b.ny - a.ny) * (base.h / base.w);
  return { dx, dy, ground: Math.hypot(dx, dy) };
}

function planBearing(a, b) {
  const { dx, dy } = planDelta(a, b);
  return Math.atan2(dx, -dy);
}

function markerAim(from, to) {
  const { dx, dy, ground } = planDelta(from, to);
  const span = Math.max(ground, 0.004);
  const slant = Math.hypot(span, PLAN_EYE);
  return {
    imageYaw: Math.atan2(dx, -dy) - (from.yaw * Math.PI) / 180,
    imagePitch: -Math.atan2(PLAN_EYE, span),
    meters: slant * (EYE_METERS / PLAN_EYE),
    scale: clamp(0.105 / slant, 0.48, 1.45),
  };
}

function photoNumber(file) {
  const index = state.photos.indexOf(file);
  return index < 0 ? "?" : String(index + 1);
}

function placeById(id) {
  return state.tour.spots.find((spot) => spot.id === id) || null;
}

function placeByFile(file) {
  if (!file) return null;
  return state.tour.spots.find((spot) => spot.day === file || spot.night === file) || null;
}

function selectedSpot() {
  return state.selected ? placeById(state.selected) : null;
}

function viewerSpot() {
  return viewerPlaceId ? placeById(viewerPlaceId) : null;
}

function hasPhoto(spot) {
  return Boolean(spot && (spot.day || spot.night));
}

function shownTime(spot, preferred) {
  if (!spot) return null;
  if (preferred === "night" && spot.night) return "night";
  if (preferred !== "night" && spot.day) return "day";
  if (spot.day) return "day";
  if (spot.night) return "night";
  return null;
}

function shownFile(spot, preferred) {
  const time = shownTime(spot, preferred);
  return time ? spot[time] : null;
}

function pinNumber(spot) {
  const index = state.tour.spots.indexOf(spot);
  return index < 0 ? "?" : String(index + 1);
}

function pinLabel(spot) {
  return `${pinNumber(spot)} · ${spot.name}`;
}

function setSpotYaw(spot, yaw) {
  spot.yaw = wrapDeg(yaw);
}

function legacyFacing(raw) {
  const shared = readYaw(raw.yaw, 0);
  const hasDay = Object.prototype.hasOwnProperty.call(raw, "dayYaw");
  const hasNight = Object.prototype.hasOwnProperty.call(raw, "nightYaw");
  if (!hasDay && !hasNight) return { yaw: shared, nightShift: 0 };
  const dayYaw = hasDay ? readYaw(raw.dayYaw, shared) : shared;
  const nightYaw = hasNight ? readYaw(raw.nightYaw, dayYaw) : dayYaw;
  if (typeof raw.day === "string" && raw.day) {
    const nightShift = typeof raw.night === "string" && raw.night && nightYaw !== dayYaw
      ? wrapDeg(dayYaw - nightYaw)
      : 0;
    return { yaw: dayYaw, nightShift };
  }
  return { yaw: typeof raw.night === "string" && raw.night ? nightYaw : dayYaw, nightShift: 0 };
}

function readYaw(value, fallback) {
  const yaw = Number(value);
  return Number.isFinite(yaw) ? wrapDeg(yaw) : fallback;
}

function fallbackName(spot) {
  const file = spot.day || spot.night;
  return file ? timeLabel(file) : "Pin";
}

function dist(a, b) {
  return Math.hypot(b.nx - a.nx, b.ny - a.ny);
}

function neighborsOf(spot) {
  if (!spot || !Array.isArray(spot.links)) return [];
  const ids = new Set(spot.links);
  return state.tour.spots
    .filter((other) => other !== spot && ids.has(other.id) && hasPhoto(other))
    .sort((a, b) => dist(spot, a) - dist(spot, b));
}

function reachableNeighbors(spot, time) {
  const mode = time === "night" ? "night" : "day";
  return neighborsOf(spot).filter((other) => Boolean(other[mode]));
}

function addJump(fromId, toId) {
  const spot = placeById(fromId);
  if (!spot || !toId || fromId === toId) return;
  if (!Array.isArray(spot.links)) spot.links = [];
  if (spot.links.includes(toId)) return;
  spot.links.push(toId);
  scheduleSave();
  syncInspector();
  requestDraw();
}

function removeJump(fromId, toId) {
  const spot = placeById(fromId);
  if (!spot || !Array.isArray(spot.links)) return;
  spot.links = spot.links.filter((id) => id !== toId);
  scheduleSave();
  syncInspector();
  requestDraw();
}

function forgetJumps(id) {
  for (const spot of state.tour.spots) {
    if (!Array.isArray(spot.links)) continue;
    spot.links = spot.links.filter((link) => link !== id);
  }
}

function makeSpot(file, nx, ny) {
  const night = capturePeriod(file) === "night";
  return {
    id: newId(),
    name: timeLabel(file),
    nx,
    ny,
    yaw: 0,
    day: night ? null : file,
    night: night ? file : null,
    links: [],
  };
}

function defaultSpots(files) {
  const columns = 8;
  const rows = Math.ceil(files.length / columns) || 1;
  const spots = files.map((file, index) => {
    const row = Math.floor(index / columns);
    let column = index % columns;
    if (row % 2 === 1) column = columns - 1 - column;
    const nx = columns === 1 ? 0.5 : 0.08 + (column / (columns - 1)) * 0.84;
    const ny = rows === 1 ? 0.5 : 0.1 + (row / (rows - 1)) * 0.8;
    return makeSpot(file, nx, ny);
  });
  for (let index = 0; index < spots.length; index += 1) {
    const next = spots[index + 1] || spots[index - 1];
    if (!next) continue;
    spots[index].yaw = wrapDeg((planBearing(spots[index], next) * 180) / Math.PI);
  }
  return spots;
}

function readBoard(raw) {
  const side = (value) => {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.min(BOARD_MAX, Math.round(n * 1000) / 1000);
  };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const board = {
    left: side(raw.left),
    right: side(raw.right),
    top: side(raw.top),
    bottom: side(raw.bottom),
  };
  if (!board.left && !board.right && !board.top && !board.bottom) return null;
  return board;
}

function loadLimits(board) {
  const edges = board || { left: 0, right: 0, top: 0, bottom: 0 };
  return {
    minX: -edges.left,
    maxX: 1 + edges.right,
    minY: -edges.top,
    maxY: 1 + edges.bottom,
  };
}

function readPinCoord(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return clamp(0, min, max);
  return clamp(n, min, max);
}

function normalizeSpot(raw, claim, seenIds, limits, thumbYaw) {
  let day = claim(raw.day);
  let night = claim(raw.night);
  const legacy = claim(raw.file);
  if (!day && !night && legacy) {
    if (capturePeriod(legacy) === "night") night = legacy;
    else day = legacy;
  }
  const facing = legacyFacing(raw);
  if (night && facing.nightShift) {
    const current = Number(thumbYaw[night]) || 0;
    const next = Math.round(wrapDeg(current + facing.nightShift));
    if (next === 0) delete thumbYaw[night];
    else thumbYaw[night] = next;
    migratedThumbs.push(night);
  }
  let id = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : newId();
  while (seenIds.has(id)) id = newId();
  seenIds.add(id);
  const named = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim().slice(0, 48) : "";
  return {
    id,
    name: named || (day || night ? timeLabel(day || night) : "Pin"),
    nx: readPinCoord(raw.nx, limits.minX, limits.maxX),
    ny: readPinCoord(raw.ny, limits.minY, limits.maxY),
    yaw: facing.yaw,
    day,
    night,
    links: Array.isArray(raw.links)
      ? [...new Set(raw.links.filter((id) => typeof id === "string" && id && id !== raw.id))]
      : null,
  };
}

function needsMigration(saved) {
  if (!saved || !Array.isArray(saved.spots)) return false;
  return saved.spots.some((spot) => (
    typeof spot.id !== "string"
    || Object.prototype.hasOwnProperty.call(spot, "file")
    || !Object.prototype.hasOwnProperty.call(spot, "day")
    || !Object.prototype.hasOwnProperty.call(spot, "yaw")
    || Object.prototype.hasOwnProperty.call(spot, "dayYaw")
    || Object.prototype.hasOwnProperty.call(spot, "nightYaw")
    || !Array.isArray(spot.links)
  ));
}

function readThumbYaws(saved, files) {
  const out = {};
  const raw = saved && saved.thumbYaw;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const file of files) {
    const yaw = Number(raw[file]);
    if (Number.isFinite(yaw) && yaw !== 0) out[file] = Math.min(180, Math.max(-180, yaw));
  }
  return out;
}

let migratedThumbs = [];

function mergeTour(saved, files) {
  migratedThumbs = [];
  const link = Number(saved?.linkDistance);
  const base = {
    version: 2,
    linkDistance: Number.isFinite(link) ? clamp(link, 0.04, 0.45) : DEFAULT_LINK,
    floorplan: floorplanRef(saved?.floorplan),
    planOpacity: clamp(Number(saved?.planOpacity) || 0.88, 0.25, 1),
    thumbYaw: readThumbYaws(saved, files),
    spots: [],
  };
  const board = readBoard(saved?.board);
  if (board) base.board = board;
  if (!saved || !Array.isArray(saved.spots)) {
    base.spots = defaultSpots(files);
    return base;
  }
  const used = new Set();
  const seenIds = new Set();
  const claim = (file) => {
    if (typeof file !== "string" || !files.includes(file) || used.has(file)) return null;
    used.add(file);
    return file;
  };
  const limits = loadLimits(board);
  base.spots = saved.spots
    .filter((spot) => spot && typeof spot === "object")
    .map((spot) => normalizeSpot(spot, claim, seenIds, limits, base.thumbYaw));
  const limit = base.linkDistance;
  for (const spot of base.spots) {
    if (Array.isArray(spot.links)) {
      const ids = new Set(base.spots.map((other) => other.id));
      spot.links = spot.links.filter((id) => ids.has(id) && id !== spot.id);
      continue;
    }
    spot.links = base.spots
      .filter((other) => other !== spot && dist(spot, other) >= 0.008 && dist(spot, other) <= limit)
      .map((other) => other.id);
  }
  return base;
}

function assignPhoto(file, spot, time) {
  if (!file || !spot || (time !== "day" && time !== "night")) return false;
  if (spot[time] === file) return false;
  const owner = placeByFile(file);
  if (owner && owner.id !== spot.id) {
    const role = owner.day === file ? "day" : "night";
    const ok = confirm(`Move this ${role} photo from “${owner.name}” onto “${spot.name}” as its ${time} shot?`);
    if (!ok) return false;
  }
  for (const other of state.tour.spots) {
    if (other.day === file) other.day = null;
    if (other.night === file) other.night = null;
  }
  spot[time] = file;
  const removed = new Set(
    state.tour.spots
      .filter((other) => other.id !== spot.id && !other.day && !other.night)
      .map((other) => other.id),
  );
  if (removed.size) {
    for (const id of removed) forgetJumps(id);
    state.tour.spots = state.tour.spots.filter((other) => !removed.has(other.id));
    state.undo = state.undo.filter((entry) => !removed.has(entry.id));
    if (removed.has(state.selected)) state.selected = spot.id;
    if (removed.has(viewerPlaceId)) closeViewer();
  }
  return true;
}

function clearSlot(time) {
  const spot = selectedSpot();
  if (!spot || (time !== "day" && time !== "night") || !spot[time]) return;
  spot[time] = null;
  scheduleSave();
  syncInspector();
  renderTray();
  requestDraw();
  if (viewerPlaceId === spot.id) {
    const next = shownTime(spot, state.time);
    if (!next) {
      closeViewer();
      return;
    }
    state.time = next;
    if (viewerTime !== next) switchTime(next);
  }
}

function baseSize() {
  const aspect = state.floorplanImage
    ? state.floorplanImage.width / state.floorplanImage.height
    : 1000 / 700;
  return { w: WORLD_W, h: WORLD_W / aspect };
}

function activeBoard() {
  return readBoard(state.tour?.board) || { left: 0, right: 0, top: 0, bottom: 0 };
}

function worldSize() {
  const base = baseSize();
  const board = activeBoard();
  return {
    w: base.w * (1 + board.left + board.right),
    h: base.h * (1 + board.top + board.bottom),
    base,
    board,
  };
}

function contentToSheet(nx, ny, board = activeBoard()) {
  const spanX = 1 + board.left + board.right;
  const spanY = 1 + board.top + board.bottom;
  return {
    nx: (board.left + nx) / spanX,
    ny: (board.top + ny) / spanY,
  };
}

function sheetToContent(nx, ny, board = activeBoard()) {
  const spanX = 1 + board.left + board.right;
  const spanY = 1 + board.top + board.bottom;
  return {
    nx: nx * spanX - board.left,
    ny: ny * spanY - board.top,
  };
}

function pinToScreen(nx, ny) {
  const sheet = contentToSheet(nx, ny);
  return worldToScreen(sheet.nx, sheet.ny);
}

function pinLimits(inset) {
  const board = activeBoard();
  return {
    minX: -board.left + inset,
    maxX: 1 + board.right - inset,
    minY: -board.top + inset,
    maxY: 1 + board.bottom - inset,
  };
}

function sheetFits() {
  const rect = els.map.getBoundingClientRect();
  if (rect.width < 20 || rect.height < 20) return false;
  const origin = worldToScreen(0, 0);
  const far = worldToScreen(1, 1);
  return origin.x >= -8 && origin.y >= -8 && far.x <= rect.width + 8 && far.y <= rect.height + 8;
}

function nudgeBoardView(side, delta) {
  const base = baseSize();
  if (side === "left") state.panX -= base.w * delta * state.scale;
  if (side === "top") state.panY -= base.h * delta * state.scale;
}

function changeBoard(side, grow) {
  const current = { ...activeBoard() };
  const fitted = sheetFits();
  let delta = 0;
  if (grow) {
    if (current[side] >= BOARD_MAX - 0.001) return;
    delta = Math.min(BOARD_STEP, BOARD_MAX - current[side]);
    current[side] = Math.round((current[side] + delta) * 1000) / 1000;
  } else {
    if (current[side] <= 0) return;
    delta = -Math.min(BOARD_STEP, current[side]);
    const proposed = { ...current, [side]: Math.round((current[side] + delta) * 1000) / 1000 };
    const blocked = state.tour.spots.some((spot) => (
      spot.nx < -proposed.left - 1e-6
      || spot.nx > 1 + proposed.right + 1e-6
      || spot.ny < -proposed.top - 1e-6
      || spot.ny > 1 + proposed.bottom + 1e-6
    ));
    if (blocked) {
      setSaveStatus("Pins are in that space", true);
      return;
    }
    current[side] = proposed[side];
  }
  if (!current.left && !current.right && !current.top && !current.bottom) delete state.tour.board;
  else state.tour.board = current;
  if (fitted) fitMap();
  else nudgeBoardView(side, delta);
  scheduleSave();
  requestDraw();
}

function worldToScreen(nx, ny) {
  const { w, h } = worldSize();
  return {
    x: state.panX + nx * w * state.scale,
    y: state.panY + ny * h * state.scale,
  };
}

function screenToNorm(sx, sy) {
  const { w, h } = worldSize();
  return {
    nx: (sx - state.panX) / (state.scale * w),
    ny: (sy - state.panY) / (state.scale * h),
  };
}

function photoUrl(file) {
  return `media/photos/${encodeURIComponent(file)}`;
}

function thumbUrl(file) {
  const version = state.thumbVersion[file];
  const base = `media/thumbs/${encodeURIComponent(file)}`;
  return version ? `${base}?v=${version}` : base;
}

function thumbYawOf(file) {
  const yaw = Number(state.tour?.thumbYaw?.[file]);
  return Number.isFinite(yaw) ? Math.min(180, Math.max(-180, yaw)) : 0;
}

const thumbPreview = new Map();
const thumbSources = new Map();
const thumbSaveTimers = new Map();
let thumbToken = 0;

function loadThumbSource(file) {
  if (thumbSources.has(file)) return thumbSources.get(file);
  const pending = new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("could not load photo"));
    image.src = photoUrl(file);
  });
  thumbSources.set(file, pending);
  return pending;
}

function paintThumb(image, yaw) {
  const cropW = image.width * 90 / 360;
  const cropH = image.height * 58 / 180;
  const top = (image.height - cropH) / 2;
  let left = image.width / 2 + (yaw / 360) * image.width - cropW / 2;
  left = ((left % image.width) + image.width) % image.width;
  const canvas = document.createElement("canvas");
  canvas.width = 520;
  canvas.height = Math.max(1, Math.round(520 * cropH / cropW));
  const context = canvas.getContext("2d");
  if (left + cropW <= image.width) {
    context.drawImage(image, left, top, cropW, cropH, 0, 0, canvas.width, canvas.height);
  } else {
    const first = image.width - left;
    const destFirst = canvas.width * first / cropW;
    context.drawImage(image, left, top, first, cropH, 0, 0, destFirst, canvas.height);
    context.drawImage(image, 0, top, cropW - first, cropH, destFirst, 0, canvas.width - destFirst, canvas.height);
  }
  return canvas.toDataURL("image/jpeg", 0.82);
}

function showThumb(file, url) {
  const row = els.tray.querySelector(`[data-photo="${CSS.escape(file)}"] img`);
  if (row) row.src = url;
  for (const thumb of [els.dayThumb, els.nightThumb]) {
    if (thumb.dataset.file === file) thumb.src = url;
  }
}

async function refreshThumbPreview(file, yaw) {
  const token = ++thumbToken;
  try {
    const image = await loadThumbSource(file);
    if (token !== thumbToken) return;
    const current = thumbYawOf(file);
    const url = paintThumb(image, current);
    thumbPreview.set(file, { yaw: current, url });
    showThumb(file, url);
  } catch (error) {
    log.warn("thumbnail preview failed", { file, error });
    setSaveStatus("Thumbnail not updated", true);
  }
}

function scheduleThumbFile(file, yaw) {
  clearTimeout(thumbSaveTimers.get(file));
  thumbSaveTimers.set(file, setTimeout(() => saveThumbFile(file, yaw), 400));
}

async function saveThumbFile(file, yaw) {
  try {
    const response = await fetch("/api/thumb", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file, yaw }),
    });
    if (!response.ok) throw new Error("thumb failed");
    state.thumbVersion[file] = Date.now();
  } catch (error) {
    log.error("thumbnail not saved", { file, error });
    setSaveStatus("Thumbnail not saved", true);
  }
}

function setThumbYaw(file, yaw) {
  if (!state.tour.thumbYaw) state.tour.thumbYaw = {};
  const next = Math.min(180, Math.max(-180, yaw));
  if (next === 0) delete state.tour.thumbYaw[file];
  else state.tour.thumbYaw[file] = next;
  scheduleSave();
  refreshThumbPreview(file, next);
  scheduleThumbFile(file, next);
}

function floorplanRef(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const name = value.trim().replace(/^\/+/, "");
  if (name.startsWith("media/")) return name;
  return `media/plans/${name.split("/").pop()}`;
}

function setSaveStatus(text, warn) {
  els.save.textContent = text;
  els.save.classList.toggle("warn", Boolean(warn));
}

function scheduleSave() {
  setSaveStatus("Saving");
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(saveNow, 350);
}

async function saveNow() {
  clearTimeout(state.saveTimer);
  if (state.tour?.thumbYaw && Object.keys(state.tour.thumbYaw).length === 0) {
    delete state.tour.thumbYaw;
  }
  if (state.tour && !readBoard(state.tour.board)) delete state.tour.board;
  try {
    const response = await fetch("/api/tour", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(state.tour),
      keepalive: true,
    });
    if (!response.ok) throw new Error("save failed");
    setSaveStatus("Saved");
  } catch (error) {
    log.error("tour not saved", { error });
    setSaveStatus("Not saved", true);
  }
}

function pushUndo(spot) {
  state.undo.push({
    id: spot.id,
    nx: spot.nx,
    ny: spot.ny,
    yaw: spot.yaw,
  });
  if (state.undo.length > 50) state.undo.shift();
}

function undo() {
  const entry = state.undo.pop();
  if (!entry) return;
  const spot = placeById(entry.id);
  if (!spot) return;
  spot.nx = entry.nx;
  spot.ny = entry.ny;
  spot.yaw = entry.yaw;
  state.selected = spot.id;
  scheduleSave();
  syncInspector();
  renderTray();
  requestDraw();
}

let drawRaf = 0;
function requestDraw() {
  if (drawRaf) return;
  drawRaf = requestAnimationFrame(() => {
    drawRaf = 0;
    drawMap();
  });
}

function fitMap() {
  const rect = els.map.getBoundingClientRect();
  if (rect.width < 20 || rect.height < 20) return;
  const { w, h } = worldSize();
  const pad = 56;
  state.scale = Math.min((rect.width - pad * 2) / w, (rect.height - pad * 2) / h);
  state.panX = (rect.width - w * state.scale) / 2;
  state.panY = (rect.height - h * state.scale) / 2;
  requestDraw();
}

function frameSpot(spot) {
  const point = pinToScreen(spot.nx, spot.ny);
  const rect = els.map.getBoundingClientRect();
  const margin = 90;
  if (point.x < margin || point.y < margin || point.x > rect.width - margin || point.y > rect.height - margin) {
    state.panX += rect.width / 2 - point.x;
    state.panY += rect.height / 2 - point.y;
  }
  requestDraw();
}

function roundRect(context, x, y, w, h, radius) {
  const r = Math.min(radius, Math.abs(w) / 2, Math.abs(h) / 2);
  context.beginPath();
  context.moveTo(x + r, y);
  context.arcTo(x + w, y, x + w, y + h, r);
  context.arcTo(x + w, y + h, x, y + h, r);
  context.arcTo(x, y + h, x, y, r);
  context.arcTo(x, y, x + w, y, r);
  context.closePath();
}

function drawArrow(context, x, y, yawDeg, color, length = 28) {
  const yaw = (yawDeg * Math.PI) / 180;
  const hx = Math.sin(yaw);
  const hy = -Math.cos(yaw);
  const px = -hy;
  const py = hx;
  const base = 16;
  context.strokeStyle = color;
  context.fillStyle = color;
  context.lineWidth = 2.25;
  context.lineCap = "round";
  context.beginPath();
  context.moveTo(x + hx * base, y + hy * base);
  context.lineTo(x + hx * (base + length), y + hy * (base + length));
  context.stroke();
  const tx = x + hx * (base + length);
  const ty = y + hy * (base + length);
  context.beginPath();
  context.moveTo(tx, ty);
  context.lineTo(tx - hx * 9 + px * 5, ty - hy * 9 + py * 5);
  context.lineTo(tx - hx * 9 - px * 5, ty - hy * 9 - py * 5);
  context.closePath();
  context.fill();
}

function drawMap() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const rect = els.map.getBoundingClientRect();
  const width = Math.max(1, rect.width);
  const height = Math.max(1, rect.height);
  const pixelW = Math.floor(width * dpr);
  const pixelH = Math.floor(height * dpr);
  if (els.map.width !== pixelW || els.map.height !== pixelH) {
    els.map.width = pixelW;
    els.map.height = pixelH;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const { w, h, base, board } = worldSize();
  const origin = worldToScreen(0, 0);
  const far = worldToScreen(1, 1);
  const sheetW = far.x - origin.x;
  const sheetH = far.y - origin.y;

  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.35)";
  ctx.shadowBlur = 28;
  ctx.shadowOffsetY = 14;
  ctx.fillStyle = "#efe6d4";
  roundRect(ctx, origin.x, origin.y, sheetW, sheetH, 10);
  ctx.fill();
  ctx.restore();

  ctx.save();
  roundRect(ctx, origin.x, origin.y, sheetW, sheetH, 10);
  ctx.clip();
  const expanded = board.left || board.right || board.top || board.bottom;
  if (!state.floorplanImage || expanded) {
    const contentX = board.left * base.w;
    const contentY = board.top * base.h;
    ctx.save();
    ctx.translate(state.panX, state.panY);
    ctx.scale(state.scale, state.scale);
    ctx.strokeStyle = "rgba(35, 30, 24, 0.09)";
    ctx.lineWidth = 1 / state.scale;
    ctx.beginPath();
    for (let x = contentX; x >= 0; x -= 40) {
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
    }
    for (let x = contentX + 40; x <= w; x += 40) {
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
    }
    for (let y = contentY; y >= 0; y -= 40) {
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
    }
    for (let y = contentY + 40; y <= h; y += 40) {
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
    }
    ctx.stroke();
    ctx.restore();
  }
  if (state.floorplanImage) {
    const planOrigin = pinToScreen(0, 0);
    const planFar = pinToScreen(1, 1);
    ctx.save();
    ctx.globalAlpha = state.tour.planOpacity;
    ctx.drawImage(
      state.floorplanImage,
      planOrigin.x,
      planOrigin.y,
      planFar.x - planOrigin.x,
      planFar.y - planOrigin.y,
    );
    ctx.restore();
  }

  ctx.lineWidth = 1.5;
  ctx.strokeStyle = "rgba(44, 109, 98, 0.55)";
  for (const spot of state.tour.spots) {
    const from = pinToScreen(spot.nx, spot.ny);
    for (const id of spot.links || []) {
      const other = placeById(id);
      if (!other) continue;
      const to = pinToScreen(other.nx, other.ny);
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x, to.y);
      ctx.stroke();
      const angle = Math.atan2(to.y - from.y, to.x - from.x);
      const mx = (from.x + to.x) / 2;
      const my = (from.y + to.y) / 2;
      ctx.beginPath();
      ctx.moveTo(mx, my);
      ctx.lineTo(mx - Math.cos(angle - 0.45) * 8, my - Math.sin(angle - 0.45) * 8);
      ctx.lineTo(mx - Math.cos(angle + 0.45) * 8, my - Math.sin(angle + 0.45) * 8);
      ctx.closePath();
      ctx.fillStyle = "rgba(44, 109, 98, 0.7)";
      ctx.fill();
    }
  }
  ctx.restore();

  ctx.fillStyle = "rgba(35, 30, 24, 0.62)";
  ctx.font = "600 11px Outfit, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "bottom";
  const planTop = pinToScreen(0, 0);
  const planTopFar = pinToScreen(1, 0);
  ctx.fillText("TOP OF PLAN", (planTop.x + planTopFar.x) / 2, planTop.y - 8);

  for (const spot of state.tour.spots) {
    const point = pinToScreen(spot.nx, spot.ny);
    const selected = spot.id === state.selected;
    const hovered = spot.id === state.hover;
    const nightOnly = Boolean(spot.night && !spot.day);
    const color = selected ? "#e3874a" : nightOnly ? "#355f8a" : "#2c6d62";
    drawArrow(ctx, point.x, point.y, spot.yaw, color);
    ctx.beginPath();
    ctx.arc(point.x, point.y, 15, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.lineWidth = selected ? 3 : 2;
    ctx.strokeStyle = selected || hovered ? "#fff8ee" : "rgba(255,255,255,0.9)";
    ctx.stroke();
    ctx.fillStyle = "#fff";
    const number = pinNumber(spot);
    ctx.font = number.length > 1 ? "700 9px Outfit, sans-serif" : "700 11px Outfit, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(number, point.x, point.y + 0.5);
    if (selected || hovered) {
      ctx.font = "500 12px Outfit, sans-serif";
      ctx.textBaseline = "top";
      ctx.fillStyle = "#231e18";
      ctx.strokeStyle = "rgba(239, 230, 212, 0.92)";
      ctx.lineWidth = 4;
      ctx.strokeText(spot.name, point.x, point.y + 20);
      ctx.fillText(spot.name, point.x, point.y + 20);
    }
  }
}

function arrowTips(spot) {
  const point = pinToScreen(spot.nx, spot.ny);
  const yaw = (spot.yaw * Math.PI) / 180;
  const length = 28;
  return {
    x: point.x,
    y: point.y,
    tipX: point.x + Math.sin(yaw) * (16 + length),
    tipY: point.y - Math.cos(yaw) * (16 + length),
  };
}

function hitTest(sx, sy) {
  const spots = [...state.tour.spots].reverse();
  let best = null;
  let bestDist = 12;
  for (const spot of spots) {
    const tip = arrowTips(spot);
    const distance = Math.hypot(sx - tip.tipX, sy - tip.tipY);
    if (distance <= bestDist) {
      best = { spot, mode: "rotate" };
      bestDist = distance;
    }
  }
  if (best) return best;
  for (const spot of spots) {
    const geom = arrowTips(spot);
    if (Math.hypot(sx - geom.x, sy - geom.y) <= 16) return { spot, mode: "move" };
  }
  return null;
}

function selectSpot(id, frame) {
  state.selected = id;
  const spot = placeById(id);
  if (frame && spot) frameSpot(spot);
  syncInspector();
  renderTray();
  requestDraw();
}

function selectPhoto(file) {
  state.selectedPhoto = file;
  syncInspector();
  renderTray();
  requestDraw();
}

function assignmentLabel(file) {
  const spot = placeByFile(file);
  if (!spot) return "Not on a pin";
  const role = spot.day === file ? "Day" : "Night";
  return `${role} · ${spot.name}`;
}

function renderTray() {
  const query = els.search.value.trim().toLowerCase();
  const photos = state.photos.filter((file) => {
    if (!query) return true;
    const spot = placeByFile(file);
    return timeLabel(file).toLowerCase().includes(query)
      || (spot && spot.name.toLowerCase().includes(query))
      || file.toLowerCase().includes(query);
  });
  const loose = state.photos.filter((file) => !placeByFile(file)).length;
  els.trayCount.textContent = loose
    ? `${state.photos.length} photos · ${loose} not on a pin`
    : `${state.photos.length} photos on ${state.tour.spots.length} pins`;
  els.removeAll.disabled = state.tour.spots.length === 0;
  els.tray.innerHTML = "";
  const pin = selectedSpot();
  for (const file of photos) {
    const owner = placeByFile(file);
    const row = document.createElement("div");
    row.className = "tray-item";
    row.dataset.photo = file;
    if (file === state.selectedPhoto) row.classList.add("selected");
    if (pin && owner && owner.id === pin.id) row.classList.add("linked");
    const main = document.createElement("button");
    main.type = "button";
    main.className = "tray-main";
    const preview = thumbPreview.get(file);
    const thumbSrc = preview && preview.yaw === thumbYawOf(file) ? preview.url : thumbUrl(file);
    main.innerHTML = `<img alt="" src="${thumbSrc}" /><span><span class="tray-title"><strong></strong><span class="place-badge"></span></span><em></em></span>`;
    main.querySelector("strong").textContent = timeLabel(file);
    const badge = main.querySelector(".place-badge");
    badge.textContent = owner ? "On plan" : "Not placed";
    badge.classList.toggle("on", Boolean(owner));
    main.querySelector("em").textContent = owner
      ? `${assignmentLabel(file)} · #${photoNumber(file)}`
      : `Photo #${photoNumber(file)}`;
    main.addEventListener("click", () => selectPhoto(file));
    main.addEventListener("dblclick", () => {
      if (!owner || !hasPhoto(owner)) return;
      const time = owner.night === file ? "night" : "day";
      openViewer(owner.id, time);
    });
    const actions = document.createElement("div");
    actions.className = "tray-actions";
    for (const time of ["day", "night"]) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = time === "day" ? "Day" : "Night";
      button.disabled = !pin;
      button.title = pin ? `Use this photo as the ${time} shot of ${pin.name}` : "Select a pin first";
      if (pin && pin[time] === file) button.classList.add("on");
      button.addEventListener("click", () => {
        const target = selectedSpot();
        if (!target) return;
        if (!assignPhoto(file, target, time)) return;
        state.selectedPhoto = file;
        scheduleSave();
        syncInspector();
        renderTray();
        requestDraw();
      });
      actions.appendChild(button);
    }
    const look = document.createElement("label");
    look.className = "thumb-look";
    look.innerHTML = `<span>Look</span><input type="range" min="-180" max="180" step="1" aria-label="Thumbnail direction" />`;
    const slider = look.querySelector("input");
    slider.value = String(thumbYawOf(file));
    slider.addEventListener("input", () => setThumbYaw(file, Number(slider.value)));
    slider.addEventListener("pointerdown", (event) => event.stopPropagation());
    row.append(main, look, actions);
    els.tray.appendChild(row);
  }
  const selected = els.tray.querySelector(".selected");
  if (selected) selected.scrollIntoView({ block: "nearest" });
}

function fillSlot(thumb, label, clear, file, emptyText) {
  if (file) {
    thumb.hidden = false;
    const version = String(state.thumbVersion[file] || "");
    if (thumb.dataset.file !== file || thumb.dataset.version !== version) {
      thumb.dataset.file = file;
      thumb.dataset.version = version;
      const preview = thumbPreview.get(file);
      thumb.src = preview && preview.yaw === thumbYawOf(file) ? preview.url : thumbUrl(file);
    }
    thumb.alt = timeLabel(file);
    label.textContent = timeLabel(file);
    clear.hidden = false;
  } else {
    thumb.hidden = true;
    thumb.removeAttribute("src");
    delete thumb.dataset.file;
    delete thumb.dataset.version;
    label.textContent = emptyText;
    clear.hidden = true;
  }
}

function yawPhrase(yaw) {
  const rounded = Math.round(wrapDeg(yaw));
  return rounded === 0 ? "toward the top of the plan" : `${rounded}° from the top of the plan`;
}

function syncPlaceYaw(spot) {
  if (document.activeElement !== els.placeYaw) els.placeYaw.value = String(Math.round(spot.yaw));
  els.placeYawVal.textContent = yawPhrase(spot.yaw);
}

function syncJumps(spot) {
  els.jumpList.innerHTML = "";
  const jumps = neighborsOf(spot);
  if (!jumps.length) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "No jumps from here yet.";
    els.jumpList.append(empty);
  }
  for (const other of jumps) {
    const row = document.createElement("div");
    row.className = "jump-row";
    const name = document.createElement("span");
    name.textContent = pinLabel(other);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "text-btn";
    remove.textContent = "Remove";
    remove.addEventListener("click", () => removeJump(spot.id, other.id));
    row.append(name, remove);
    els.jumpList.append(row);
  }
  const previous = els.addJump.value;
  els.addJump.innerHTML = "";
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "Add a place to jump to…";
  els.addJump.append(placeholder);
  const linked = new Set(spot.links || []);
  for (const other of state.tour.spots) {
    if (other.id === spot.id || linked.has(other.id) || !hasPhoto(other)) continue;
    const option = document.createElement("option");
    option.value = other.id;
    option.textContent = pinLabel(other);
    els.addJump.append(option);
  }
  els.addJump.disabled = els.addJump.options.length === 1;
  if ([...els.addJump.options].some((option) => option.value === previous)) els.addJump.value = previous;
}

function syncInspector() {
  const spot = selectedSpot();
  const has = Boolean(spot);
  els.empty.hidden = has;
  els.inspector.hidden = !has;
  updateTimeToggle();
  if (!has) return;
  if (document.activeElement !== els.name) els.name.value = spot.name;
  const photo = state.selectedPhoto ? timeLabel(state.selectedPhoto) : "";
  els.photoPick.textContent = photo
    ? `Selected photo: ${photo}. Set it as day or night.`
    : "Select a photo in the list, then set it as day or night.";
  fillSlot(els.dayThumb, els.dayLabel, els.clearDay, spot.day, "No day photo");
  fillSlot(els.nightThumb, els.nightLabel, els.clearNight, spot.night, "No night photo");
  els.setDay.disabled = !state.selectedPhoto;
  els.setNight.disabled = !state.selectedPhoto;
  syncPlaceYaw(spot);
  syncJumps(spot);
  els.walk.disabled = !hasPhoto(spot);
  if (viewerPlaceId === spot.id && document.activeElement !== els.viewerName) {
    els.viewerName.value = spot.name;
  }
}

function pointerPos(event) {
  const rect = els.map.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

function setPlacing(on) {
  state.placing = on;
  els.addPin.classList.toggle("armed", on);
  els.map.classList.toggle("placing", on);
  els.addPin.textContent = on ? "Click the plan" : "Add pin";
  els.mapHint.textContent = on
    ? "Click the plan to drop a pin. Press Escape to cancel."
    : MAP_HINT;
}

function dropPin(sx, sy) {
  const sheet = screenToNorm(sx, sy);
  const norm = sheetToContent(sheet.nx, sheet.ny);
  const limits = pinLimits(0.02);
  const spot = {
    id: newId(),
    name: `Pin ${state.tour.spots.length + 1}`,
    nx: clamp(Number.isFinite(norm.nx) ? norm.nx : 0.5, limits.minX, limits.maxX),
    ny: clamp(Number.isFinite(norm.ny) ? norm.ny : 0.5, limits.minY, limits.maxY),
    yaw: 0,
    day: null,
    night: null,
    links: [],
  };
  state.tour.spots.push(spot);
  state.selected = spot.id;
  placedAt = Date.now();
  scheduleSave();
  syncInspector();
  renderTray();
  requestDraw();
}

function useSelected(time) {
  const spot = selectedSpot();
  if (!spot || !state.selectedPhoto) return;
  if (!assignPhoto(state.selectedPhoto, spot, time)) return;
  scheduleSave();
  syncInspector();
  renderTray();
  requestDraw();
}

function removeAllPins() {
  if (!state.tour.spots.length) return;
  const count = state.tour.spots.length;
  const label = count === 1 ? "Remove the pin" : `Remove all ${count} pins`;
  if (!confirm(`${label}? Photos stay in the list.`)) return;
  state.tour.spots = [];
  state.undo = [];
  state.selected = null;
  if (state.placing) setPlacing(false);
  if (viewerPlaceId) closeViewer();
  scheduleSave();
  syncInspector();
  renderTray();
  requestDraw();
}

function removeSelectedPin() {
  const spot = selectedSpot();
  if (!spot) return;
  const message = hasPhoto(spot)
    ? `Remove “${spot.name}”? Its photos stay in the list.`
    : `Remove “${spot.name}”?`;
  if (!confirm(message)) return;
  state.tour.spots = state.tour.spots.filter((other) => other.id !== spot.id);
  forgetJumps(spot.id);
  state.undo = state.undo.filter((entry) => entry.id !== spot.id);
  if (viewerPlaceId === spot.id) closeViewer();
  state.selected = state.tour.spots[0]?.id || null;
  scheduleSave();
  syncInspector();
  renderTray();
  requestDraw();
}

function onPointerDown(event) {
  if (event.button !== 0) return;
  const pos = pointerPos(event);
  if (state.placing) {
    dropPin(pos.x, pos.y);
    setPlacing(false);
    return;
  }
  const hit = hitTest(pos.x, pos.y);
  els.map.setPointerCapture(event.pointerId);
  state.drag = {
    mode: hit ? hit.mode : "pan",
    id: hit ? hit.spot.id : null,
    sx: pos.x,
    sy: pos.y,
    moved: false,
    panX: state.panX,
    panY: state.panY,
    startNx: hit ? hit.spot.nx : 0,
    startNy: hit ? hit.spot.ny : 0,
    undoPushed: false,
  };
  if (hit) selectSpot(hit.spot.id, false);
  els.map.classList.add("grabbing");
}

function onPointerMove(event) {
  const pos = pointerPos(event);
  if (!state.drag) {
    if (state.placing) {
      els.map.style.cursor = "crosshair";
      return;
    }
    const hit = hitTest(pos.x, pos.y);
    const next = hit ? hit.spot.id : null;
    els.map.style.cursor = hit?.mode === "rotate" ? "crosshair" : "grab";
    if (next !== state.hover) {
      state.hover = next;
      requestDraw();
    }
    return;
  }
  const dx = pos.x - state.drag.sx;
  const dy = pos.y - state.drag.sy;
  if (Math.hypot(dx, dy) > 3) state.drag.moved = true;
  if (state.drag.mode === "pan") {
    state.panX = state.drag.panX + dx;
    state.panY = state.drag.panY + dy;
  } else {
    const spot = placeById(state.drag.id);
    if (!spot) return;
    if (!state.drag.undoPushed) {
      pushUndo(spot);
      state.drag.undoPushed = true;
    }
    if (state.drag.mode === "move") {
      const { base } = worldSize();
      const limits = pinLimits(0.015);
      spot.nx = clamp(state.drag.startNx + dx / (state.scale * base.w), limits.minX, limits.maxX);
      spot.ny = clamp(state.drag.startNy + dy / (state.scale * base.h), limits.minY, limits.maxY);
    } else {
      const geom = pinToScreen(spot.nx, spot.ny);
      setSpotYaw(spot, (Math.atan2(pos.x - geom.x, -(pos.y - geom.y)) * 180) / Math.PI);
    }
    scheduleSave();
    syncInspector();
  }
  requestDraw();
}

function onPointerUp() {
  state.drag = null;
  els.map.classList.remove("grabbing");
}

function onWheel(event) {
  event.preventDefault();
  const pos = pointerPos(event);
  const before = screenToNorm(pos.x, pos.y);
  const factor = Math.exp(-event.deltaY * 0.0011);
  state.scale = clamp(state.scale * factor, 0.15, 8);
  const { w, h } = worldSize();
  state.panX = pos.x - before.nx * w * state.scale;
  state.panY = pos.y - before.ny * h * state.scale;
  requestDraw();
}

async function loadFloorplan() {
  state.floorplanImage = null;
  els.removePlan.hidden = !state.tour.floorplan;
  els.opacityWrap.hidden = !state.tour.floorplan;
  els.opacity.value = String(state.tour.planOpacity);
  if (!state.tour.floorplan) return;
  await new Promise((resolve) => {
    const image = new Image();
    image.onload = () => {
      state.floorplanImage = image;
      resolve();
    };
    image.onerror = () => resolve();
    image.src = `${state.tour.floorplan}?t=${Date.now()}`;
  });
}

function bearingPhrase(radians) {
  const deg = ((radians * 180) / Math.PI + 360) % 360;
  const names = [
    [22.5, "toward the top of the plan"],
    [67.5, "toward the top-right"],
    [112.5, "toward the right of the plan"],
    [157.5, "toward the bottom-right"],
    [202.5, "toward the bottom of the plan"],
    [247.5, "toward the bottom-left"],
    [292.5, "toward the left of the plan"],
    [337.5, "toward the top-left"],
    [360, "toward the top of the plan"],
  ];
  return names.find(([edge]) => deg < edge)[1];
}

function dirFromYawPitch(yaw, pitch) {
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  return [Math.sin(yaw) * cp, sp, -Math.cos(yaw) * cp];
}

function projectDirection(imageYaw, imagePitch, lookYaw, lookPitch, fov, width, height) {
  const [dx, dy, dz] = dirFromYawPitch(imageYaw, imagePitch);
  const cy = Math.cos(lookYaw);
  const sy = Math.sin(lookYaw);
  let x = dx * cy + dz * sy;
  let z = -dx * sy + dz * cy;
  let y = dy;
  const cp = Math.cos(lookPitch);
  const sp = Math.sin(lookPitch);
  const y2 = y * cp + z * sp;
  const z2 = -y * sp + z * cp;
  y = y2;
  z = z2;
  if (z >= -0.05) return null;
  const aspect = width / Math.max(1, height);
  const tanF = Math.tan(fov / 2);
  const ndcX = x / -z / (aspect * tanF);
  const ndcY = y / -z / tanF;
  if (ndcX < -1.15 || ndcX > 1.15 || ndcY < -1.15 || ndcY > 1.15) return null;
  return {
    x: (ndcX * 0.5 + 0.5) * width,
    y: (1 - (ndcY * 0.5 + 0.5)) * height,
  };
}

const VERT = `#version 300 es
layout(location=0) in vec2 aPos;
out vec2 vNdc;
void main() {
  vNdc = aPos;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;
in vec2 vNdc;
out vec4 fragColor;
uniform sampler2D uTex;
uniform vec2 uLook;
uniform float uFov;
uniform float uForward;
uniform vec2 uRes;
uniform mat4 uInvProj;
uniform mat4 uView;
uniform float uXR;
uniform float uYaw;
uniform float uDim;
const float PI = 3.141592653589793;
vec3 applyLook(vec3 r, float yaw, float pitch) {
  float cp = cos(pitch);
  float sp = sin(pitch);
  vec3 p = vec3(r.x, r.y * cp - r.z * sp, r.y * sp + r.z * cp);
  float cy = cos(yaw);
  float sy = sin(yaw);
  return vec3(p.x * cy - p.z * sy, p.y, p.x * sy + p.z * cy);
}
vec3 rotateY(vec3 v, float a) {
  float c = cos(a);
  float s = sin(a);
  return vec3(v.x * c + v.z * s, v.y, -v.x * s + v.z * c);
}
void main() {
  vec3 dir;
  if (uXR > 0.5) {
    vec4 p = uInvProj * vec4(vNdc, -1.0, 1.0);
    vec3 viewDir = normalize(p.xyz / p.w);
    dir = rotateY(mat3(uView) * viewDir, uYaw);
  } else {
    float aspect = uRes.x / uRes.y;
    float tanF = tan(uFov * 0.5);
    vec3 rd = normalize(vec3(vNdc.x * aspect * tanF, vNdc.y * tanF, -1.0));
    dir = applyLook(rd, uLook.x, uLook.y);
  }
  float lon = atan(dir.x, -dir.z) + uForward;
  float lat = asin(clamp(dir.y, -1.0, 1.0));
  vec2 uv = vec2(lon / (2.0 * PI) + 0.5, lat / PI + 0.5);
  fragColor = texture(uTex, uv);
  if (uXR > 0.5) fragColor.rgb *= uDim;
}`;

const MARK_VERT = `#version 300 es
layout(location=0) in vec3 aPos;
layout(location=1) in vec2 aUv;
uniform mat4 uMVP;
out vec2 vUv;
void main() {
  vUv = aUv;
  gl_Position = uMVP * vec4(aPos, 1.0);
}`;

const MARK_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uMarkTex;
uniform vec4 uColor;
uniform float uMode;
void main() {
  if (uMode < 0.5) {
    vec2 p = vUv * 2.0 - 1.0;
    float d = length(p);
    if (d > 1.0) discard;
    float rim = smoothstep(0.55, 0.82, d);
    fragColor = vec4(mix(uColor.rgb, vec3(1.0), rim), uColor.a * smoothstep(1.0, 0.86, d));
  } else if (uMode < 1.5) {
    fragColor = texture(uMarkTex, vUv);
    if (fragColor.a < 0.05) discard;
  } else {
    fragColor = uColor;
  }
}`;

function linkProgram(gl, vertSource, fragSource) {
  function compile(type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      throw new Error(gl.getShaderInfoLog(shader) || "shader failed");
    }
    return shader;
  }
  const program = gl.createProgram();
  gl.attachShader(program, compile(gl.VERTEX_SHADER, vertSource));
  gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragSource));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(program) || "link failed");
  }
  return program;
}

function initGl() {
  if (glContext) return glContext;
  const attributes = {
    alpha: false,
    antialias: false,
    premultipliedAlpha: false,
  };
  if (!adminMode) attributes.xrCompatible = true;
  let gl = els.pano.getContext("webgl2", attributes);
  if (!gl && attributes.xrCompatible) {
    delete attributes.xrCompatible;
    gl = els.pano.getContext("webgl2", attributes);
  }
  if (!gl) return null;
  const program = linkProgram(gl, VERT, FRAG);
  const markProgram = adminMode ? null : linkProgram(gl, MARK_VERT, MARK_FRAG);
  gl.useProgram(program);
  const panoVao = gl.createVertexArray();
  gl.bindVertexArray(panoVao);
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  let markerVao = null;
  let markerBuffer = null;
  if (markProgram) {
    markerVao = gl.createVertexArray();
    markerBuffer = gl.createBuffer();
    gl.bindVertexArray(markerVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, markerBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(120), gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 20, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 20, 12);
    gl.useProgram(markProgram);
    gl.uniform1i(gl.getUniformLocation(markProgram, "uMarkTex"), 0);
    gl.useProgram(program);
  }
  gl.bindVertexArray(panoVao);
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  glContext = {
    gl,
    program,
    markProgram,
    panoVao,
    markerVao,
    markerBuffer,
    texture,
    labels: new Map(),
    uLook: gl.getUniformLocation(program, "uLook"),
    uFov: gl.getUniformLocation(program, "uFov"),
    uForward: gl.getUniformLocation(program, "uForward"),
    uRes: gl.getUniformLocation(program, "uRes"),
    uInvProj: gl.getUniformLocation(program, "uInvProj"),
    uView: gl.getUniformLocation(program, "uView"),
    uXR: gl.getUniformLocation(program, "uXR"),
    uYaw: gl.getUniformLocation(program, "uYaw"),
    uDim: gl.getUniformLocation(program, "uDim"),
    markMvp: markProgram ? gl.getUniformLocation(markProgram, "uMVP") : null,
    markColor: markProgram ? gl.getUniformLocation(markProgram, "uColor") : null,
    markMode: markProgram ? gl.getUniformLocation(markProgram, "uMode") : null,
    maxSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
  };
  return glContext;
}

function uploadTexture(image) {
  const ctxGl = glContext;
  const gl = ctxGl.gl;
  let source = image;
  const maxEdge = Math.max(image.width, image.height);
  if (maxEdge > ctxGl.maxSize) {
    const scale = ctxGl.maxSize / maxEdge;
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
    source = canvas;
  }
  gl.bindTexture(gl.TEXTURE_2D, ctxGl.texture);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
}

// Held only in this tab. Closing the tab drops the photos.
const panoramaBytes = new Map();
const panoramaImages = new Map();
const panoramaDecode = new Map();
const DECODED_LIMIT = 6;

function rememberPanorama(file, image) {
  if (panoramaImages.has(file)) panoramaImages.delete(file);
  panoramaImages.set(file, image);
  while (panoramaImages.size > DECODED_LIMIT) {
    const oldest = panoramaImages.keys().next().value;
    panoramaImages.delete(oldest);
  }
}

function loadPanoramaBytes(file, onProgress) {
  const pending = panoramaBytes.get(file);
  if (pending) return pending;
  const task = readPanoramaBytes(file, onProgress).catch((error) => {
    panoramaBytes.delete(file);
    throw error;
  });
  panoramaBytes.set(file, task);
  return task;
}

async function readPanoramaBytes(file, onProgress) {
  const response = await fetch(photoUrl(file));
  if (!response.ok) throw new Error("could not load photo");
  const total = Number(response.headers.get("content-length")) || 0;
  if (!response.body) return response.blob();
  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    if (onProgress && total) onProgress(received / total);
  }
  return new Blob(chunks, { type: response.headers.get("content-type") || "image/jpeg" });
}

async function decodePanoramaBlob(blob) {
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    return image;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function decodePanorama(file, onProgress) {
  const cached = panoramaImages.get(file);
  if (cached) {
    rememberPanorama(file, cached);
    return Promise.resolve(cached);
  }
  const pending = panoramaDecode.get(file);
  if (pending) return pending;
  const task = (async () => {
    const blob = await loadPanoramaBytes(file, onProgress);
    try {
      return await decodePanoramaBlob(blob);
    } catch (error) {
      panoramaBytes.delete(file);
      throw error;
    }
  })().then((image) => {
    panoramaDecode.delete(file);
    rememberPanorama(file, image);
    return image;
  }).catch((error) => {
    panoramaDecode.delete(file);
    throw error;
  });
  panoramaDecode.set(file, task);
  return task;
}

async function fetchPanorama(file, token) {
  if (!panoramaImages.has(file)) {
    els.loadMask.hidden = false;
    const label = adminMode ? (placeByFile(file)?.name || timeLabel(file) || "photo") : "the photo";
    els.loadText.textContent = `Loading ${label}…`;
  }
  const image = await decodePanorama(file, (ratio) => {
    if (token !== loadToken) return;
    els.loadText.textContent = `Loading ${Math.round(ratio * 100)}%`;
  });
  if (token !== loadToken) return null;
  return image;
}

async function loadPanorama(file, token) {
  const image = await fetchPanorama(file, token);
  if (image) uploadTexture(image);
  return image;
}

function resizePano() {
  if (!glContext) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 1.75);
  const width = Math.max(1, Math.floor(els.pano.clientWidth * dpr));
  const height = Math.max(1, Math.floor(els.pano.clientHeight * dpr));
  if (els.pano.width !== width || els.pano.height !== height) {
    els.pano.width = width;
    els.pano.height = height;
    glContext.gl.viewport(0, 0, width, height);
  }
}

const MAT4_ID = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

function drawPano() {
  if (!glContext || !viewerFile) return;
  resizePano();
  const gl = glContext.gl;
  gl.disable(gl.BLEND);
  gl.disable(gl.DEPTH_TEST);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, els.pano.width, els.pano.height);
  gl.useProgram(glContext.program);
  gl.bindVertexArray(glContext.panoVao);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, glContext.texture);
  gl.uniform2f(glContext.uLook, look.yaw, look.pitch);
  gl.uniform1f(glContext.uFov, look.fov);
  gl.uniform1f(glContext.uForward, (thumbYawOf(viewerFile) * Math.PI) / 180);
  gl.uniform2f(glContext.uRes, els.pano.width, els.pano.height);
  gl.uniform1f(glContext.uXR, 0);
  gl.uniform1f(glContext.uYaw, 0);
  gl.uniform1f(glContext.uDim, 1);
  gl.uniformMatrix4fv(glContext.uInvProj, false, MAT4_ID);
  gl.uniformMatrix4fv(glContext.uView, false, MAT4_ID);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}

function mat4Multiply(a, b) {
  const out = new Float32Array(16);
  for (let col = 0; col < 4; col += 1) {
    const b0 = b[col * 4];
    const b1 = b[col * 4 + 1];
    const b2 = b[col * 4 + 2];
    const b3 = b[col * 4 + 3];
    out[col * 4] = a[0] * b0 + a[4] * b1 + a[8] * b2 + a[12] * b3;
    out[col * 4 + 1] = a[1] * b0 + a[5] * b1 + a[9] * b2 + a[13] * b3;
    out[col * 4 + 2] = a[2] * b0 + a[6] * b1 + a[10] * b2 + a[14] * b3;
    out[col * 4 + 3] = a[3] * b0 + a[7] * b1 + a[11] * b2 + a[15] * b3;
  }
  return out;
}

function mat4Invert(a) {
  const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
  const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
  const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
  const a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];
  const b00 = a00 * a11 - a01 * a10;
  const b01 = a00 * a12 - a02 * a10;
  const b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11;
  const b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30;
  const b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31;
  const b10 = a21 * a33 - a23 * a31;
  const b11 = a22 * a33 - a23 * a32;
  let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!det) return null;
  det = 1 / det;
  return new Float32Array([
    (a11 * b11 - a12 * b10 + a13 * b09) * det,
    (a02 * b10 - a01 * b11 - a03 * b09) * det,
    (a31 * b05 - a32 * b04 + a33 * b03) * det,
    (a22 * b04 - a21 * b05 - a23 * b03) * det,
    (a12 * b08 - a10 * b11 - a13 * b07) * det,
    (a00 * b11 - a02 * b08 + a03 * b07) * det,
    (a32 * b02 - a30 * b05 - a33 * b01) * det,
    (a20 * b05 - a22 * b02 + a23 * b01) * det,
    (a10 * b10 - a11 * b08 + a13 * b06) * det,
    (a01 * b08 - a00 * b10 - a03 * b06) * det,
    (a30 * b04 - a31 * b02 + a33 * b00) * det,
    (a21 * b02 - a20 * b04 - a23 * b00) * det,
    (a11 * b07 - a10 * b09 - a12 * b06) * det,
    (a00 * b09 - a01 * b07 + a02 * b06) * det,
    (a31 * b01 - a30 * b03 - a32 * b00) * det,
    (a20 * b03 - a21 * b01 + a22 * b00) * det,
  ]);
}

function quatRotate(q, v) {
  const { x, y, z, w } = q;
  const vx = v[0], vy = v[1], vz = v[2];
  const tx = 2 * (y * vz - z * vy);
  const ty = 2 * (z * vx - x * vz);
  const tz = 2 * (x * vy - y * vx);
  return [
    vx + w * tx + (y * tz - z * ty),
    vy + w * ty + (z * tx - x * tz),
    vz + w * tz + (x * ty - y * tx),
  ];
}

function rotateY(v, angle) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [v[0] * c + v[2] * s, v[1], -v[0] * s + v[2] * c];
}

function vecDot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function vecCross(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function vecScale(v, s) {
  return [v[0] * s, v[1] * s, v[2] * s];
}

function vecAdd(a, b) {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function vecSub(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function vecLen(v) {
  return Math.hypot(v[0], v[1], v[2]);
}

function vecNorm(v) {
  const length = vecLen(v);
  if (length < 1e-5) return [0, 0, -1];
  return [v[0] / length, v[1] / length, v[2] / length];
}

function angleBetween(a, b) {
  const denom = vecLen(a) * vecLen(b);
  if (denom < 1e-5) return Math.PI;
  return Math.acos(clamp(vecDot(a, b) / denom, -1, 1));
}

function pushTri(dst, a, b, c, ua, va, ub, vb, uc, vc) {
  dst.push(a[0], a[1], a[2], ua, va, b[0], b[1], b[2], ub, vb, c[0], c[1], c[2], uc, vc);
}

function pushQuad(dst, center, right, up) {
  const p00 = vecAdd(vecSub(center, right), vecScale(up, -1));
  const p10 = vecAdd(center, vecSub(right, up));
  const p01 = vecAdd(center, vecSub(up, right));
  const p11 = vecAdd(center, vecAdd(right, up));
  pushTri(dst, p00, p10, p01, 0, 0, 1, 0, 0, 1);
  pushTri(dst, p10, p11, p01, 1, 0, 1, 1, 0, 1);
}

function raySphere(origin, direction, center, radius) {
  const offset = vecSub(origin, center);
  const b = vecDot(offset, direction);
  const c = vecDot(offset, offset) - radius * radius;
  const disc = b * b - c;
  if (disc < 0) return null;
  const t = -b - Math.sqrt(disc);
  return t > 0.05 ? t : null;
}

function markerList() {
  const spot = viewerSpot();
  if (!spot) return [];
  return reachableNeighbors(spot, viewerTime).map((other) => {
    const aim = markerAim(spot, other);
    return {
      id: other.id,
      name: other.name,
      panDir: dirFromYawPitch(aim.imageYaw, aim.imagePitch),
      distance: aim.meters,
    };
  });
}

function markerAhead() {
  const lookDir = rotateY(vr.headForward, vr.yawOffset);
  let best = null;
  let bestAngle = 0.55;
  for (const marker of vr.markers) {
    const angle = angleBetween(lookDir, marker.panDir);
    if (angle < bestAngle) {
      best = marker;
      bestAngle = angle;
    }
  }
  return best;
}

function thumbAxes(gamepad) {
  const axes = gamepad.axes;
  if (!axes || axes.length < 2) return { x: 0, y: 0 };
  let x = axes.length > 2 ? axes[2] : axes[0];
  let y = axes.length > 3 ? axes[3] : axes[1];
  const primary = Math.hypot(axes[0] || 0, axes[1] || 0);
  const secondary = Math.hypot(x || 0, y || 0);
  if (primary > secondary) {
    x = axes[0];
    y = axes[1];
  }
  return { x: x || 0, y: y || 0 };
}

function buttonDown(gamepad, index) {
  const button = gamepad.buttons && gamepad.buttons[index];
  return Boolean(button && (button.pressed || button.value > 0.5));
}

function pulseController(source) {
  const haptic = source.gamepad && source.gamepad.hapticActuators && source.gamepad.hapticActuators[0];
  if (!haptic || !haptic.pulse) return;
  try {
    const result = haptic.pulse(0.28, 18);
    if (result && result.catch) result.catch(() => {});
  } catch {
    /* This headset has no pulse actuator. */
  }
}

function labelTexture(text, wide) {
  const key = `${wide ? "w" : "n"}:${text}`;
  const cached = glContext.labels.get(key);
  if (cached) return cached;
  const canvas = document.createElement("canvas");
  canvas.width = wide ? 1024 : 512;
  canvas.height = wide ? 160 : 128;
  const context = canvas.getContext("2d");
  context.clearRect(0, 0, canvas.width, canvas.height);
  let size = wide ? 42 : 46;
  context.font = `600 ${size}px Outfit, sans-serif`;
  const limit = canvas.width - 64;
  while (size > 22 && context.measureText(text).width > limit) {
    size -= 2;
    context.font = `600 ${size}px Outfit, sans-serif`;
  }
  const pillW = Math.min(limit + 36, Math.ceil(context.measureText(text).width + 48));
  const pillH = wide ? 84 : 72;
  const pillX = (canvas.width - pillW) / 2;
  const pillY = (canvas.height - pillH) / 2;
  context.fillStyle = "rgba(16, 14, 11, 0.86)";
  context.beginPath();
  if (context.roundRect) context.roundRect(pillX, pillY, pillW, pillH, pillH / 2);
  else context.rect(pillX, pillY, pillW, pillH);
  context.fill();
  context.fillStyle = "#f4efe6";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(text, canvas.width / 2, canvas.height / 2);
  const gl = glContext.gl;
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  glContext.labels.set(key, texture);
  return texture;
}

function drawMarkerMesh(data, mode, color, texture) {
  if (!data.length) return;
  const gl = glContext.gl;
  gl.bindBuffer(gl.ARRAY_BUFFER, glContext.markerBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.DYNAMIC_DRAW);
  gl.uniform1f(glContext.markMode, mode);
  gl.uniform4fv(glContext.markColor, color);
  if (texture) gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.drawArrays(gl.TRIANGLES, 0, data.length / 5);
}

function markerPose(panDir, distance) {
  const refDir = rotateY(panDir, -vr.yawOffset);
  return {
    refDir,
    center: vecAdd(vr.headPos, vecScale(refDir, distance)),
  };
}

function flatBasis(refDir, radius) {
  const flat = vecNorm([refDir[0], 0, refDir[2]]);
  const right = vecScale(vecNorm(vecCross([0, 1, 0], flat)), radius);
  const forward = vecScale(flat, radius);
  return { right, forward };
}

function billboardBasis(center, halfW, halfH) {
  const toHead = vecNorm(vecSub(vr.headPos, center));
  let right = vecCross([0, 1, 0], toHead);
  if (vecLen(right) < 1e-4) right = [1, 0, 0];
  right = vecScale(vecNorm(right), halfW);
  const up = vecScale(vecNorm(vecCross(toHead, right)), halfH);
  return { right, up };
}

function collectControllerHits(frame) {
  const hits = new Map();
  const rays = [];
  if (!xrSession) return { hits, rays };
  for (const source of xrSession.inputSources) {
    if (!source.targetRaySpace) continue;
    const pose = frame.getPose(source.targetRaySpace, vr.refSpace);
    if (!pose) continue;
    const origin = [pose.transform.position.x, pose.transform.position.y, pose.transform.position.z];
    const direction = vecNorm(quatRotate(pose.transform.orientation, [0, 0, -1]));
    let best = null;
    for (const marker of vr.markers) {
      const { center } = markerPose(marker.panDir, marker.distance);
      const t = raySphere(origin, direction, center, Math.max(0.28, marker.distance * 0.16));
      if (t == null) continue;
      if (!best || t < best.t) best = { id: marker.id, t, source };
    }
    if (best) hits.set(source, best);
    rays.push({ source, origin, direction, hit: best });
  }
  return { hits, rays };
}

function stepWithController(hit) {
  if (traveling) return;
  if (hit) {
    pulseController(hit.source);
    travelTo(hit.id);
    return;
  }
  const ahead = markerAhead();
  if (ahead) travelTo(ahead.id);
}

function applyStickTurn(dt) {
  let turn = 0;
  for (const source of xrSession.inputSources) {
    const gamepad = source.gamepad;
    if (!gamepad) continue;
    const stick = thumbAxes(gamepad);
    if (Math.abs(stick.x) <= 0.18) continue;
    const amount = Math.sign(stick.x) * Math.pow((Math.abs(stick.x) - 0.18) / 0.82, 1.3);
    if (Math.abs(amount) > Math.abs(turn)) turn = amount;
  }
  if (turn) setViewYaw(look.yaw + turn * 1.7 * dt);
}

function pollVrInput(hits) {
  for (const source of xrSession.inputSources) {
    const gamepad = source.gamepad;
    if (!gamepad) continue;
    const hand = vr.hands[source.handedness] || vr.hands.none;
    const stick = thumbAxes(gamepad);
    const forward = stick.y < -0.65 && Math.abs(stick.x) < 0.5;
    if (forward && !hand.forward) stepWithController(hits.get(source) || null);
    if (!forward && stick.y > -0.35) hand.forward = false;
    if (forward) hand.forward = true;

    const trigger = buttonDown(gamepad, 0);
    if (trigger && !hand.trigger) {
      const hit = hits.get(source);
      if (hit) {
        pulseController(source);
        travelTo(hit.id);
      }
    }
    hand.trigger = trigger;

    if (source.handedness === "right") {
      const aButton = buttonDown(gamepad, 4);
      if (aButton && !hand.a) toggleDayNight();
      hand.a = aButton;
    }
  }
}

function drawVrEye(view, rays, showHint) {
  const gl = glContext.gl;
  const viewport = vr.layer.getViewport(view);
  gl.viewport(viewport.x, viewport.y, viewport.width, viewport.height);
  const invProj = mat4Invert(view.projectionMatrix);
  if (!invProj) return;
  const viewMatrix = mat4Invert(view.transform.matrix);
  if (!viewMatrix) return;
  const mvp = mat4Multiply(view.projectionMatrix, viewMatrix);

  gl.disable(gl.BLEND);
  gl.useProgram(glContext.program);
  gl.bindVertexArray(glContext.panoVao);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, glContext.texture);
  gl.uniform1f(glContext.uXR, 1);
  gl.uniform1f(glContext.uYaw, vr.yawOffset);
  gl.uniform1f(glContext.uDim, els.fade.classList.contains("on") ? 0.18 : 1);
  gl.uniform1f(glContext.uForward, (thumbYawOf(viewerFile) * Math.PI) / 180);
  gl.uniformMatrix4fv(glContext.uInvProj, false, invProj);
  gl.uniformMatrix4fv(glContext.uView, false, view.transform.matrix);
  gl.drawArrays(gl.TRIANGLES, 0, 3);

  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  gl.useProgram(glContext.markProgram);
  gl.bindVertexArray(glContext.markerVao);
  gl.uniformMatrix4fv(glContext.markMvp, false, mvp);

  const aimed = new Set();
  for (const hit of rays) {
    if (hit.hit) aimed.add(hit.hit.id);
  }
  for (const marker of vr.markers) {
    const hot = aimed.has(marker.id);
    const { refDir, center } = markerPose(marker.panDir, marker.distance);
    const radius = hot ? 0.2 : 0.16;
    const { right, forward } = flatBasis(refDir, radius);
    const disc = [];
    pushQuad(disc, center, right, forward);
    drawMarkerMesh(disc, 0, hot ? [0.89, 0.53, 0.29, 0.92] : [0.95, 0.93, 0.88, 0.72], null);
    const labelScale = marker.distance / 2.4;
    const labelPos = vecAdd(center, [0, 0.2 * labelScale, 0]);
    const basis = billboardBasis(labelPos, 0.34 * labelScale, 0.085 * labelScale);
    const label = [];
    pushQuad(label, labelPos, basis.right, basis.up);
    drawMarkerMesh(label, 1, [1, 1, 1, 1], labelTexture(marker.name || "Walk", false));
  }

  for (const ray of rays) {
    const endDistance = ray.hit ? ray.hit.t : 3.2;
    const end = vecAdd(ray.origin, vecScale(ray.direction, endDistance));
    let side = vecCross(ray.direction, vecSub(vr.headPos, ray.origin));
    if (vecLen(side) < 1e-4) side = [1, 0, 0];
    side = vecScale(vecNorm(side), ray.hit ? 0.006 : 0.0035);
    const ribbon = [];
    pushTri(ribbon, vecSub(ray.origin, side), vecAdd(ray.origin, side), vecSub(end, side), 0, 0, 1, 0, 0, 1);
    pushTri(ribbon, vecAdd(ray.origin, side), vecAdd(end, side), vecSub(end, side), 1, 0, 1, 1, 0, 1);
    const color = ray.hit ? [0.89, 0.53, 0.29, 0.95] : [1, 1, 1, 0.55];
    drawMarkerMesh(ribbon, 2, color, null);
  }

  if (showHint) {
    const center = vecAdd(vr.headPos, vecScale(vecNorm(vecAdd(vr.headForward, [0, -0.32, 0])), 1.7));
    const basis = billboardBasis(center, 0.62, 0.12);
    const hint = [];
    pushQuad(hint, center, basis.right, basis.up);
    drawMarkerMesh(
      hint,
      1,
      [1, 1, 1, 1],
      labelTexture("Trigger on a marker walks. Stick turns and steps forward. A toggles day and night.", true),
    );
  }
}

function onXRFrame(time, frame) {
  const session = frame.session;
  if (!xrSession || session !== xrSession) return;
  session.requestAnimationFrame(onXRFrame);
  if (!glContext || !viewerFile || !vr.refSpace || !vr.layer) return;
  const pose = frame.getViewerPose(vr.refSpace);
  if (!pose) return;
  const dt = vr.lastTime ? Math.min(0.05, (time - vr.lastTime) / 1000) : 0;
  vr.lastTime = time;
  const head = pose.transform;
  vr.headPos = [head.position.x, head.position.y, head.position.z];
  vr.headForward = vecNorm(quatRotate(head.orientation, [0, 0, -1]));
  vr.headYaw = Math.atan2(vr.headForward[0], -vr.headForward[2]);
  if (!vr.aligned) {
    vr.yawOffset = vr.headYaw - look.yaw;
    vr.aligned = true;
    vr.hintUntil = time + 8000;
  }
  look.yaw = vr.headYaw - vr.yawOffset;
  applyStickTurn(dt);
  vr.markers = markerList();
  const { hits, rays } = collectControllerHits(frame);
  pollVrInput(hits);

  const gl = glContext.gl;
  gl.bindFramebuffer(gl.FRAMEBUFFER, vr.layer.framebuffer);
  gl.viewport(0, 0, vr.layer.framebufferWidth, vr.layer.framebufferHeight);
  gl.disable(gl.DEPTH_TEST);
  gl.disable(gl.CULL_FACE);
  gl.clearColor(0.027, 0.027, 0.024, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  const showHint = time < vr.hintUntil;
  for (const view of pose.views) drawVrEye(view, rays, showHint);
}

function onXREnd() {
  if (!xrSession) return;
  if (vr.aligned) look.yaw = vr.headYaw - vr.yawOffset;
  look.pitch = 0;
  xrSession = null;
  vr.aligned = false;
  vr.refSpace = null;
  vr.layer = null;
  vr.markers = [];
  if (vr.supported) els.enterVr.hidden = false;
  if (!viewerLoop && !els.viewer.hidden && viewerPlaceId) startViewerLoop();
}

async function enterVR() {
  if (adminMode || xrSession || !navigator.xr || !glContext || !viewerFile) return;
  els.viewerError.hidden = true;
  const session = await navigator.xr.requestSession("immersive-vr", {
    optionalFeatures: ["local-floor"],
  });
  xrSession = session;
  try {
    session.addEventListener("end", onXREnd);
    const gl = glContext.gl;
    await gl.makeXRCompatible();
    vr.layer = new XRWebGLLayer(session, gl, { antialias: false, framebufferScaleFactor: 1 });
    await session.updateRenderState({ baseLayer: vr.layer });
    try {
      vr.refSpace = await session.requestReferenceSpace("local-floor");
    } catch (error) {
      log.warn("vr floor reference unavailable", { error });
      vr.refSpace = await session.requestReferenceSpace("local");
    }
    vr.aligned = false;
    vr.lastTime = 0;
    vr.hintUntil = 0;
    for (const hand of Object.values(vr.hands)) {
      hand.a = false;
      hand.trigger = false;
      hand.forward = false;
    }
    els.enterVr.hidden = true;
    session.requestAnimationFrame(onXRFrame);
  } catch (error) {
    xrSession = null;
    vr.aligned = false;
    vr.refSpace = null;
    vr.layer = null;
    if (!viewerLoop && viewerPlaceId && !els.viewer.hidden) startViewerLoop();
    session.end().catch((error) => {
      log.warn("vr session did not close", { error });
    });
    throw error;
  }
}

async function prepareVR() {
  if (adminMode || !els.vrPanel) return;
  const headset = /Quest|OculusBrowser/i.test(navigator.userAgent);
  if (!window.isSecureContext) {
    if (!headset) return;
    els.vrPanel.hidden = false;
    els.vrNote.textContent = "VR needs a secure page. Open this tour over HTTPS.";
    return;
  }
  if (!navigator.xr) return;
  try {
    vr.supported = await navigator.xr.isSessionSupported("immersive-vr");
  } catch (error) {
    log.warn("vr support check failed", { error });
    vr.supported = false;
  }
  if (!vr.supported) return;
  els.vrPanel.hidden = false;
  els.enterVr.hidden = false;
  els.vrNote.textContent = "Point at a marker and pull the trigger to walk. Push the stick forward to step ahead, and sideways to turn. Press A for day and night.";
}

function syncHotspots() {
  const spot = viewerSpot();
  if (!spot) return;
  const neighbors = reachableNeighbors(spot, viewerTime);
  const keep = new Set(neighbors.map((item) => item.id));
  for (const [id, element] of hotspotEls) {
    if (!keep.has(id)) {
      element.remove();
      hotspotEls.delete(id);
    }
  }
  const width = els.pano.clientWidth;
  const height = els.pano.clientHeight;
  let visible = 0;
  neighbors.forEach((other, index) => {
    let element = hotspotEls.get(other.id);
    if (!element) {
      element = document.createElement("button");
      element.type = "button";
      element.className = "hotspot";
      element.innerHTML = `<span class="name"></span><span class="disc"></span>`;
      element.addEventListener("click", (event) => {
        event.stopPropagation();
        travelTo(other.id);
      });
      els.hotspots.appendChild(element);
      hotspotEls.set(other.id, element);
    }
    element.querySelector(".name").textContent = other.name;
    element.setAttribute("aria-label", adminMode ? other.name : "Walk here");
    const aim = markerAim(spot, other);
    const projected = projectDirection(aim.imageYaw, aim.imagePitch, look.yaw, look.pitch, look.fov, width, height);
    if (!projected) {
      element.style.display = "none";
      return;
    }
    visible += 1;
    element.style.display = "flex";
    element.style.left = `${projected.x}px`;
    element.style.top = `${projected.y}px`;
    element.style.zIndex = String(200 - index);
    element.style.transform = `translate(-50%, -100%) scale(${aim.scale})`;
  });
  els.noLinks.hidden = neighbors.length > 0;
  if (visible === 0 && neighbors.length > 0) els.noLinks.hidden = true;
}

function drawMinimap() {
  const canvas = els.minimap;
  const dpr = 2;
  const cssW = canvas.clientWidth || 240;
  const cssH = canvas.clientHeight || 180;
  if (canvas.width !== Math.floor(cssW * dpr) || canvas.height !== Math.floor(cssH * dpr)) {
    canvas.width = Math.floor(cssW * dpr);
    canvas.height = Math.floor(cssH * dpr);
  }
  const context = canvas.getContext("2d");
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.clearRect(0, 0, cssW, cssH);
  const { w, h } = worldSize();
  const pad = 16;
  const scale = Math.min((cssW - pad * 2) / w, (cssH - pad * 2) / h);
  const ox = (cssW - w * scale) / 2;
  const oy = (cssH - h * scale) / 2;
  miniGeom = { ox, oy, scale, w, h };
  context.fillStyle = "#efe6d4";
  roundRect(context, ox, oy, w * scale, h * scale, 6);
  context.fill();
  if (state.floorplanImage) {
    const plan = contentToSheet(0, 0);
    const planFar = contentToSheet(1, 1);
    context.save();
    context.globalAlpha = state.tour.planOpacity;
    context.drawImage(
      state.floorplanImage,
      ox + plan.nx * w * scale,
      oy + plan.ny * h * scale,
      (planFar.nx - plan.nx) * w * scale,
      (planFar.ny - plan.ny) * h * scale,
    );
    context.restore();
  }
  const spot = viewerSpot();
  for (const other of state.tour.spots) {
    const sheet = contentToSheet(other.nx, other.ny);
    const x = ox + sheet.nx * w * scale;
    const y = oy + sheet.ny * h * scale;
    const here = other.id === viewerPlaceId;
    const nightOnly = Boolean(other.night && !other.day);
    context.beginPath();
    context.arc(x, y, here ? 6 : 3.5, 0, Math.PI * 2);
    context.fillStyle = here ? "#e3874a" : nightOnly ? "#355f8a" : "#2c6d62";
    context.fill();
  }
  if (!spot) return;
  const here = contentToSheet(spot.nx, spot.ny);
  const x = ox + here.nx * w * scale;
  const y = oy + here.ny * h * scale;
  const bearing = look.yaw + (spot.yaw * Math.PI) / 180;
  const dx = Math.sin(bearing);
  const dy = -Math.cos(bearing);
  const px = -dy;
  const py = dx;
  const length = 42;
  context.fillStyle = "rgba(227, 135, 74, 0.35)";
  context.beginPath();
  context.moveTo(x, y);
  context.lineTo(x + dx * length + px * 12, y + dy * length + py * 12);
  context.lineTo(x + dx * length - px * 12, y + dy * length - py * 12);
  context.closePath();
  context.fill();
  els.facing.textContent = `Facing ${bearingPhrase(bearing)}`;
}

let viewerLoop = false;
function frameViewer() {
  if (xrSession) {
    viewerLoop = false;
    return;
  }
  if (els.viewer.hidden || !viewerPlaceId) {
    viewerLoop = false;
    return;
  }
  drawPano();
  syncHotspots();
  drawMinimap();
  requestAnimationFrame(frameViewer);
}

function startViewerLoop() {
  if (viewerLoop) return;
  viewerLoop = true;
  frameViewer();
}

function setView(spot, time) {
  viewerPlaceId = spot ? spot.id : null;
  viewerTime = time || null;
  viewerFile = spot && time ? spot[time] : null;
}

function updateTimeToggle() {
  const spot = viewerSpot();
  const open = Boolean(spot) && !els.viewer.hidden;
  els.showDay.disabled = !open || !spot.day;
  els.showNight.disabled = !open || !spot.night;
  els.showDay.classList.toggle("on", open && viewerTime === "day");
  els.showNight.classList.toggle("on", open && viewerTime === "night");
  els.showDay.title = spot?.day ? "Show the day photo" : "No day photo here";
  els.showNight.title = spot?.night ? "Show the night photo" : "No night photo here";
}

async function openViewer(id, time) {
  const spot = placeById(id);
  if (!spot) return;
  if (time === "day" || time === "night") state.time = time;
  const shown = shownTime(spot, state.time);
  const file = shown ? spot[shown] : null;
  if (!file) return;
  if (!els.viewer.hidden && viewerPlaceId === spot.id) {
    if (viewerTime !== shown) switchTime(shown);
    return;
  }
  selectSpot(spot.id, false);
  setView(spot, shown);
  look.yaw = 0;
  look.pitch = 0;
  look.fov = 1.15;
  els.viewer.hidden = false;
  els.viewerError.hidden = true;
  els.viewerName.value = spot.name;
  els.facing.textContent = "";
  updateTimeToggle();
  try {
    initGl();
  } catch (error) {
    log.error("panorama view failed to start", { error });
    els.viewerError.hidden = false;
    els.viewerError.textContent = error.message || "Could not start the panorama view.";
    return;
  }
  if (!glContext) {
    log.warn("webgl2 unavailable");
    els.viewerError.hidden = false;
    els.viewerError.textContent = "This browser cannot show the panoramas (WebGL2 is unavailable).";
    return;
  }
  const token = ++loadToken;
  startViewerLoop();
  try {
    const image = await loadPanorama(file, token);
    if (!image || token !== loadToken) return;
    els.loadMask.hidden = true;
    preloadNeighbors(spot);
  } catch (error) {
    if (token !== loadToken) return;
    log.error("photo failed to load", { file, error });
    els.loadMask.hidden = true;
    els.viewerError.hidden = false;
    els.viewerError.textContent = error.message || "Could not load that photo.";
  }
}

function preloadNeighbors(spot) {
  const files = [];
  const otherTime = viewerTime === "night" ? "day" : "night";
  if (spot[otherTime]) files.push(spot[otherTime]);
  const mode = viewerTime === "night" ? "night" : "day";
  for (const other of reachableNeighbors(spot, mode).slice(0, 3)) {
    files.push(other[mode]);
  }
  for (const file of files) {
    if (panoramaImages.has(file) || panoramaDecode.has(file)) continue;
    decodePanorama(file).catch((error) => {
      log.warn("photo preload failed", { file, error });
    });
  }
}

let traveling = false;

function toggleDayNight() {
  const spot = viewerSpot();
  if (!spot || els.viewer.hidden || traveling) return;
  const next = viewerTime === "night" ? "day" : "night";
  if (!spot[next]) return;
  state.time = next;
  switchTime(next);
}

function coverFade() {
  const fade = els.fade;
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      fade.removeEventListener("transitionend", onEnd);
      resolve();
    };
    const onEnd = (event) => {
      if (event.target === fade && event.propertyName === "opacity") finish();
    };
    fade.addEventListener("transitionend", onEnd);
    setTimeout(finish, 240);
  });
}

async function switchTime(time) {
  const spot = viewerSpot();
  if (!spot || els.viewer.hidden || !spot[time] || traveling || viewerTime === time) return;
  traveling = true;
  const token = ++loadToken;
  const file = spot[time];
  els.fade.classList.add("on");
  try {
    const imagePromise = fetchPanorama(file, token);
    await coverFade();
    if (token !== loadToken) return;
    const image = await imagePromise;
    if (token !== loadToken || !image) return;
    setView(spot, time);
    uploadTexture(image);
    updateTimeToggle();
    if (!xrSession) {
      drawPano();
      syncHotspots();
    }
    els.loadMask.hidden = true;
    preloadNeighbors(spot);
  } catch (error) {
    if (token === loadToken) {
      log.error("day night switch failed", { file, time, error });
      els.loadText.textContent = "Could not load that photo.";
    }
  } finally {
    traveling = false;
    if (token === loadToken) els.fade.classList.remove("on");
  }
}

async function travelTo(id) {
  if (traveling || !id || id === viewerPlaceId) return;
  const current = viewerSpot();
  const next = placeById(id);
  const time = viewerTime === "night" ? "night" : "day";
  const file = next && next[time];
  if (!current || !file) return;
  traveling = true;
  const token = ++loadToken;
  const bearing = look.yaw + (current.yaw * Math.PI) / 180;
  els.fade.classList.add("on");
  try {
    const imagePromise = fetchPanorama(file, token);
    await coverFade();
    if (token !== loadToken) return;
    const image = await imagePromise;
    if (token !== loadToken || !image) return;
    setView(next, time);
    state.selected = next.id;
    state.time = time;
    setViewYaw(bearing - (next.yaw * Math.PI) / 180);
    uploadTexture(image);
    syncInspector();
    renderTray();
    els.viewerName.value = next.name;
    updateTimeToggle();
    if (!xrSession) {
      drawPano();
      syncHotspots();
    }
    els.loadMask.hidden = true;
    preloadNeighbors(next);
  } catch (error) {
    if (token === loadToken) {
      log.error("walk failed", { place: id, file, error });
      els.loadText.textContent = "Could not load that photo.";
    }
  } finally {
    traveling = false;
    if (token === loadToken) els.fade.classList.remove("on");
  }
}

function closeViewer() {
  if (!adminMode) return;
  loadToken += 1;
  setView(null, null);
  els.viewer.hidden = true;
  els.fade.classList.remove("on");
  updateTimeToggle();
  for (const element of hotspotEls.values()) element.remove();
  hotspotEls.clear();
  requestDraw();
}

function rotatePlacement(deltaDeg) {
  const spot = viewerSpot() || selectedSpot();
  if (!spot) return;
  pushUndo(spot);
  setSpotYaw(spot, spot.yaw + deltaDeg);
  scheduleSave();
  syncInspector();
  requestDraw();
}

function alignViewToTop() {
  const spot = viewerSpot();
  if (!spot) return;
  pushUndo(spot);
  setSpotYaw(spot, (-look.yaw * 180) / Math.PI);
  scheduleSave();
  syncInspector();
  requestDraw();
}

function renameSpot(id, name) {
  const spot = placeById(id);
  if (!spot) return;
  spot.name = name.slice(0, 48);
  scheduleSave();
  renderTray();
  if (viewerPlaceId === id && document.activeElement !== els.viewerName) els.viewerName.value = spot.name;
  if (state.selected === id && document.activeElement !== els.name) els.name.value = spot.name;
  requestDraw();
}

function finishName(id) {
  const spot = placeById(id);
  if (!spot) return;
  spot.name = spot.name.trim().slice(0, 48) || fallbackName(spot);
  scheduleSave();
  renderTray();
  syncInspector();
  if (viewerPlaceId === id) els.viewerName.value = spot.name;
  requestDraw();
}

function onKeyDown(event) {
  const typing = event.target instanceof Element && event.target.matches("input, textarea");
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z" && !typing) {
    event.preventDefault();
    undo();
    return;
  }
  if (event.key === "Escape") {
    if (!els.viewer.hidden) {
      closeViewer();
      return;
    }
    if (state.placing) {
      setPlacing(false);
      return;
    }
  }
  if (!els.viewer.hidden) {
    if (event.key === "ArrowLeft") look.yaw -= 0.08;
    if (event.key === "ArrowRight") look.yaw += 0.08;
    if (event.key === "ArrowUp") look.pitch = clamp(look.pitch + 0.06, -1.2, 1.2);
    if (event.key === "ArrowDown") look.pitch = clamp(look.pitch - 0.06, -1.2, 1.2);
    if (!typing && !event.repeat && event.key.toLowerCase() === "a") {
      event.preventDefault();
      toggleDayNight();
    }
    return;
  }
  if (typing) return;
  const spot = selectedSpot();
  if (!spot) return;
  const step = event.shiftKey ? 0.02 : 0.006;
  const limits = pinLimits(0.015);
  let moved = false;
  if (event.key === "ArrowLeft") {
    spot.nx = clamp(spot.nx - step, limits.minX, limits.maxX);
    moved = true;
  } else if (event.key === "ArrowRight") {
    spot.nx = clamp(spot.nx + step, limits.minX, limits.maxX);
    moved = true;
  } else if (event.key === "ArrowUp") {
    spot.ny = clamp(spot.ny - step, limits.minY, limits.maxY);
    moved = true;
  } else if (event.key === "ArrowDown") {
    spot.ny = clamp(spot.ny + step, limits.minY, limits.maxY);
    moved = true;
  } else if (event.key === "[" || event.key === "]") {
    setSpotYaw(spot, spot.yaw + (event.key === "]" ? 5 : -5));
    moved = true;
  } else if (event.key === "Enter") {
    openViewer(spot.id);
  }
  if (moved) {
    event.preventDefault();
    scheduleSave();
    syncInspector();
    requestDraw();
  }
}

let lookDrag = null;
function onViewDown(event) {
  if (event.button !== 0) return;
  lookDrag = { x: event.clientX, y: event.clientY, yaw: look.yaw, pitch: look.pitch };
  els.pano.setPointerCapture(event.pointerId);
  els.pano.classList.add("grabbing");
}
function onViewMove(event) {
  if (!lookDrag) return;
  const speed = (2 * Math.tan(look.fov / 2)) / Math.max(1, els.pano.clientHeight);
  const dx = event.clientX - lookDrag.x;
  const dy = event.clientY - lookDrag.y;
  look.yaw = lookDrag.yaw - dx * speed;
  look.pitch = clamp(lookDrag.pitch + dy * speed, -1.25, 1.25);
}
function onViewUp() {
  lookDrag = null;
  els.pano.classList.remove("grabbing");
}

function onMiniClick(event) {
  if (!miniGeom || !viewerPlaceId) return;
  const rect = els.minimap.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  let best = null;
  let bestDist = 14;
  for (const spot of state.tour.spots) {
    if (!hasPhoto(spot)) continue;
    const sheet = contentToSheet(spot.nx, spot.ny);
    const sx = miniGeom.ox + sheet.nx * miniGeom.w * miniGeom.scale;
    const sy = miniGeom.oy + sheet.ny * miniGeom.h * miniGeom.scale;
    const d = Math.hypot(sx - x, sy - y);
    if (d < bestDist) {
      best = spot;
      bestDist = d;
    }
  }
  if (best) travelTo(best.id);
}

async function boot() {
  const photoResponse = await fetch("/api/photos");
  const photoPayload = await photoResponse.json();
  state.photos = photoPayload.photos || [];
  const tourResponse = await fetch("/api/tour");
  const saved = await tourResponse.json();
  const hadTour = Boolean(saved);
  state.tour = mergeTour(saved, state.photos);
  log.info("tour loaded", { photos: state.photos.length, spots: state.tour.spots.length });
  if (!state.photos.length) {
    log.warn("no panoramas found");
    els.trayCount.textContent = "No panoramas found in content/photos.";
  }
  state.selected = state.tour.spots[0]?.id || null;
  await loadFloorplan();
  renderTray();
  syncInspector();
  fitMap();
  if (!hadTour || needsMigration(saved)) {
    await saveNow();
    const rewritten = migratedThumbs.splice(0);
    await Promise.all(rewritten.map((file) => saveThumbFile(file, thumbYawOf(file))));
    if (rewritten.length) {
      renderTray();
      syncInspector();
    }
  }
  if (!adminMode) {
    const start = state.tour.spots.find((spot) => hasPhoto(spot));
    if (start) openViewer(start.id);
    else {
      els.viewer.hidden = false;
      els.loadMask.hidden = false;
      els.loadText.textContent = "No photos are placed on the tour yet.";
    }
  }

  els.map.addEventListener("pointerdown", onPointerDown);
  els.map.addEventListener("pointermove", onPointerMove);
  els.map.addEventListener("pointerup", onPointerUp);
  els.map.addEventListener("pointercancel", onPointerUp);
  els.map.addEventListener("wheel", onWheel, { passive: false });
  els.map.addEventListener("dblclick", (event) => {
    const pos = pointerPos(event);
    const hit = hitTest(pos.x, pos.y);
    if (Date.now() - placedAt < 450) return;
    if (hit && hasPhoto(hit.spot)) openViewer(hit.spot.id);
  });
  els.map.addEventListener("contextmenu", (event) => event.preventDefault());
  window.addEventListener("resize", requestDraw);
  window.addEventListener("keydown", onKeyDown);

  els.search.addEventListener("input", renderTray);
  els.fit.addEventListener("click", fitMap);
  const bindBoard = (button, side) => {
    button.addEventListener("click", (event) => changeBoard(side, !event.shiftKey));
  };
  bindBoard(els.boardLeft, "left");
  bindBoard(els.boardRight, "right");
  bindBoard(els.boardUp, "top");
  bindBoard(els.boardDown, "bottom");
  els.addJump.addEventListener("change", () => {
    const spot = selectedSpot();
    const toId = els.addJump.value;
    if (!spot || !toId) return;
    addJump(spot.id, toId);
  });
  els.reset.addEventListener("click", () => {
    if (!confirm("Put every photo on its own pin again, in the order they were taken? Pins that share a day and night photo will be split.")) return;
    state.tour.spots = defaultSpots(state.photos);
    state.selected = state.tour.spots[0]?.id || null;
    state.selectedPhoto = null;
    state.undo = [];
    saveNow();
    renderTray();
    syncInspector();
    fitMap();
  });
  els.planFile.addEventListener("change", async () => {
    const file = els.planFile.files && els.planFile.files[0];
    els.planFile.value = "";
    if (!file) return;
    const response = await fetch("/api/floorplan", {
      method: "POST",
      headers: { "Content-Type": file.type || "image/jpeg" },
      body: await file.arrayBuffer(),
    });
    if (!response.ok) {
      log.error("floor plan not saved", { status: response.status });
      setSaveStatus("Plan not saved", true);
      return;
    }
    const payload = await response.json();
    state.tour.floorplan = payload.file;
    await loadFloorplan();
    saveNow();
    fitMap();
  });
  els.removePlan.addEventListener("click", async () => {
    await fetch("/api/floorplan", { method: "DELETE" });
    state.tour.floorplan = null;
    await loadFloorplan();
    saveNow();
    fitMap();
  });
  els.opacity.addEventListener("input", () => {
    state.tour.planOpacity = Number(els.opacity.value);
    scheduleSave();
    requestDraw();
  });
  els.name.addEventListener("input", () => {
    if (state.selected) renameSpot(state.selected, els.name.value);
  });
  els.name.addEventListener("blur", () => {
    if (state.selected) finishName(state.selected);
  });
  els.yawLeft.addEventListener("click", () => rotatePlacement(-15));
  els.yawRight.addEventListener("click", () => rotatePlacement(15));
  els.align.addEventListener("click", alignViewToTop);
  els.placeYaw.addEventListener("input", () => {
    const spot = selectedSpot();
    if (!spot) return;
    setSpotYaw(spot, Number(els.placeYaw.value));
    scheduleSave();
    syncInspector();
    requestDraw();
  });
  els.walk.addEventListener("click", () => {
    if (state.selected) openViewer(state.selected);
  });
  els.setDay.addEventListener("click", () => useSelected("day"));
  els.setNight.addEventListener("click", () => useSelected("night"));
  els.clearDay.addEventListener("click", () => clearSlot("day"));
  els.clearNight.addEventListener("click", () => clearSlot("night"));
  els.removePin.addEventListener("click", removeSelectedPin);
  els.removeAll.addEventListener("click", removeAllPins);
  els.addPin.addEventListener("click", () => setPlacing(!state.placing));
  els.showDay.addEventListener("click", () => {
    state.time = "day";
    switchTime("day");
  });
  els.showNight.addEventListener("click", () => {
    state.time = "night";
    switchTime("night");
  });

  els.viewerName.readOnly = !adminMode;
  els.back.addEventListener("click", closeViewer);
  els.viewerName.addEventListener("input", () => {
    if (viewerPlaceId) renameSpot(viewerPlaceId, els.viewerName.value);
  });
  els.viewerName.addEventListener("blur", () => {
    if (viewerPlaceId) finishName(viewerPlaceId);
  });
  els.pano.addEventListener("pointerdown", onViewDown);
  els.pano.addEventListener("pointermove", onViewMove);
  els.pano.addEventListener("pointerup", onViewUp);
  els.pano.addEventListener("pointercancel", onViewUp);
  els.pano.addEventListener("wheel", (event) => {
    event.preventDefault();
    look.fov = clamp(look.fov * Math.exp(event.deltaY * 0.001), 0.55, 1.7);
  }, { passive: false });
  els.minimap.addEventListener("click", onMiniClick);
  if (!adminMode && els.enterVr) {
    els.enterVr.addEventListener("click", () => {
      enterVR().catch((error) => {
        log.error("vr failed", { error });
        els.viewerError.hidden = false;
        els.viewerError.textContent = error.message || "Could not enter VR.";
      });
    });
    prepareVR();
  }
  new ResizeObserver(() => {
    if (!state.drag) requestDraw();
  }).observe(els.map);
}

boot().catch((error) => {
  log.error("tour failed to load", { error });
  els.trayCount.textContent = error.message || "Could not load the tour.";
});
