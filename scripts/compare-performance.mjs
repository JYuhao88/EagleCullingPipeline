import {readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
const labels=process.argv.slice(2);
if(labels.length<2 || labels.some(label=>!/^[a-z0-9-]+$/.test(label)))throw new Error('Pass two or more completed local cold-run labels');
const root='data/cache/w23-threads/e2e';
const reports=await Promise.all(labels.map(label=>readFile(path.join(root,label,'result.json'),'utf8').then(JSON.parse)));
const differences=[];
function compare(a,b,field,label){
  if(JSON.stringify(a)===JSON.stringify(b))return;
  if(a && b && typeof a==='object' && typeof b==='object'){
    for(const key of new Set([...Object.keys(a),...Object.keys(b)]))compare(a[key],b[key],`${field}.${key}`,label);
  }else differences.push({label,field,baseline:a??null,actual:b??null});
}
for(let i=1;i<reports.length;i++){
  compare(reports[0].inputSha256,reports[i].inputSha256,'inputSha256',labels[i]);
  compare(reports[0].units,reports[i].units,'units',labels[i]);
  compare(reports[0].groups,reports[i].groups,'groups',labels[i]);
}
const output={labels,units:reports[0].units.length,groups:reports[0].groups.length,
  identical:differences.length===0,differences};
await writeFile(path.join(root,'comparison.json'),JSON.stringify(output,null,2));
console.log(JSON.stringify(output));if(differences.length)process.exitCode=1;
