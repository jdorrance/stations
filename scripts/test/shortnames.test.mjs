import assert from 'node:assert/strict';
import test from 'node:test';
import { SHORT_NAME_MAX_LENGTH } from '@stations/contracts';
import {
  deriveShortName,
  fitLabel,
  generateRegionChunk,
  uniquifyShortNames,
} from '../generate-shortnames.mjs';

test('deriveShortName strips CoCoRaHS offsets and callsigns', () => {
  assert.equal(deriveShortName('Clarksville 4 NNE'), 'Clarksville');
  assert.equal(deriveShortName('KB3HHA-13 Germantown'), 'Germantown');
  assert.equal(deriveShortName('FW3803 Chesterfield'), 'Chesterfld');
  assert.equal(deriveShortName('8631044 - Wachapreague, VA'), 'Wachapreagu');
});

test('deriveShortName keeps airport place labels under eleven chars', () => {
  assert.equal(deriveShortName('Joint Base Andrews'), 'Andrews Apt');
  assert.equal(deriveShortName('Garrett County Airport-2G4'), 'Garrett Apt');
  assert.equal(deriveShortName('College Park Airport'), 'Coll Park');
  assert.equal(deriveShortName('Bumpass/Lake Anna'), 'Lake Anna');
  assert.ok(deriveShortName('Cambridge-Dorchester Regional Airport (CGE)').length <= SHORT_NAME_MAX_LENGTH);
});

test('deriveShortName prefers landmarks and Assateague', () => {
  assert.equal(deriveShortName('MD-24 at Rocks State Park'), 'Rocks SP');
  assert.equal(deriveShortName('US 1 at Conowingo Dam'), 'Conowingo');
  assert.equal(deriveShortName('ASSATEAGUE ISLAND'), 'Assateague');
  assert.equal(deriveShortName('CATOCTIN MOUNTAIN'), 'Catoctin');
  assert.equal(deriveShortName('Upper Marlboro 3 NNW'), 'U Marlboro');
  assert.equal(deriveShortName('Princess Anne 2 S'), 'Pr Anne');
});

test('deriveShortName handles RWIS offsets and CDOT codes', () => {
  assert.equal(deriveShortName('3 WNW WOFFORD HEIGHTS'), 'Wofford Hts');
  assert.equal(deriveShortName('070E217 US 6 LOVELAND PASS'), 'Loveland');
  assert.equal(deriveShortName('99NB at Dillard Road'), 'Dillard');
  assert.equal(deriveShortName('0.6 mi E of CO-91 Copper Mtn'), 'Copper Mtn');
  assert.equal(deriveShortName('1.3 mi W of Frisco'), 'Frisco');
  assert.equal(deriveShortName('0.2 mi N of I-225'), 'I-225');
  assert.equal(deriveShortName('I-94 @ I-65'), 'I-94/I-65');
  assert.equal(deriveShortName('CR-82'), 'CR-82');
  assert.equal(deriveShortName('Alaska Highway @ Dot Lake MP 1360.4'), 'Dot Lake');
  assert.equal(deriveShortName('Albany Intl, NY, US'), 'Albany Apt');
});

test('fitLabel never exceeds SHORT_NAME_MAX_LENGTH', () => {
  const long = fitLabel('Anheuser Busch Coastal Research Center Near Cape Charles');
  assert.ok(long.length <= SHORT_NAME_MAX_LENGTH);
  assert.ok(long.length >= 1);
});

test('region chunks uniquify collisions deterministically', () => {
  const chunk = generateRegionChunk([
    {
      uid: 'synoptic:a',
      vendor: 'synoptic',
      nativeId: 'a',
      name: 'Baltimore 3 NNE',
      region: 'MD',
    },
    {
      uid: 'synoptic:b',
      vendor: 'synoptic',
      nativeId: 'b',
      name: 'Baltimore 1 S',
      region: 'MD',
    },
  ]);
  const unique = uniquifyShortNames(chunk);
  assert.equal(unique[0].shortName, 'Baltimore');
  assert.equal(unique[1].shortName, 'Baltimore2');
  assert.ok(unique.every((row) => row.shortName.length <= SHORT_NAME_MAX_LENGTH));
});
