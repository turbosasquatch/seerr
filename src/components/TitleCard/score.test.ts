import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

// Node's built-in test runner resolves TypeScript modules by their source extension.
// @ts-expect-error TypeScript source imports are supported by the test runtime.
import { formatTmdbScore } from './score.ts';

describe('formatTmdbScore', () => {
  it('returns no badge text when the score is absent', () => {
    assert.strictEqual(formatTmdbScore(), undefined);
  });

  it('returns no badge text when the score is zero', () => {
    assert.strictEqual(formatTmdbScore(0), undefined);
  });

  it('rounds a fractional TMDb score to an integer percentage', () => {
    assert.strictEqual(formatTmdbScore(7.56), '76%');
  });

  it('conditionally renders the percentage badge from the formatted score', () => {
    const titleCardSource = readFileSync(
      resolve(process.cwd(), 'src/components/TitleCard/index.tsx'),
      'utf8'
    );

    assert.match(
      titleCardSource,
      /const scorePercent = formatTmdbScore\(userScore\)/
    );
    assert.match(titleCardSource, /\{scorePercent && \(/);
    assert.match(titleCardSource, /\{scorePercent\}/);
  });
});
