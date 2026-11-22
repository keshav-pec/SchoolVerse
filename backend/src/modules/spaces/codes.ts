import { floorCodeFor } from '@shared';

/** Codes are made from names when nobody types one. They are upper-case and at most 20 characters. */

const MAX = 20;

const clean = (text: string) => text.toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/** Returns `base`, or `base-2`, `base-3`… the first one `taken` does not have. */
export function firstFree(base: string, taken: ReadonlySet<string>): string {
  const root = base.slice(0, MAX - 3) || 'X';
  if (!taken.has(base.slice(0, MAX))) return base.slice(0, MAX);
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${root}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${root}-${Date.now() % 1000}`;
}

/** "Main Academic Block" → MAB, "Annex" → ANNE. */
export function buildingCodeFrom(name: string, taken: ReadonlySet<string>): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const initials = words.length > 1 ? words.map((w) => w[0]).join('') : (words[0] ?? 'B');
  return firstFree(clean(initials).slice(0, 4) || 'B', taken);
}

/** Ground → GF, First → F1, Basement → B1. */
export function floorCodeFrom(floorNumber: number, taken: ReadonlySet<string>): string {
  return firstFree(floorCodeFor(floorNumber), taken);
}

/**
 * The room code when none is typed: the room number if there is one ("101"), else the name ("CHEMISTRY-LAB").
 * When another room at the campus already has it, the building code goes in front ("A-101").
 */
export function spaceCodeFrom(input: { roomNumber: string | null; spaceName: string; buildingCode: string | null }, taken: ReadonlySet<string>): string {
  const base = clean(input.roomNumber ?? '') || clean(input.spaceName).slice(0, MAX) || 'ROOM';
  if (!taken.has(base)) return base;
  if (input.buildingCode) {
    const prefixed = `${input.buildingCode}-${base}`.slice(0, MAX);
    if (!taken.has(prefixed)) return prefixed;
    return firstFree(prefixed, taken);
  }
  return firstFree(base, taken);
}

/** A number that keeps its zero padding: "G01" + 1 → "G02", "101" + 100 → "201". Returns `null` when the code has no trailing number. */
export function shiftTrailingNumber(code: string, add: number): string | null {
  const match = /^(.*?)(\d+)$/.exec(code);
  if (!match) return null;
  const next = Number(match[2]) + add;
  if (next < 0) return null;
  return `${match[1]}${String(next).padStart(match[2]!.length, '0')}`;
}
