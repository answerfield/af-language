import { join } from 'node:path';
import { exampleFiles as exampleFilesIn, workspace as workspaceIn } from '../src/testing.js';

/** Own sample items of this package (public). */
export const FIXTURES = join(__dirname, 'fixtures');

/** See `src/testing.ts`; `dir` and `root` default to this package's fixtures. */
export const exampleFiles = (dir = FIXTURES, withImports = true) => exampleFilesIn(dir, withImports);
export const workspace = (extra: Record<string, string> = {}, root = FIXTURES) => workspaceIn(extra, root);
