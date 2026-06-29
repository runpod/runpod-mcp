import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  mapPodCreateToV2,
  mapPodUpdateToV2,
  mapNetworkVolumeCreateToV2,
  mapTemplateCreateToV2,
  mapTemplateUpdateToV2,
  mapEndpointCreateToV2,
  mapEndpointUpdateToV2,
} from '../src/_shared/mappers.js';
import { parsePodLogSse } from '../src/tools/pods.js';

const fixture = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('./fixtures/v2-create-pod.json', import.meta.url)),
    'utf8'
  )
) as { v1Input: Record<string, unknown>; v2Expected: Record<string, unknown> };

describe('mapPodCreateToV2', () => {
  it('matches the committed fixture (full v1 → v2 body)', () => {
    assert.deepEqual(mapPodCreateToV2(fixture.v1Input), fixture.v2Expected);
  });

  it('imageName → image; containerDiskInGb → disk', () => {
    const out = mapPodCreateToV2({ imageName: 'i', containerDiskInGb: 10 });
    assert.equal(out.image, 'i');
    assert.equal(out.disk, 10);
    assert.equal('imageName' in out, false);
    assert.equal('containerDiskInGb' in out, false);
  });

  it('volumeInGb/volumeMountPath → mounts.persistent.{size,path} (both required)', () => {
    const out = mapPodCreateToV2({ volumeInGb: 30, volumeMountPath: '/data' });
    assert.deepEqual(out.mounts, { persistent: { size: 30, path: '/data' } });
  });

  it('partial volume (size-only OR path-only) → NO mounts (v2 rejects a partial persistent)', () => {
    assert.equal('mounts' in mapPodCreateToV2({ volumeInGb: 30 }), false);
    assert.equal(
      'mounts' in mapPodCreateToV2({ volumeMountPath: '/data' }),
      false
    );
  });

  it('gpuTypeIds[] → gpu.id (array→scalar) + gpuCount → gpu.count', () => {
    const out = mapPodCreateToV2({ gpuTypeIds: ['A', 'B'], gpuCount: 4 });
    assert.deepEqual(out.gpu, { id: 'A', count: 4 });
  });

  it('gpuCount without gpuTypeIds → NO gpu (v2 GpuConfig requires id)', () => {
    assert.equal('gpu' in mapPodCreateToV2({ gpuCount: 4 }), false);
  });

  it('empty gpuTypeIds [] → NO gpu', () => {
    assert.equal('gpu' in mapPodCreateToV2({ gpuTypeIds: [] }), false);
    assert.equal(
      'gpu' in mapPodCreateToV2({ gpuTypeIds: [], gpuCount: 2 }),
      false
    );
  });

  it('gpuTypeIds without gpuCount → gpu.id only (count optional, defaults 1 upstream)', () => {
    assert.deepEqual(mapPodCreateToV2({ gpuTypeIds: ['A'] }).gpu, { id: 'A' });
  });

  it('cloudType → cloud; dataCenterIds[] passes through as an array (v2 field)', () => {
    const out = mapPodCreateToV2({
      cloudType: 'COMMUNITY',
      dataCenterIds: ['DC1', 'DC2'],
    });
    assert.equal(out.cloud, 'COMMUNITY');
    // v2 CreatePodRequest uses `dataCenterIds` (array), not a singular
    // `dataCenter` — the whole list must survive, not just the first.
    assert.deepEqual(out.dataCenterIds, ['DC1', 'DC2']);
    assert.equal('dataCenter' in out, false);
  });

  it('empty dataCenterIds is dropped (scheduler chooses)', () => {
    const out = mapPodCreateToV2({ dataCenterIds: [] });
    assert.equal('dataCenterIds' in out, false);
  });

  it('no gpu key when no gpuTypeIds given (translation only — gpu/cpu requirement is enforced by the tool/handler)', () => {
    const out = mapPodCreateToV2({ name: 'no-gpu' });
    assert.equal('gpu' in out, false);
  });

  it('drops unknown keys and undefined values', () => {
    const out = mapPodCreateToV2({
      name: 'p',
      // @ts-expect-error unknown v1 field
      bogus: 'x',
      imageName: undefined,
    });
    assert.equal('bogus' in out, false);
    assert.equal('image' in out, false);
    assert.deepEqual(out, { name: 'p' });
  });
});

describe('mapPodUpdateToV2', () => {
  it('flattens ContainerConfig, no gpu/cloud/dataCenter', () => {
    const out = mapPodUpdateToV2({
      name: 'n',
      imageName: 'i',
      volumeInGb: 5,
      volumeMountPath: '/x',
    });
    assert.deepEqual(out, {
      image: 'i',
      mounts: { persistent: { size: 5, path: '/x' } },
      name: 'n',
    });
  });

  it('ignores gpu/cloud/dataCenter even when supplied (positive drop proof)', () => {
    const out = mapPodUpdateToV2({
      name: 'n',
      gpuTypeIds: ['A'],
      gpuCount: 8,
      cloudType: 'SECURE',
      dataCenterIds: ['DC1'],
    });
    assert.deepEqual(out, { name: 'n' });
  });
});

describe('mapNetworkVolumeCreateToV2', () => {
  it('dataCenterId → dataCenter', () => {
    const out = mapNetworkVolumeCreateToV2({
      name: 'v',
      size: 50,
      dataCenterId: 'EU-RO-1',
    });
    assert.deepEqual(out, { name: 'v', size: 50, dataCenter: 'EU-RO-1' });
  });
});

describe('mapTemplateCreateToV2', () => {
  it('imageName→image, isServerless→serverless, flatten, category defaults to NVIDIA', () => {
    const out = mapTemplateCreateToV2({
      name: 't',
      imageName: 'i',
      isServerless: true,
      containerDiskInGb: 10,
    });
    assert.deepEqual(out, {
      image: 'i',
      disk: 10,
      name: 't',
      serverless: true,
      category: 'NVIDIA',
    });
  });

  it('keeps ports/env and flattens a full volume → mounts.persistent', () => {
    const out = mapTemplateCreateToV2({
      name: 't',
      imageName: 'i',
      ports: ['8888/http'],
      env: { K: 'V' },
      volumeInGb: 20,
      volumeMountPath: '/data',
    });
    assert.deepEqual(out.ports, ['8888/http']);
    assert.deepEqual(out.env, { K: 'V' });
    assert.deepEqual(out.mounts, { persistent: { size: 20, path: '/data' } });
  });

  it('accepts an explicit category override', () => {
    const out = mapTemplateCreateToV2({ name: 't', category: 'CPU' });
    assert.equal(out.category, 'CPU');
  });

  it('maps containerRegistryAuthId → registry (private-image pull)', () => {
    const out = mapTemplateCreateToV2({
      name: 't',
      containerRegistryAuthId: 'cra_1',
    });
    assert.equal(out.registry, 'cra_1');
    assert.equal('containerRegistryAuthId' in out, false);
  });
});

describe('mapTemplateUpdateToV2', () => {
  it('maps imageName→image (not identity), keeps name, no category forced', () => {
    const out = mapTemplateUpdateToV2({ name: 'n', imageName: 'i' });
    assert.deepEqual(out, { image: 'i', name: 'n' });
    assert.equal('imageName' in out, false);
    assert.equal('category' in out, false);
  });

  it('maps containerRegistryAuthId → registry on update too', () => {
    const out = mapTemplateUpdateToV2({ containerRegistryAuthId: 'cra_2' });
    assert.equal(out.registry, 'cra_2');
    assert.equal('containerRegistryAuthId' in out, false);
  });
});

describe('mapEndpointCreateToV2', () => {
  it('builds the nested v2 /serverless body (gpu.pools/workers/scaling)', () => {
    const out = mapEndpointCreateToV2({
      name: 'e',
      imageName: 'img:2',
      args: '--port 8000',
      gpuPoolIds: ['AMPERE_80'],
      gpuCount: 1,
      workersMin: 0,
      workersMax: 3,
      scalerType: 'QUEUE_DELAY',
      scalerValue: 4,
      idleTimeout: 5,
      containerDiskInGb: 20,
      ports: ['8000/http'],
      env: { K: 'V' },
      containerRegistryAuthId: 'cra_1',
      networkVolumeIds: ['nv_1'],
      executionTimeoutMs: 600000,
      flashboot: 'FLASHBOOT',
    });
    assert.deepEqual(out, {
      name: 'e',
      image: 'img:2',
      args: '--port 8000',
      disk: 20,
      ports: ['8000/http'],
      env: { K: 'V' },
      registry: 'cra_1',
      gpu: { pools: ['AMPERE_80'], count: 1 },
      workers: { min: 0, max: 3 },
      scaling: { type: 'QUEUE_DELAY', value: 4, idleTimeout: 5 },
      networkVolumes: ['nv_1'],
      timeout: 600000,
      flashboot: 'FLASHBOOT',
    });
  });

  it('imageName→image, containerRegistryAuthId→registry, networkVolumeIds→networkVolumes', () => {
    const out = mapEndpointCreateToV2({
      imageName: 'i',
      containerRegistryAuthId: 'c',
      networkVolumeIds: ['v'],
    });
    assert.equal(out.image, 'i');
    assert.equal('imageName' in out, false);
    assert.equal(out.registry, 'c');
    assert.deepEqual(out.networkVolumes, ['v']);
    assert.equal('networkVolumeIds' in out, false);
  });

  it('never emits a pod-style mounts field', () => {
    const out = mapEndpointCreateToV2({ imageName: 'i', gpuPoolIds: ['P'] });
    assert.equal('mounts' in out, false);
  });

  it('drops empty gpu pools (no idless gpu object)', () => {
    const out = mapEndpointCreateToV2({ imageName: 'i', gpuCount: 2 });
    assert.equal('gpu' in out, false);
  });

  it('drops empty workers/scaling objects', () => {
    const out = mapEndpointCreateToV2({ imageName: 'i' });
    assert.equal('workers' in out, false);
    assert.equal('scaling' in out, false);
  });

  it('emits workers.min:0 (a meaningful scale-to-zero, not dropped)', () => {
    const out = mapEndpointCreateToV2({ imageName: 'i', workersMin: 0 });
    assert.deepEqual(out.workers, { min: 0 });
  });
});

describe('mapEndpointUpdateToV2', () => {
  it('is the same shape as create (every field optional)', () => {
    const out = mapEndpointUpdateToV2({ workersMax: 5, imageName: 'img:3' });
    assert.deepEqual(out, { workers: { max: 5 }, image: 'img:3' });
  });
});

describe('parsePodLogSse', () => {
  it('parses data: JSON frames separated by blank lines', () => {
    const raw = [
      'data: {"source":"container","line":"a","ts":"t1"}',
      '',
      'data: {"source":"system","line":"b","ts":"t2"}',
      '',
    ].join('\n');
    const items = parsePodLogSse(raw);
    assert.equal(items.length, 2);
    assert.deepEqual(items[0], { source: 'container', line: 'a', ts: 't1' });
    assert.equal(items[1].line, 'b');
  });

  it('handles CRLF line endings', () => {
    const raw = 'data: {"line":"x"}\r\n\r\ndata: {"line":"y"}\r\n\r\n';
    const items = parsePodLogSse(raw);
    assert.deepEqual(
      items.map((i) => i.line),
      ['x', 'y']
    );
  });

  it('ignores comment lines and non-data fields', () => {
    const raw = ': keepalive\n\nevent: ping\nid: 5\n\ndata: {"line":"z"}\n\n';
    const items = parsePodLogSse(raw);
    assert.equal(items.length, 1);
    assert.equal(items[0].line, 'z');
  });

  it('keeps non-JSON payloads verbatim under raw (never drops a line)', () => {
    const items = parsePodLogSse('data: plain text line\n\n');
    assert.deepEqual(items, [{ raw: 'plain text line' }]);
  });

  it('empty stream → no items', () => {
    assert.deepEqual(parsePodLogSse(''), []);
  });
});
