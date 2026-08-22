/**
 * Marble pipeline entry point: intake-composer -> environment-builder.
 *
 *   npx tsx --env-file=.env.local scripts/marble-generate.ts --help
 *
 * Deliberately a shim. tsconfig excludes scripts/ from `tsc --noEmit`, so the
 * implementation lives in lib/marble/cli.ts where it is typechecked.
 */
import { runCli } from '@/lib/marble/cli';

process.exitCode = await runCli(process.argv.slice(2));
