// Generates src/netfieldsData.ts from the reference NetFields.cpp.
// Entity-state fields get REAL struct offsets (union aliasing + cross-table
// consistency + position extraction). Player/Client/Hud/Objective fields get
// synthetic offsets — only their bit consumption matters to us, not values.
import { readFileSync, writeFileSync } from "node:fs";

const SRC = process.argv[2]; // path to NetFields.cpp
const OUT = process.argv[3]; // path to netfieldsData.ts

// --- entityState_t real offset map (bytes), derived from DemoData.hpp ---
const TRAJ = { trType: 0, trTime: 4, trDuration: 8 };
function trajOff(base, member) {
  if (member in TRAJ) return base + TRAJ[member];
  const m = member.match(/^(trBase|trDelta)\[(\d)\]$/);
  if (m) return base + (m[1] === "trBase" ? 12 : 24) + Number(m[2]) * 4;
  throw new Error("bad traj member " + member);
}
const U = 84; // offset of lerp.u
const ENT = new Map();
function setEnt(name, off) {
  ENT.set(name, off);
}
setEnt("number", 0);
setEnt("eType", 4);
setEnt("lerp.eFlags", 8);
for (const [pfx, base] of [["lerp.pos", 12], ["lerp.apos", 48]]) {
  for (const k of ["trType", "trTime", "trDuration"]) setEnt(`${pfx}.${k}`, trajOff(base, k));
  for (let i = 0; i < 3; i++) {
    setEnt(`${pfx}.trBase[${i}]`, trajOff(base, `trBase[${i}]`));
    setEnt(`${pfx}.trDelta[${i}]`, trajOff(base, `trDelta[${i}]`));
  }
}
// union lerp.u members (all overlap at offset 84)
setEnt("lerp.u.player.leanf", U + 0);
setEnt("lerp.u.player.movementDir", U + 4);
for (let i = 0; i < 7; i++) setEnt(`lerp.u.anonymous.buffer[${i}]`, U + i * 4);
setEnt("lerp.u.loopFx.cullDist", U + 0);
setEnt("lerp.u.loopFx.period", U + 4);
setEnt("lerp.u.missile.launchTime", U + 0);
setEnt("lerp.u.soundBlend.lerp", U + 0);
setEnt("lerp.u.vehicle.bodyPitch", U + 0);
setEnt("lerp.u.vehicle.bodyRoll", U + 4);
setEnt("lerp.u.vehicle.steerYaw", U + 8);
setEnt("lerp.u.vehicle.materialTime", U + 12);
setEnt("lerp.u.vehicle.gunPitch", U + 16);
setEnt("lerp.u.vehicle.gunYaw", U + 20);
setEnt("lerp.u.vehicle.team", U + 24);
// trailing scalar members
const SCALARS = [
  ["time2", 112], ["otherEntityNum", 116], ["attackerEntityNum", 120], ["groundEntityNum", 124],
  ["loopSound", 128], ["surfType", 132], ["index", 136], ["ClientNum", 140], ["iHeadIcon", 144],
  ["iHeadIconTeam", 148], ["solid", 152], ["eventParm", 156], ["eventSequence", 160],
  ["weapon", 196], ["weaponModel", 200], ["legsAnim", 204], ["torsoAnim", 208], ["un1", 212],
  ["un1.helicopterStage", 212], ["un2", 216], ["fTorsoPitch", 220], ["fWaistPitch", 224],
];
for (const [n, o] of SCALARS) setEnt(n, o);
for (let i = 0; i < 4; i++) setEnt(`events[${i}]`, 164 + i * 4);
for (let i = 0; i < 4; i++) setEnt(`eventParms[${i}]`, 180 + i * 4);
for (let i = 0; i < 4; i++) setEnt(`partBits[${i}]`, 228 + i * 4);
const ENTITY_STATE_SIZE = 244;

function entOffset(expr) {
  if (!ENT.has(expr)) throw new Error("Unknown entityState field: " + expr);
  return ENT.get(expr);
}

// --- clientState_t real offset map (bytes), from natural struct alignment ---
const CS = new Map();
CS.set("clientIndex", 0);
CS.set("team", 4);
CS.set("modelindex", 8);
for (let i = 0; i < 6; i++) CS.set(`attachModelIndex[${i}]`, 12 + 4 * i);
for (let i = 0; i < 6; i++) CS.set(`attachTagIndex[${i}]`, 36 + 4 * i);
for (const j of [0, 4, 8, 12]) CS.set(`netname[${j}]`, 60 + j);
CS.set("maxSprintTimeMultiplier", 92);
CS.set("rank", 96);
CS.set("prestige", 100);
CS.set("perks", 104);
CS.set("attachedVehEntNum", 108);
CS.set("attachedVehSlotIndex", 112);
const CLIENT_STATE_SIZE = 116;
function csOffset(expr) {
  if (!CS.has(expr)) throw new Error("Unknown clientState field: " + expr);
  return CS.get(expr);
}

const text = readFileSync(SRC, "utf8");
const entryRe = /\{\s*(NETF|PSF|CSF|HEF|OBJF|AEF)\(([^)]*)\)\s*,\s*(-?\d+)\s*,\s*(\d+)\s*\}/g;
const tableRe = /netField_t\s+NetFields::(\w+)\s*\[[^\]]*\]\s*=\s*\{([\s\S]*?)\};/g;

const ENTITY_TABLES = new Set([
  "EntityStateFields", "PlayerEntityStateFields", "CorpseEntityStateFields", "ItemEntityStateFields",
  "MissleEntityStateFields", "ScriptMoverStateFields", "SoundBlendEntityStateFields", "FxStateFields",
  "LoopFxEntityStateFields", "HelicopterEntityStateFields", "PlaneStateFields", "VehicleEntityStateFields",
  "EventEntityStateFields",
]);
const WANT = new Set([...ENTITY_TABLES, "PlayerStateFields", "HudElemFields", "ClientStateFields", "ObjectiveFields"]);

const tables = {};
const sizes = {};
let m;
while ((m = tableRe.exec(text))) {
  const name = m[1];
  if (!WANT.has(name)) continue;
  const body = m[2];
  const fields = [];
  let e;
  entryRe.lastIndex = 0;
  let synthetic = 0;
  while ((e = entryRe.exec(body))) {
    const expr = e[2];
    const bits = Number(e[3]);
    const changeHints = Number(e[4]);
    let off;
    if (ENTITY_TABLES.has(name)) off = entOffset(expr);
    else if (name === "ClientStateFields") off = csOffset(expr);
    else off = synthetic;
    synthetic += 4;
    fields.push({ o: off, b: bits, c: changeHints, n: expr });
  }
  tables[name] = fields;
  sizes[name] = ENTITY_TABLES.has(name)
    ? ENTITY_STATE_SIZE
    : name === "ClientStateFields"
      ? CLIENT_STATE_SIZE
      : fields.length * 4;
}

// List[18]: eType -> table name
const listMatch = text.match(/netFieldList_t\s+NetFields::List\s*\[[^\]]*\]\s*=\s*\{([\s\S]*?)\};/);
const list = [...listMatch[1].matchAll(/NETFE\((\w+)\)/g)].map((x) => x[1]);

const out =
  `// AUTO-GENERATED by scripts/gen-netfields.mjs from Iswenzz/CoD4-DM1 NetFields.cpp.\n` +
  `// Do not edit by hand. { o: offset, b: bits, c: changeHints }\n` +
  `export interface NetField { o: number; b: number; c: number; n: string; }\n` +
  `export const ENTITY_STATE_SIZE = ${ENTITY_STATE_SIZE};\n` +
  `export const TABLES: Record<string, NetField[]> = ${JSON.stringify(tables)};\n` +
  `export const STRUCT_SIZE: Record<string, number> = ${JSON.stringify(sizes)};\n` +
  `export const ETYPE_LIST: string[] = ${JSON.stringify(list)};\n`;

writeFileSync(OUT, out);
console.log(`Wrote ${OUT}`);
console.log("tables:", Object.keys(tables).map((k) => `${k}(${tables[k].length})`).join(", "));
console.log("List entries:", list.length, "->", [...new Set(list)].join(", "));
