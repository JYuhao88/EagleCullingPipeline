import assert from "node:assert/strict";
import test from "node:test";
import {compareUnits,comparePair} from "../src/plugin/compare-review.js";

test("comparison collapses verified pairs, prefers viewable renditions and never merges uncertain names",()=>{
  const records=[
    {id:"raw-a",ext:"ARW",captureStatus:"paired",captureItemIds:["raw-a","jpg-a"],thumbnailURL:"raw-thumb"},
    {id:"jpg-a",ext:"JPG",captureStatus:"paired",captureItemIds:["jpg-a","raw-a"],thumbnailURL:"jpg-thumb"},
    {id:"raw-b",ext:"3FR",captureStatus:"paired",captureItemIds:["raw-b","heic-b"],thumbnailURL:"3fr-thumb"},
    {id:"heic-b",ext:"HEIC",captureStatus:"paired",captureItemIds:["heic-b","raw-b"],thumbnailURL:"heic-thumb"},
    {id:"uncertain-a",name:"same",ext:"JPG",captureStatus:"uncertain",captureItemIds:["uncertain-a","uncertain-b"]},
    {id:"uncertain-b",name:"same",ext:"ARW",captureStatus:"uncertain",captureItemIds:["uncertain-a","uncertain-b"]},
  ];
  const unchanged=JSON.stringify(records);
  const units=compareUnits(records);
  assert.equal(units.length,4);
  assert.deepEqual(units.map(unit=>unit.record.id),["jpg-a","heic-b","uncertain-a","uncertain-b"]);
  const pair=comparePair(units);
  assert.equal(pair.left,units[0]);assert.equal(pair.right,units[1]);
  assert.equal(comparePair(units,{leftId:units[1].id,rightId:units[1].id}).right,units[0]);
  assert.equal(comparePair(units,{leftId:"missing"}).left,units[0]);
  assert.equal(comparePair([units[0]]).right,undefined);
  assert.equal(JSON.stringify(records),unchanged);
  assert.equal(compareUnits([{...records[0]},{...records[1],thumbnailURL:null}])[0].record.id,"raw-a","use an available RAW thumbnail rather than a missing JPG thumbnail; never decode the RAW");
});
