import yaml from 'js-yaml';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

const expectedParameters = [
  'page',
  'url',
  'sortBy',
  'primaryReleaseDateGte',
  'primaryReleaseDateLte',
  'firstAirDateGte',
  'firstAirDateLte',
  'studio',
  'network',
  'genre',
  'keywords',
  'excludeKeywords',
  'language',
  'withRuntimeGte',
  'withRuntimeLte',
  'voteAverageGte',
  'voteAverageLte',
  'voteCountGte',
  'voteCountLte',
];

describe('MDBList discovery OpenAPI contract', () => {
  it('declares every supported query parameter', async () => {
    const spec = yaml.load(
      await readFile(resolve(process.cwd(), 'seerr-api.yml'), 'utf8')
    ) as {
      paths: Record<string, { get: { parameters: { name: string }[] } }>;
    };

    const parameters = spec.paths['/discover/mdblist'].get.parameters.map(
      ({ name }) => name
    );

    assert.deepStrictEqual(parameters.sort(), expectedParameters.sort());
  });
});
