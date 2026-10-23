import {assert} from './util.mjs';

export function directoryKey(value) {return String(value||'').replace(/\\/g,'/').replace(/\/+$/,'').toLowerCase();}
export function directoryFilter(value) {
  if(value===null||value===undefined||value==='')return null;
  assert(typeof value==='string'&&value.length<=2000&&!/[\x00-\x1f]/.test(value)&&/^(?:[a-z]:[\\/]|\/|\\\\)/i.test(value)&&!value.split(/[\\/]/).includes('..'),'Invalid project directory');
  return directoryKey(value);
}
export const sqlDirectory=expression=>`lower(rtrim(replace(${expression},char(92),'/'),'/'))`;
