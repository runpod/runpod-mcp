import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  mapPodCreateToV2,
  mapPodUpdateToV2,
  mapNetworkVolumeCreateToV2,
  mapTemplateCreateToV2,
} from '../src/_shared/mappers.js';

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

  it('cloudType → cloud; dataCenterIds[] → dataCenter (array→scalar)', () => {
    const out = mapPodCreateToV2({
      cloudType: 'COMMUNITY',
      dataCenterIds: ['DC1', 'DC2'],
    });
    assert.equal(out.cloud, 'COMMUNITY');
    assert.equal(out.dataCenter, 'DC1');
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
});
