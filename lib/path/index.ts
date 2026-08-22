/**
 * Public surface of the path generator.
 *
 *   import { generatePath, createPathCache, type PathResult } from '@/lib/path';
 *
 * Pure TypeScript + three maths, no React and no WebGL: it runs in a component,
 * in a worker, or in a script (see scripts/path-lab.ts).
 */

export {
  buildWalkGrid, deriveCellSize, gridStats,
  cellIndex, cellToWorld, worldToCell, inGrid,
  isWalkable, isPassable, findNearestCell, floorYAtCell, hasLineOfSight, denseBounds,
  type WalkGrid, type GridOptions,
} from './grid';

export { getWalkGrid } from './gridCache';

export {
  findPath, simplifyPath, DEFAULT_ASTAR,
  type Cell, type AStarOptions, type AStarResult, type AStarFailure,
} from './astar';

export {
  buildCurve, cellsToWorldPoints, densify, countViolations,
  easeInOut, easeInOutCubic, sampleCurveEased, DEFAULT_CURVE,
  type BuiltCurve, type CurveOptions,
} from './curve';

export {
  resolveShot, inferShotType, inferDuration, readWall, roomShape,
  STYLE_PRESETS, WALL_OPENNESS_CROSSOVER,
  type ShotIntent, type RoomShape, type StylePreset, type WallReading,
} from './shots';

export { sampleShot, sampleShotEased, type ShotContext, type CameraSample } from './motion';

export {
  generatePath, createPathCache, DEFAULT_GENERATE,
  type PathInput, type PathCache, type GenerateOptions,
} from './generate';

export {
  EMPTY_PATH, frameAtTime, sampleAtTime, segmentAtTime,
  type PathResult, type PathSegmentInfo, type PathStats,
  type PathWarning, type PathWarningCode,
} from './result';
