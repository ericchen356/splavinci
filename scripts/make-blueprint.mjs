/**
 * Draws the labelled floor plan for each sample scene.
 *
 *   node scripts/make-blueprint.mjs              # every scene
 *   node scripts/make-blueprint.mjs birch-row    # one scene
 *
 * Writes samples/<id>/blueprint.svg and, when a rasteriser is available,
 * samples/<id>/blueprint.png.
 *
 * WHY THE DETAIL. The Marble pipeline never opens this file - lib/marble/intake.ts
 * takes the layout as a sentence of English and uses the image only for
 * provenance. The drawing therefore exists for the human (or the vision model)
 * who writes that sentence, and a sentence is only as good as the plan it was
 * read off. A plan whose rooms are unnamed and unmeasured produces "some rooms,
 * probably", which produces a world that matches nothing.
 *
 * The three plans are deliberately unlike each other - a compact one-bed, a
 * two-bed with a central hall, an open-plan loft - so a difference downstream
 * can be attributed to the layout rather than to the renderer having drawn the
 * same flat three times.
 *
 * Geometry is in metres, x right and y down, matching lib/path's floor plane.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { hWall, planToSvg, rasterise, svgSize, vWall } from './lib/blueprint.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/* -------------------------------------------------------------------------- */
/* scene 1 - maple-street: two bedrooms off a short central hallway           */
/* -------------------------------------------------------------------------- */

const T_EXT = 0.24;
const T_INT = 0.12;

const mapleStreet = {
  id: 'maple-street',
  name: 'Maple Street',
  subtitle: 'Two-bedroom apartment · open-plan living · central hallway',
  ceiling: 2.6,
  size: [12.0, 8.0],
  walls: [
    { x: 0, y: 0, w: 12.0, h: T_EXT },
    { x: 0, y: 8.0 - T_EXT, w: 12.0, h: T_EXT },
    { x: 0, y: 0, w: T_EXT, h: 8.0 },
    { x: 12.0 - T_EXT, y: 0, w: T_EXT, h: 8.0 },
    vWall(6.3, 0.24, 7.76, T_INT),
    hWall(6.3, 11.76, 3.3, T_INT),
    hWall(6.3, 11.76, 4.6, T_INT),
    vWall(9.3, 4.6, 7.76, T_INT),
  ],
  // The one element the layout sentence names explicitly: the kitchen is not a
  // room, it is a galley behind a counter-height wall.
  lowWalls: [{ x: 0.24, y: 2.83, w: 2.16, h: 0.14 }],
  rooms: [
    { name: 'Kitchen', x: 0.24, y: 0.24, w: 3.16, h: 2.66, labelAt: [1.82, 1.55], tint: true },
    { name: 'Dining area', x: 3.4, y: 0.24, w: 2.84, h: 2.66, labelAt: [4.82, 2.6], small: true },
    { name: 'Living room', x: 0.24, y: 2.9, w: 6.0, h: 4.86, labelAt: [3.55, 4.35] },
    { name: 'Primary bedroom', x: 6.36, y: 0.24, w: 5.4, h: 3.0, labelAt: [9.06, 2.75] },
    { name: 'Hallway', x: 6.36, y: 3.36, w: 5.4, h: 1.18, labelAt: [9.4, 4.0], small: true, noArea: true },
    { name: 'Bedroom 2', x: 6.36, y: 4.66, w: 2.88, h: 3.1, labelAt: [7.8, 5.05], small: true },
    { name: 'Bathroom', x: 9.36, y: 4.66, w: 2.4, h: 3.1, labelAt: [10.56, 5.95], small: true },
  ],
  openings: [
    { kind: 'door', dir: 'v', x: 11.88, y: 3.55, len: 0.95, t: T_EXT, hinge: 'start', swing: 'back' },
    { kind: 'opening', dir: 'v', x: 6.3, y: 3.5, len: 0.95, t: T_INT },
    { kind: 'door', dir: 'h', x: 7.1, y: 3.3, len: 0.9, t: T_INT, hinge: 'start', swing: 'back' },
    { kind: 'door', dir: 'h', x: 6.55, y: 4.6, len: 0.85, t: T_INT, hinge: 'start', swing: 'front' },
    { kind: 'door', dir: 'h', x: 10.1, y: 4.6, len: 0.8, t: T_INT, hinge: 'start', swing: 'front' },

    { kind: 'window', dir: 'h', x: 0.9, y: 0.12, len: 1.5, t: T_EXT },
    { kind: 'window', dir: 'h', x: 4.1, y: 0.12, len: 1.6, t: T_EXT },
    { kind: 'window', dir: 'h', x: 7.2, y: 0.12, len: 1.6, t: T_EXT },
    { kind: 'window', dir: 'h', x: 9.6, y: 0.12, len: 1.6, t: T_EXT },
    { kind: 'window', dir: 'h', x: 1.2, y: 7.88, len: 1.7, t: T_EXT },
    { kind: 'window', dir: 'h', x: 3.6, y: 7.88, len: 1.7, t: T_EXT },
    { kind: 'window', dir: 'h', x: 7.2, y: 7.88, len: 1.5, t: T_EXT },
    { kind: 'window', dir: 'v', x: 0.12, y: 4.2, len: 2.2, t: T_EXT },
    { kind: 'window', dir: 'v', x: 11.88, y: 0.9, len: 1.8, t: T_EXT },
    { kind: 'window', dir: 'v', x: 11.88, y: 5.3, len: 1.1, t: T_EXT },
  ],
  fixtures: [
    { kind: 'counter', x: 0.3, y: 0.3, w: 3.05, h: 0.62, sinks: [[1.1, 0.61]], hobs: [[2.35, 0.61]] },
    { kind: 'counter', x: 0.3, y: 2.15, w: 1.8, h: 0.65 },

    { kind: 'table', x: 4.1, y: 1.15, w: 1.6, h: 0.9 },
    { kind: 'table', x: 4.28, y: 0.62, w: 0.42, h: 0.42 },
    { kind: 'table', x: 5.08, y: 0.62, w: 0.42, h: 0.42 },
    { kind: 'table', x: 4.28, y: 2.14, w: 0.42, h: 0.42 },
    { kind: 'table', x: 5.08, y: 2.14, w: 0.42, h: 0.42 },

    { kind: 'sofa', x: 0.6, y: 6.6, w: 2.6, h: 0.92, face: 'up' },
    { kind: 'rug', x: 0.7, y: 4.9, w: 2.6, h: 1.6 },
    { kind: 'table', x: 1.5, y: 5.4, w: 1.0, h: 0.58 },
    { kind: 'counter', x: 1.05, y: 4.1, w: 1.7, h: 0.5 },
    { kind: 'sofa', x: 4.2, y: 5.7, w: 0.88, h: 0.88, face: 'left' },

    { kind: 'bed', x: 8.3, y: 0.34, w: 1.6, h: 2.0, head: 'up' },
    { kind: 'table', x: 7.85, y: 0.34, w: 0.42, h: 0.42 },
    { kind: 'table', x: 9.93, y: 0.34, w: 0.42, h: 0.42 },
    { kind: 'wardrobe', x: 6.42, y: 0.4, w: 0.62, h: 2.2 },

    { kind: 'bed', x: 7.1, y: 5.55, w: 1.4, h: 2.0, head: 'up' },
    { kind: 'wardrobe', x: 8.6, y: 4.8, w: 0.6, h: 1.7 },

    { kind: 'bath', x: 9.46, y: 6.94, w: 1.7, h: 0.72 },
    { kind: 'basin', x: 9.46, y: 5.9, w: 0.62, h: 0.46 },
    { kind: 'wc', x: 11.2, y: 6.0, w: 0.42, h: 0.62 },
  ],
  notes: [
    { x: 1.32, y: 3.28, text: 'half-height partition, 1.1 m' },
    { x: 4.62, y: 3.3, text: 'open to living room' },
  ],
  dimensions: [
    { dir: 'h', from: 0, to: 12.0, at: -0.6 },
    { dir: 'v', from: 0, to: 8.0, at: -0.6 },
    { dir: 'h', from: 0, to: 6.3, at: 8.28 },
    { dir: 'h', from: 6.3, to: 12.0, at: 8.28 },
  ],
};

/* -------------------------------------------------------------------------- */
/* scene 2 - birch-row: compact one-bedroom flat                             */
/* -------------------------------------------------------------------------- */

const B_EXT = 0.22;
const B_INT = 0.1;

const birchRow = {
  id: 'birch-row',
  name: 'Birch Row',
  subtitle: 'Compact one-bedroom flat · every room off one small hall',
  ceiling: 2.45,
  size: [8.0, 6.4],
  walls: [
    { x: 0, y: 0, w: 8.0, h: B_EXT },
    { x: 0, y: 6.4 - B_EXT, w: 8.0, h: B_EXT },
    { x: 0, y: 0, w: B_EXT, h: 6.4 },
    { x: 8.0 - B_EXT, y: 0, w: B_EXT, h: 6.4 },
    hWall(0.22, 2.8, 2.5, B_INT),
    vWall(2.8, 0.22, 6.18, B_INT),
    hWall(2.8, 7.78, 3.6, B_INT),
    hWall(0.22, 2.8, 4.3, B_INT),
  ],
  rooms: [
    { name: 'Kitchen', x: 0.22, y: 0.22, w: 2.53, h: 2.23, labelAt: [1.48, 1.5], small: true },
    { name: 'Living room', x: 2.85, y: 0.22, w: 4.93, h: 3.33, labelAt: [5.0, 2.0] },
    { name: 'Entrance hall', x: 0.22, y: 2.55, w: 2.53, h: 1.7, labelAt: [1.48, 3.4], small: true },
    { name: 'Shower room', x: 0.22, y: 4.35, w: 2.53, h: 1.83, labelAt: [1.48, 4.72], small: true },
    { name: 'Bedroom', x: 2.85, y: 3.65, w: 4.93, h: 2.53, labelAt: [3.55, 5.6], small: true },
  ],
  openings: [
    { kind: 'door', dir: 'v', x: 0.11, y: 2.9, len: 0.9, t: B_EXT, hinge: 'start', swing: 'front' },
    { kind: 'opening', dir: 'h', x: 1.55, y: 2.5, len: 1.0, t: B_INT },
    { kind: 'door', dir: 'v', x: 2.8, y: 2.62, len: 0.85, t: B_INT, hinge: 'start', swing: 'front' },
    { kind: 'door', dir: 'v', x: 2.8, y: 3.72, len: 0.85, t: B_INT, hinge: 'end', swing: 'front' },
    { kind: 'door', dir: 'h', x: 1.85, y: 4.3, len: 0.75, t: B_INT, hinge: 'end', swing: 'front' },

    { kind: 'window', dir: 'h', x: 0.8, y: 0.11, len: 1.2, t: B_EXT },
    { kind: 'window', dir: 'h', x: 3.6, y: 0.11, len: 1.6, t: B_EXT },
    { kind: 'window', dir: 'h', x: 5.8, y: 0.11, len: 1.5, t: B_EXT },
    { kind: 'window', dir: 'v', x: 7.89, y: 1.1, len: 1.4, t: B_EXT },
    { kind: 'window', dir: 'v', x: 7.89, y: 4.4, len: 1.3, t: B_EXT },
    { kind: 'window', dir: 'h', x: 4.4, y: 6.29, len: 1.6, t: B_EXT },
    { kind: 'window', dir: 'h', x: 0.9, y: 6.29, len: 0.7, t: B_EXT },
  ],
  fixtures: [
    { kind: 'counter', x: 0.3, y: 0.3, w: 2.35, h: 0.6, sinks: [[1.0, 0.6]], hobs: [[2.1, 0.6]] },
    { kind: 'wardrobe', x: 0.3, y: 1.6, w: 0.62, h: 0.75 },
    { kind: 'counter', x: 1.4, y: 1.75, w: 1.25, h: 0.6 },

    { kind: 'wardrobe', x: 2.05, y: 3.45, w: 0.62, h: 0.7 },

    { kind: 'sofa', x: 3.85, y: 2.4, w: 2.3, h: 0.88, face: 'up' },
    { kind: 'rug', x: 3.95, y: 0.95, w: 2.2, h: 1.3 },
    { kind: 'table', x: 4.55, y: 1.35, w: 0.95, h: 0.55 },
    { kind: 'counter', x: 4.35, y: 0.32, w: 1.6, h: 0.45 },
    { kind: 'sofa', x: 6.55, y: 2.4, w: 0.85, h: 0.85, face: 'left' },

    { kind: 'bed', x: 4.2, y: 3.78, w: 1.55, h: 2.0, head: 'up' },
    { kind: 'table', x: 3.72, y: 3.78, w: 0.4, h: 0.4 },
    { kind: 'table', x: 5.85, y: 3.78, w: 0.4, h: 0.4 },
    { kind: 'wardrobe', x: 6.5, y: 5.45, w: 1.15, h: 0.6 },

    { kind: 'shower', x: 0.32, y: 5.0, w: 0.95, h: 1.1 },
    { kind: 'basin', x: 1.42, y: 5.6, w: 0.62, h: 0.45 },
    { kind: 'wc', x: 2.15, y: 5.48, w: 0.42, h: 0.6 },
  ],
  notes: [
    { x: 1.25, y: 4.08, text: 'entry · all rooms off here' },
    { x: 1.95, y: 2.82, text: 'open to hall' },
  ],
  dimensions: [
    { dir: 'h', from: 0, to: 8.0, at: -0.6 },
    { dir: 'v', from: 0, to: 6.4, at: -0.6 },
    { dir: 'h', from: 0, to: 2.8, at: 6.68 },
    { dir: 'h', from: 2.8, to: 8.0, at: 6.68 },
  ],
};

/* -------------------------------------------------------------------------- */
/* scene 3 - foundry-loft: one open volume, two service boxes                */
/* -------------------------------------------------------------------------- */

const L_EXT = 0.4;
const L_INT = 0.14;

const foundryLoft = {
  id: 'foundry-loft',
  name: 'Foundry Loft',
  subtitle: 'Warehouse conversion · one open volume · services in a corner block',
  ceiling: 4.1,
  size: [14.4, 9.8],
  walls: [
    { x: 0, y: 0, w: 14.4, h: L_EXT },
    { x: 0, y: 9.8 - L_EXT, w: 14.4, h: L_EXT },
    { x: 0, y: 0, w: L_EXT, h: 9.8 },
    { x: 14.4 - L_EXT, y: 0, w: L_EXT, h: 9.8 },
    hWall(9.33, 14.0, 6.13, L_INT),
    vWall(9.4, 6.13, 9.4, L_INT),
    vWall(11.9, 6.2, 9.4, L_INT),
  ],
  // The sleeping platform is a level change, not a room: a balustrade encloses
  // it and a 1.2 m gap in that balustrade is the top of the stair.
  lowWalls: [
    { x: 8.4, y: 3.54, w: 2.1, h: 0.12 },
    { x: 11.7, y: 3.54, w: 2.3, h: 0.12 },
    { x: 8.34, y: 0.4, w: 0.12, h: 2.2 },
  ],
  zones: [
    { x: 0.4, y: 0.4, w: 3.8, h: 3.2 },
    { x: 4.2, y: 0.4, w: 4.2, h: 3.2 },
    { x: 0.4, y: 3.6, w: 5.2, h: 5.8 },
    { x: 5.6, y: 3.6, w: 3.73, h: 5.8 },
  ],
  rooms: [
    { name: 'Kitchen', x: 0.4, y: 0.4, w: 3.8, h: 3.2, labelAt: [2.3, 1.35] },
    { name: 'Dining', x: 4.2, y: 0.4, w: 4.2, h: 3.2, labelAt: [6.3, 0.78] },
    { name: 'Living room', x: 0.4, y: 3.6, w: 5.2, h: 5.8, labelAt: [2.7, 4.35] },
    { name: 'Studio', x: 5.6, y: 3.6, w: 3.73, h: 5.8, labelAt: [7.45, 6.7] },
    { name: 'Sleeping platform', x: 8.46, y: 0.4, w: 5.54, h: 3.14, labelAt: [11.23, 3.05] },
    { name: 'Hall and stair', x: 9.4, y: 3.66, w: 4.6, h: 2.4, labelAt: [12.4, 4.7], small: true, noArea: true },
    { name: 'Shower room', x: 9.47, y: 6.2, w: 2.36, h: 3.2, labelAt: [10.68, 7.82], small: true },
    { name: 'Utility', x: 11.97, y: 6.27, w: 2.03, h: 3.13, labelAt: [12.98, 7.02], small: true },
  ],
  openings: [
    { kind: 'door', dir: 'v', x: 0.2, y: 4.6, len: 1.2, t: L_EXT, hinge: 'start', swing: 'front' },
    { kind: 'door', dir: 'h', x: 9.6, y: 6.13, len: 0.8, t: L_INT, hinge: 'start', swing: 'front' },
    { kind: 'door', dir: 'h', x: 12.5, y: 6.13, len: 0.7, t: L_INT, hinge: 'end', swing: 'front' },

    { kind: 'window', dir: 'h', x: 0.9, y: 0.2, len: 2.6, t: L_EXT },
    { kind: 'window', dir: 'h', x: 4.2, y: 0.2, len: 2.6, t: L_EXT },
    { kind: 'window', dir: 'h', x: 9.3, y: 0.2, len: 2.2, t: L_EXT },
    { kind: 'window', dir: 'h', x: 11.9, y: 0.2, len: 1.8, t: L_EXT },
    { kind: 'window', dir: 'v', x: 0.2, y: 1.0, len: 2.0, t: L_EXT },
    { kind: 'window', dir: 'v', x: 0.2, y: 6.4, len: 2.6, t: L_EXT },
    { kind: 'window', dir: 'h', x: 1.1, y: 9.6, len: 2.8, t: L_EXT },
    { kind: 'window', dir: 'h', x: 4.6, y: 9.6, len: 2.2, t: L_EXT },
    { kind: 'window', dir: 'h', x: 9.9, y: 9.6, len: 1.3, t: L_EXT },
    { kind: 'window', dir: 'v', x: 14.2, y: 0.9, len: 2.2, t: L_EXT },
    { kind: 'window', dir: 'v', x: 14.2, y: 4.0, len: 1.8, t: L_EXT },
    { kind: 'window', dir: 'v', x: 14.2, y: 7.0, len: 1.4, t: L_EXT },
  ],
  columns: [
    [3.6, 3.55],
    [7.0, 3.55],
    [3.6, 7.0],
    [7.0, 7.0],
  ],
  fixtures: [
    { kind: 'counter', x: 0.5, y: 0.5, w: 3.6, h: 0.65, sinks: [[1.3, 0.82]], hobs: [[2.8, 0.82]] },
    { kind: 'counter', x: 0.9, y: 2.3, w: 2.6, h: 0.9 },

    { kind: 'table', x: 5.2, y: 1.75, w: 2.6, h: 1.0 },
    { kind: 'table', x: 5.4, y: 1.2, w: 0.45, h: 0.45 },
    { kind: 'table', x: 6.28, y: 1.2, w: 0.45, h: 0.45 },
    { kind: 'table', x: 7.16, y: 1.2, w: 0.45, h: 0.45 },
    { kind: 'table', x: 5.4, y: 2.85, w: 0.45, h: 0.45 },
    { kind: 'table', x: 6.28, y: 2.85, w: 0.45, h: 0.45 },
    { kind: 'table', x: 7.16, y: 2.85, w: 0.45, h: 0.45 },

    { kind: 'bed', x: 10.8, y: 0.6, w: 1.8, h: 2.1, head: 'up' },
    { kind: 'table', x: 10.25, y: 0.6, w: 0.45, h: 0.45 },
    { kind: 'table', x: 12.7, y: 0.6, w: 0.45, h: 0.45 },
    { kind: 'wardrobe', x: 8.6, y: 0.6, w: 0.7, h: 2.2 },
    { kind: 'stair', x: 9.7, y: 3.75, w: 1.3, h: 2.1, dir: 'v', treads: 9 },

    { kind: 'sofa', x: 1.0, y: 7.9, w: 3.2, h: 1.0, face: 'up' },
    { kind: 'rug', x: 1.1, y: 5.6, w: 3.2, h: 2.1 },
    { kind: 'table', x: 2.1, y: 6.3, w: 1.2, h: 0.65 },
    { kind: 'sofa', x: 4.4, y: 5.8, w: 0.9, h: 0.9, face: 'left' },
    { kind: 'sofa', x: 4.4, y: 7.05, w: 0.9, h: 0.9, face: 'left' },
    { kind: 'counter', x: 1.7, y: 5.0, w: 1.9, h: 0.5 },

    { kind: 'table', x: 6.1, y: 4.2, w: 2.6, h: 0.9 },
    { kind: 'wardrobe', x: 8.6, y: 6.6, w: 0.6, h: 2.4 },
    { kind: 'counter', x: 6.1, y: 8.3, w: 1.6, h: 0.8 },

    { kind: 'shower', x: 10.55, y: 6.35, w: 1.2, h: 1.2 },
    { kind: 'wc', x: 9.62, y: 8.15, w: 0.45, h: 0.65 },
    { kind: 'basin', x: 10.9, y: 8.45, w: 0.72, h: 0.5 },

    { kind: 'counter', x: 12.1, y: 8.45, w: 1.75, h: 0.65 },
    { kind: 'table', x: 12.1, y: 7.45, w: 0.6, h: 0.6 },
    { kind: 'table', x: 12.85, y: 7.45, w: 0.6, h: 0.6 },
  ],
  notes: [
    { x: 11.23, y: 3.4, text: 'five steps up · balustrade to open volume' },
    { x: 11.66, y: 5.95, text: 'services block' },
    { x: 7.45, y: 5.75, text: 'zones dashed — one volume, no partitions' },
    { x: 2.9, y: 9.3, text: 'cast-iron columns on a 3.4 m grid' },
  ],
  dimensions: [
    { dir: 'h', from: 0, to: 14.4, at: -0.6 },
    { dir: 'v', from: 0, to: 9.8, at: -0.6 },
    { dir: 'h', from: 0, to: 9.33, at: 10.08 },
    { dir: 'h', from: 9.33, to: 14.4, at: 10.08 },
  ],
};

export const PLANS = { 'maple-street': mapleStreet, 'birch-row': birchRow, 'foundry-loft': foundryLoft };

/* -------------------------------------------------------------------------- */

const wanted = process.argv.slice(2);
const ids = wanted.length ? wanted : Object.keys(PLANS);

for (const id of ids) {
  const plan = PLANS[id];
  if (!plan) {
    console.error(`unknown scene "${id}" — try ${Object.keys(PLANS).join(', ')}`);
    process.exitCode = 1;
    continue;
  }

  const dir = join(ROOT, 'samples', id);
  mkdirSync(dir, { recursive: true });

  const svg = planToSvg(plan);
  const svgPath = join(dir, 'blueprint.svg');
  writeFileSync(svgPath, svg);

  const { width, height } = svgSize(svg);
  const pngPath = join(dir, 'blueprint.png');
  const tool = rasterise(svgPath, pngPath, { width, height, scale: 2 });

  const area = plan.rooms.reduce((sum, r) => sum + (r.area ?? r.w * r.h), 0);
  console.log(
    `${id.padEnd(14)} ${plan.rooms.length} rooms  ${area.toFixed(0)} m²  ` +
      `${width}x${height} svg  ${tool ? `png via ${tool}` : 'PNG SKIPPED (no rasteriser found)'}`,
  );
}
