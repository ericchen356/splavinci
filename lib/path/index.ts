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
  passableConnectivity, cachedConnectivity, resolveCameraRadius, reachableMask,
  /* the flying camera: the 3D counterparts of isPassable/hasLineOfSight */
  isFreeAt, freeRadiusAt, hasFlightPath, marchView,
  type WalkGrid, type GridOptions,
} from './grid';

export { getWalkGrid } from './gridCache';

export {
  findPath, simplifyPath, DEFAULT_ASTAR,
  type Cell, type AStarOptions, type AStarResult, type AStarFailure,
} from './astar';

export {
  buildCurve, cellsToWorldPoints, countViolations,
  easeInOut, easeInOutCubic, sampleCurveEased, segmentEase, hermiteRate,
  DEFAULT_CURVE, DEFAULT_CAMERA_HEIGHT,
  type BuiltCurve, type CurveOptions, type HeightProfile,
} from './curve';

export {
  resolveShot, inferShotType, inferDuration, readWall, readView, roomShape,
  STYLE_PRESETS, VIEW_OPENNESS_CROSSOVER, VIEW_REACH_FRACTION,
  ELEVATED_HEIGHT_FACTOR, ELEVATED_PITCH,
  DEFAULT_PAN_SWEEP, DEFAULT_ORBIT_SWEEP,
  type ShotIntent, type RoomShape, type StylePreset,
  type WallReading, type ViewReading,
} from './shots';

export { sampleShot, sampleShotEased, type ShotContext, type CameraSample } from './motion';

export {
  generatePath, createPathCache, DEFAULT_GENERATE,
  type PathInput, type PathCache, type GenerateOptions,
} from './generate';

export {
  EMPTY_PATH, frameAtTime, frameIndexAtTime, sampleAtTime, segmentAtTime,
  type PathResult, type PathSegmentInfo, type PathStats,
  type PathWarning, type PathWarningCode,
} from './result';
